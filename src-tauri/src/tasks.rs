// Complex tasks started from the island.
//
// A task is a *dedicated* OpenCode session in a folder the user picked, driven
// with `POST /session/:id/prompt_async` rather than the blocking `/message` the
// chat uses. Nothing here waits for the model: the prompt is fired and dropped,
// and everything after that arrives on the SSE stream we already hold open in
// opencode.rs. That is what lets several tasks run at once.
//
// Directory handling, verified against the live 1.18.34 server: `directory` is
// NOT a body field. The body schema is `{parentID, title, agent, model,
// metadata, permission, workspaceID}` and anything extra is silently ignored.
// The working folder travels as `?directory=` (the server's first choice) or
// `x-opencode-directory`, and every later call on that session has to repeat it
// or the server falls back to its own CWD.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::{RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::log;
use crate::opencode::{authed, conn, field, http};

/// How many folders the picker remembers.
pub const RECENT_LIMIT: usize = 5;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── wire types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Todo {
    pub content: String,
    pub status: String,
    pub priority: String,
}

impl Todo {
    /// `status` is a plain string from the server, so it can be anything. Anything
    /// that is not `completed` or `cancelled` counts as still open — a typo has
    /// to read as work left to do, not as work finished.
    pub fn finished(&self) -> bool {
        self.status == "completed" || self.status == "cancelled"
    }

    pub fn from_value(v: &Value) -> Option<Self> {
        Some(Self {
            content: field(v, "content").to_string(),
            status: field(v, "status").to_string(),
            priority: field(v, "priority").to_string(),
        })
    }
}

/// `done` travels with the todo rather than being recomputed in the webview, so
/// there is exactly one definition of "finished" and it is the one under test.
impl Serialize for Todo {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            content: &'a str,
            status: &'a str,
            priority: &'a str,
            done: bool,
        }
        Wire {
            content: &self.content,
            status: &self.status,
            priority: &self.priority,
            done: self.finished(),
        }
        .serialize(s)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub session: String,
    pub directory: String,
    pub title: String,
    pub agent: Option<String>,
    /// "running" | "finished" | "error" | "aborted"
    pub state: String,
    pub started_ms: u64,
    pub ended_ms: Option<u64>,
    /// Current step as "tool · target", the same shape the ticker shows.
    pub step: Option<String>,
    pub todos: Vec<Todo>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub name: String,
    pub description: String,
    /// "primary" | "subagent" | "all". Only a primary one can answer a chat turn.
    pub mode: String,
    /// True when OpenCode runs this agent itself and did not offer it as a choice.
    /// `/agent` returns these alongside the real ones — `compaction`, `summary`
    /// and `title` are all `hidden` on 1.18.34 — so a picker that does not read
    /// this offers a person three internal workers.
    pub hidden: bool,
    /// The server sorts the default to the head of the list. See `agents`.
    pub is_default: bool,
}

// ── registry ───────────────────────────────────────────────────────────────────

pub struct Registry {
    inner: Mutex<Vec<TaskInfo>>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
        }
    }
}

impl Registry {
    fn snapshot(&self) -> Vec<TaskInfo> {
        self.inner.lock().unwrap().clone()
    }

    /// Tasks are addressable by their own id or by the OpenCode session id, so
    /// the island never has to keep both.
    fn find(&self, key: &str) -> Option<TaskInfo> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == key || t.session == key)
            .cloned()
    }

    /// Same lookup as `find`, for callers that only hold an `AppHandle`.
    pub fn lookup(&self, key: &str) -> Option<TaskInfo> {
        self.find(key)
    }

    fn knows(&self, session: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .any(|t| t.session == session)
    }

    fn set(&self, key: &str, f: impl FnOnce(&mut TaskInfo)) {
        if let Some(t) = self.inner.lock().unwrap().iter_mut().find(|t| t.id == key) {
            f(t);
        }
    }

    /// Ends the *running* task for this session. A session that already finished
    /// is left alone, so a late `session.idle` cannot overwrite an error.
    fn finish(&self, session: &str, state: &str, error: Option<String>) -> Option<TaskInfo> {
        let mut hit = None;
        if let Some(t) = self
            .inner
            .lock()
            .unwrap()
            .iter_mut()
            .find(|t| t.session == session && t.state == "running")
        {
            t.state = state.into();
            t.ended_ms = Some(now_ms());
            t.step = None;
            t.error = error;
            hit = Some(t.clone());
        }
        hit
    }
}

fn emit_all(app: &AppHandle) {
    let list = app.state::<Registry>().snapshot();
    let _ = app.emit_to(WINDOW_LABEL, "tasks", list);
}

fn emit_one(app: &AppHandle, key: &str) {
    if let Some(t) = app.state::<Registry>().find(key) {
        let _ = app.emit_to(WINDOW_LABEL, "task", t);
    }
}

/// `?directory=` on every session call. Without it the server resolves the
/// project from its own CWD and a task asked for `D:\work` would run in whatever
/// folder `opencode serve` happened to start in.
fn with_dir(rb: RequestBuilder, directory: &str) -> RequestBuilder {
    rb.query(&[("directory", directory)])
}

fn status_hint(status: StatusCode) -> String {
    match status.as_u16() {
        401 => "401 — wrong username or password".into(),
        404 => "the server doesn't know that session".into(),
        n => format!("HTTP {n}"),
    }
}

fn unreachable(e: reqwest::Error) -> String {
    // The whole chain, not `without_url()`: "error sending request" is only the top
    // of a reqwest error, and the reason it failed is underneath it. Logged verbatim
    // so the log file can answer what went wrong where the UI can only paraphrase.
    let detail = format!("{e:#}");
    crate::log::line(&format!("opencode task request failed: {detail}"));
    format!("OpenCode unreachable ({detail})")
}

// ── starting a task ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct StartRequest {
    pub directory: String,
    pub prompt: String,
    pub agent: Option<String>,
    /// What the task should do: "propose", "execute" or "both". Empty means the
    /// default, and anything unrecognised is ignored rather than refused — an older
    /// island must keep working against a newer build.
    #[serde(default)]
    pub kind: Option<String>,
}

/// The instruction a task kind adds, sent as its own message part so the title
/// the island shows stays the person's own words.
///
/// This is framing, not a permission mode. A real read-only mode would have to
/// live in OpenCode's permission layer, and Piko only ever answers that per
/// request — it cannot pre-answer on an agent's behalf.
fn kind_framing(kind: Option<&str>) -> Option<&'static str> {
    // Case-folded: the value crosses a version boundary between the island and
    // this build, and a stray capital silently dropping someone's "do not modify
    // anything" is not a failure worth debugging in a task log.
    match kind.map(|k| k.trim().to_ascii_lowercase()).as_deref() {
        Some("propose") => Some(
            "This task is read-and-report only. Read and inspect first, then report \
             what is wrong and what you would change. Do not modify anything.",
        ),
        Some("execute") => Some(
            "This task is act mode. Read and inspect what is needed, then carry the \
             task out.",
        ),
        Some("both") => Some(
            "This task is explain-then-act. Read and inspect, report what you would \
             change and why, then carry it out.",
        ),
        _ => None,
    }
}

pub async fn start(app: &AppHandle, req: StartRequest) -> Result<TaskInfo, String> {
    let dir = req.directory.trim().to_string();
    if dir.is_empty() {
        return Err("pick a project folder first".into());
    }
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("{dir} isn't a folder"));
    }
    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("the task is empty".into());
    }

    let c = conn();
    let agent = req.agent.filter(|a| !a.trim().is_empty());
    // POST /session — body carries only real fields. `title` is what the island
    // shows, so it gets the task text rather than "New session".
    let mut body = json!({ "title": title_of(&prompt) });
    if let Some(a) = agent.as_deref() {
        body["agent"] = json!(a);
    }
    let res = authed(
        &c,
        with_dir(http().post(format!("{}/session", c.url)), &dir),
    )
    .json(&body)
    .send()
    .await
    .map_err(unreachable)?;
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    let v: Value = res
        .json()
        .await
        .map_err(|_| "unexpected response".to_string())?;
    let session = field(&v, "id").to_string();
    if session.is_empty() {
        return Err("OpenCode returned no session id".into());
    }

    let info = TaskInfo {
        id: format!("tsk_{session}"),
        session,
        directory: dir,
        title: title_of(&prompt),
        agent,
        state: "running".into(),
        started_ms: now_ms(),
        ended_ms: None,
        step: None,
        todos: Vec::new(),
        error: None,
    };

    // Registered before the prompt, because a fast agent can already be streaming
    // `message.part.updated` by the time prompt_async returns.
    app.state::<Registry>()
        .inner
        .lock()
        .unwrap()
        .push(info.clone());

    if let Err(e) = prompt_async(&info, &prompt, kind_framing(req.kind.as_deref())).await {
        app.state::<Registry>()
            .finish(&info.session, "error", Some(e.clone()));
        emit_all(app);
        return Err(e);
    }

    log::line(format!("task started · {}", info.session));
    remember_folder(&info.directory);
    emit_all(app);
    Ok(info)
}

fn title_of(prompt: &str) -> String {
    let one_line = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= 80 {
        one_line
    } else {
        format!("{}…", one_line.chars().take(79).collect::<String>())
    }
}

/// prompt_async answers 204 with an empty body — everything that happens next
/// comes over the SSE stream, so there is nothing here to parse.
///
/// `framing` goes in as a second part, after the person's own words. The title on
/// the card is built from the prompt text, and a task labelled with its own
/// instructions instead of the request reads as noise.
async fn prompt_async(task: &TaskInfo, text: &str, framing: Option<&str>) -> Result<(), String> {
    let c = conn();
    let mut parts = vec![json!({ "type": "text", "text": text })];
    if let Some(f) = framing {
        parts.push(json!({ "type": "text", "text": f }));
    }
    let mut body = json!({ "parts": parts });
    if let Some(a) = task.agent.as_deref() {
        body["agent"] = json!(a);
    }
    let rb = with_dir(
        http().post(format!("{}/session/{}/prompt_async", c.url, task.session)),
        &task.directory,
    )
    .json(&body);
    let res = authed(&c, rb).send().await.map_err(unreachable)?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(status_hint(res.status()))
    }
}

/// A follow-up goes to the *same* session, which is the whole point of keeping a
/// finished task around.
pub async fn followup(app: &AppHandle, key: &str, text: &str) -> Result<(), String> {
    let task = app
        .state::<Registry>()
        .find(key)
        .ok_or("that task is no longer known to Piko")?;
    let text = text.trim();
    if text.is_empty() {
        return Err("the message is empty".into());
    }
    prompt_async(&task, text, None).await?;
    // Reopen: a follow-up puts a finished task back to work.
    app.state::<Registry>().set(&task.id, |t| {
        t.state = "running".into();
        t.ended_ms = None;
        t.error = None;
        t.step = None;
    });
    emit_one(app, &task.id);
    Ok(())
}

pub async fn abort(app: &AppHandle, key: &str) -> Result<(), String> {
    let task = app
        .state::<Registry>()
        .find(key)
        .ok_or("that task is no longer known to Piko")?;
    let c = conn();
    // No body, and idempotent — aborting twice is not an error worth refusing.
    let rb = with_dir(
        http().post(format!("{}/session/{}/abort", c.url, task.session)),
        &task.directory,
    );
    let res = authed(&c, rb).send().await.map_err(unreachable)?;
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    app.state::<Registry>()
        .finish(&task.session, "aborted", None);
    log::line(format!("task aborted · {}", task.session));
    emit_all(app);
    Ok(())
}

pub fn list(app: &AppHandle) -> Vec<TaskInfo> {
    app.state::<Registry>().snapshot()
}

/// Drops tasks that ended long ago, so the overview cannot grow without bound.
/// Running tasks are never swept.
pub fn sweep(app: &AppHandle, keep_ms: u64) {
    let cutoff = now_ms().saturating_sub(keep_ms);
    {
        // Bound the `State` to a name: the guard below borrows the mutex out of it,
        // so letting it be a temporary would drop the borrow mid-block.
        let reg = app.state::<Registry>();
        let mut inner = reg.inner.lock().unwrap();
        inner.retain(|t| t.state == "running" || t.ended_ms.is_some_and(|e| e >= cutoff));
    }
    emit_all(app);
}

// ── recent folders ─────────────────────────────────────────────────────────────

/// %APPDATA%\Piko\task-folders.json — deliberately its own file. The settings
/// window holds a whole `Settings` value in memory, so anything in there that
/// changes from the island gets rolled back the next time the settings window
/// saves. Paths — nothing else ever goes in this file.
fn recent_path() -> std::path::PathBuf {
    crate::settings::config_dir().join("task-folders.json")
}

pub fn recent_folders() -> Vec<String> {
    std::fs::read_to_string(recent_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

/// Puts `dir` at the front, dropping any earlier mention and anything past the
/// limit, then writes the list back. Best-effort: a read-only config directory
/// costs the user their shortcut list, not their task.
pub fn remember_folder(dir: &str) {
    let mut list = recent_folders();
    list.retain(|d| !d.eq_ignore_ascii_case(dir));
    list.insert(0, dir.to_string());
    list.truncate(RECENT_LIMIT);
    if let Some(parent) = recent_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&list) {
        if let Err(err) = std::fs::write(recent_path(), json) {
            log::line(format!("could not remember folder: {err}"));
        }
    }
}

// ── agents ─────────────────────────────────────────────────────────────────────

/// `GET /agent`. The server returns the default first — it sorts by
/// `default_agent`, falling back to `build` — which is why `is_default` is simply
/// the head of the list rather than a flag asked for separately.
///
/// Nothing is filtered here. `hidden` and `mode` are both reported to the island
/// verbatim, so the rule about which agents a person may pick lives in one place
/// (the chat view) instead of being split across this file and the front end, where
/// the two could disagree about what `build` is.
pub async fn agents() -> Result<Vec<AgentInfo>, String> {
    let c = conn();
    let res = authed(&c, http().get(format!("{}/agent", c.url)))
        .send()
        .await
        .map_err(unreachable)?;
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    let v: Value = res
        .json()
        .await
        .map_err(|_| "unexpected response".to_string())?;
    let Some(arr) = v.as_array() else {
        return Err("unexpected agent list".into());
    };
    Ok(arr
        .iter()
        .enumerate()
        .filter_map(|(i, a)| {
            let name = field(a, "name").to_string();
            if name.is_empty() {
                return None;
            }
            Some(AgentInfo {
                description: field(a, "description").to_string(),
                mode: field(a, "mode").to_string(),
                // Absent means false: only the internal workers set it.
                hidden: a.get("hidden").and_then(Value::as_bool).unwrap_or(false),
                is_default: i == 0,
                name,
            })
        })
        .collect())
}

// ── SSE progress, called from opencode.rs ──────────────────────────────────────

/// "tool · target", the same shape the island's ticker shows, so a task row and
/// a session row read identically. Ordered by how specific the input field is:
/// approving "Write" tells you nothing, "Write · .env" tells you everything.
pub fn step_label(tool: &str, input: Option<&Value>) -> String {
    const FIELDS: [&str; 6] = [
        "command",
        "filePath",
        "path",
        "file_path",
        "query",
        "pattern",
    ];
    let Some(input) = input else {
        return tool.to_string();
    };
    for f in FIELDS {
        if let Some(v) = input.get(f).and_then(Value::as_str) {
            let v = v.trim();
            if !v.is_empty() {
                let tail: String = v.chars().take(40).collect();
                return format!("{tool} · {tail}");
            }
        }
    }
    tool.to_string()
}

pub fn on_step(app: &AppHandle, session: &str, label: &str) {
    let reg = app.state::<Registry>();
    if !reg.knows(session) {
        return;
    }
    if let Some(t) = reg.find(session) {
        reg.set(&t.id, |task| task.step = Some(label.to_string()));
        emit_one(app, &t.id);
    }
}

/// `todo.updated` — not `session.todo.updated`, which does not exist in 1.18.34.
/// It carries the whole list every time, so there is nothing to merge.
pub fn on_todos(app: &AppHandle, session: &str, todos: Vec<Todo>) {
    let reg = app.state::<Registry>();
    if !reg.knows(session) {
        return;
    }
    let Some(t) = reg.find(session) else { return };
    reg.set(&t.id, |task| task.todos = todos);
    emit_one(app, &t.id);
}

pub fn on_finished(app: &AppHandle, session: &str, state: &str, error: Option<String>) {
    if !app.state::<Registry>().knows(session) {
        return;
    }
    if app
        .state::<Registry>()
        .finish(session, state, error)
        .is_some()
    {
        emit_all(app);
    }
}

// ── tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_todo_status_is_not_treated_as_done() {
        let typo = Todo {
            content: "x".into(),
            status: "in_progres".into(),
            priority: "high".into(),
        };
        assert!(
            !typo.finished(),
            "a typo'd status must not read as finished"
        );
        let done = Todo {
            status: "completed".into(),
            ..typo.clone()
        };
        assert!(done.finished());
        let cancelled = Todo {
            status: "cancelled".into(),
            ..typo
        };
        assert!(cancelled.finished());
    }

    #[test]
    fn title_is_one_line_and_capped() {
        assert_eq!(title_of("run   the\n tests"), "run the tests");
        let long = "x".repeat(200);
        let t = title_of(&long);
        assert_eq!(t.chars().count(), 80, "80 chars plus the ellipsis");
        assert!(t.ends_with('…'));
    }

    #[test]
    fn every_task_kind_gets_its_own_instruction() {
        let propose = kind_framing(Some("propose")).expect("propose is a kind");
        let execute = kind_framing(Some("execute")).expect("execute is a kind");
        let both = kind_framing(Some("both")).expect("both is a kind");
        assert_ne!(propose, execute);
        assert_ne!(execute, both);
        assert_ne!(propose, both);
        // "Look" promises nothing is changed, so that word has to be in it.
        assert!(propose.contains("Do not modify"), "{propose}");
        assert!(execute.contains("carry the task out"), "{execute}");
    }

    #[test]
    fn an_unknown_or_missing_kind_adds_nothing_rather_than_failing() {
        // An older island must keep working against a newer build, so an
        // unrecognised kind is ignored instead of refused.
        assert_eq!(kind_framing(None), None);
        assert_eq!(kind_framing(Some("")), None);
        assert_eq!(kind_framing(Some("nonsense")), None);
        assert_eq!(kind_framing(Some("  Both  ")), kind_framing(Some("both")));
    }
}
