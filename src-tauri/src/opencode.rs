// OpenCode client — replaces pipe.rs / hooks.rs / claude.rs.
//
//   * GET /global/event (SSE) is translated into the same `hook` events the
//     island already understands (SessionStart, PreToolUse, Stop, …), so the
//     TypeScript side barely changes.
//   * Permission requests keep their Allow / Deny card; the click becomes a
//     REST reply to OpenCode instead of a byte written to a named pipe.
//   * Chat goes through POST /session/:id/message, i.e. through whichever
//     provider and model OpenCode is already configured with.
//
// Privacy rules: credentials live in the Credential Manager (see secrets.rs);
// response bodies are never logged; /config/providers is never called.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use crate::notify;
use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::island::WINDOW_LABEL;
use crate::log;
use crate::secrets;

const DEFAULT_URL: &str = "http://127.0.0.1:4096";
const DEFAULT_USER: &str = "opencode";

// ── connection settings ──────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Conn {
    pub url: String,
    pub user: String,
    pub pass: Option<String>,
}

pub fn conn() -> Conn {
    let url = secrets::get("opencode-url").unwrap_or_else(|| DEFAULT_URL.into());
    Conn {
        url: url.trim().trim_end_matches('/').to_string(),
        user: secrets::get("opencode-username").unwrap_or_else(|| DEFAULT_USER.into()),
        pass: secrets::get("opencode-password"),
    }
}

pub fn http() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_default()
}

/// Shorthand for `field(v, "")` at the top of an expression.
pub fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    s(v, key)
}

pub fn authed(c: &Conn, rb: RequestBuilder) -> RequestBuilder {
    match &c.pass {
        Some(p) => rb.basic_auth(&c.user, Some(p)),
        None => rb,
    }
}

fn status_hint(s: StatusCode) -> String {
    match s.as_u16() {
        401 => "401 — wrong username or password".into(),
        n => format!("HTTP {n}"),
    }
}

/// The "Test connection" button. Returns the OpenCode version.
///
/// Nothing is started here, deliberately. Piko no longer owns an OpenCode: it
/// talks to one somebody else is running, at an address the person gave it, so a
/// failed test is a statement about that address and not about Piko's own state.
pub async fn test() -> Result<String, String> {
    let c = conn();
    let rb = authed(
        &c,
        http()
            .get(format!("{}/global/health", c.url))
            .timeout(Duration::from_secs(4)),
    );
    let res = rb.send().await.map_err(|e| {
        // Two different mistakes look identical from here: OpenCode is not
        // installed at all, or it is installed and not at this address. Saying
        // which is the whole value of the message, and "unreachable" on its own
        // sends people looking at Piko instead of at their own address.
        let detail = format!("unreachable at {} ({})", c.url, e.without_url());
        if cli().is_none() {
            format!("{detail} — {}", install_hint())
        } else {
            format!("{detail}. Is that the address your OpenCode is on?")
        }
    })?;
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    let v: Value = res
        .json()
        .await
        .map_err(|_| "unexpected response".to_string())?;
    match v.get("healthy").and_then(Value::as_bool) {
        Some(true) => Ok(v
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string()),
        _ => Err("server answered but reports unhealthy".into()),
    }
}

/// "Auto-detect": every loopback port held by a process called `opencode*` whose
/// `/global/health` answers. The port is not guessed any more - OpenCode desktop
/// picks a random one - so the listening sockets are read and the *owner* of each
/// is named. Only the image name is read, never another process's environment or
/// its credentials: this needs to know "is that an OpenCode", nothing more.
pub async fn detect() -> Option<String> {
    let c = conn();
    for port in listening_opencode_ports() {
        let url = format!("http://127.0.0.1:{port}");
        if let Some(v) = probe(&url, &c).await {
            log::line(&format!("opencode found on port {port} ({v})"));
            return Some(url);
        }
    }
    None
}

/// The loopback ports an `opencode*` process is listening on.
fn listening_opencode_ports() -> Vec<u16> {
    const AF_INET: u32 = 2;
    /// MIB_TABLE_STATE_LISTEN. The windows crate does not export it, and the
    /// value is fixed by the API.
    const LISTEN: u32 = 2;

    let mut size = 0u32;
    // SAFETY: a null buffer with length 0 is the documented way to ask how much
    // room the table needs; nothing is written.
    unsafe { GetExtendedTcpTable(None, &mut size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) };
    if (size as usize) < std::mem::size_of::<u32>() {
        return vec![];
    }
    let mut buf = vec![0u8; size as usize];
    // SAFETY: `buf` is `size` bytes, which is what the call above asked for.
    let rc = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
            &mut size,
            false,
            AF_INET,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    // ERROR_INSUFFICIENT_BUFFER: the table grew between the two calls.
    if rc != 0 {
        return vec![];
    }

    // SAFETY: rc == 0 means the buffer now holds a `MIB_TCPTABLE_OWNER_PID`
    // whose header says how many rows follow, and every row read here is inside
    // the `size` bytes the API reported.
    let ports: Vec<u16> = unsafe {
        let table = buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let count = (*table).dwNumEntries as usize;
        let rows = std::slice::from_raw_parts((*table).table.as_ptr(), count);
        rows.iter()
            .filter(|r| r.dwState == LISTEN)
            .map(|r| u16::from_be_bytes([r.dwLocalPort as u8, (r.dwLocalPort >> 8) as u8]))
            .collect()
    };

    let mut out: Vec<u16> = ports
        .into_iter()
        .filter(|port| {
            let Some(pid) = listening_pid(*port) else {
                return false;
            };
            process_name(pid)
                .map(|n| n.to_lowercase().starts_with("opencode"))
                .unwrap_or(false)
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// The pid holding `port`, asked for again by socket rather than carried through
/// the table above, so this stays a single narrow question.
fn listening_pid(port: u16) -> Option<u32> {
    const AF_INET: u32 = 2;
    const LISTEN: u32 = 2;

    let mut size = 0u32;
    // SAFETY: as above - asking for the size, writing nothing.
    unsafe { GetExtendedTcpTable(None, &mut size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) };
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size as usize];
    // SAFETY: `buf` is the size the API asked for.
    let rc = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
            &mut size,
            false,
            AF_INET,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    // SAFETY: rc == 0 means a valid table of `dwNumEntries` rows is in `buf`.
    unsafe {
        let table = buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let count = (*table).dwNumEntries as usize;
        let rows = std::slice::from_raw_parts((*table).table.as_ptr(), count);
        rows.iter()
            .find(|r| {
                r.dwState == LISTEN
                    && u16::from_be_bytes([r.dwLocalPort as u8, (r.dwLocalPort >> 8) as u8]) == port
            })
            .map(|r| r.dwOwningPid)
    }
}

/// The file name of a process, without its path - `opencode.exe` -> `opencode`.
fn process_name(pid: u32) -> Option<String> {
    // SAFETY: PROCESS_QUERY_LIMITED_INFORMATION is the least privilege that can
    // name a process. The handle is closed on the way out and never escapes, and
    // the buffer is `len` wide as the API requires.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let named = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        named.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&path)
            .file_stem()?
            .to_str()
            .map(str::to_string)
    }
}

// ── permission bookkeeping ───────────────────────────────────────────────────

#[derive(Clone)]
struct Target {
    session: String,
    permission: String,
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Session ids and permission ids are not secrets, but they are also not
        // worth putting in a panic message, so this prints shape only.
        f.debug_struct("Target")
            .field("session", &self.session)
            .field("permission", &self.permission)
            .finish()
    }
}

/// request_id (what the island knows) → what OpenCode needs for the reply.
#[derive(Default)]
pub struct Pending(Mutex<HashMap<String, Target>>);

/// Called by the island's Allow / Deny buttons. `always` is honoured now:
/// OpenCode can remember the choice, Claude Code's hook could not.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let Some(target) = app.state::<Pending>().0.lock().unwrap().remove(request_id) else {
        return;
    };
    // The badge counts what is still unanswered.
    repaint(app);
    let reply = match decision {
        "allow" => "once",
        "always" => "always",
        _ => "reject",
    };
    log::line(format!("opencode permission → {reply}"));
    tauri::async_runtime::spawn(async move {
        if let Err(e) = reply_permission(&target, reply).await {
            log::line(format!("opencode permission reply failed: {e}"));
        }
    });
}

/// Nothing to hand back: the question simply stays open in OpenCode itself.
pub fn decline(app: &AppHandle, request_id: &str) {
    app.state::<Pending>().0.lock().unwrap().remove(request_id);
    repaint(app);
}

/// Drops every permission belonging to `session`, returning the ids removed.
///
/// A deleted session takes its open permissions with it. Left in place they
/// would sit in the map forever, holding the tray badge at a count nobody can
/// clear — and the reply target is a session that no longer exists.
fn drop_session(map: &mut HashMap<String, Target>, session: &str) -> Vec<String> {
    let keys: Vec<String> = map
        .iter()
        .filter(|(_, t)| t.session == session)
        .map(|(k, _)| k.clone())
        .collect();
    for k in &keys {
        map.remove(k);
    }
    keys
}

/// Repaints the tray badge from the live map. One place decides what "pending"
/// means, so the count cannot drift from the thing being counted.
fn repaint(app: &AppHandle) {
    let n = app.state::<Pending>().0.lock().unwrap().len();
    notify::set_pending(app, notify::Source::OpenCode, n);
}

async fn reply_permission(t: &Target, reply: &str) -> Result<(), String> {
    let c = conn();
    let cl = http();
    // Current API: POST /session/:id/permissions/:permissionID { response }
    let url = format!(
        "{}/session/{}/permissions/{}",
        c.url, t.session, t.permission
    );
    let res = authed(&c, cl.post(&url).json(&json!({ "response": reply })))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if res.status().is_success() {
        return Ok(());
    }
    if res.status() != StatusCode::NOT_FOUND {
        return Err(status_hint(res.status()));
    }
    // Newer builds: POST /permission/:requestID/reply { reply }
    let url = format!("{}/permission/{}/reply", c.url, t.permission);
    let res = authed(&c, cl.post(&url).json(&json!({ "reply": reply })))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(status_hint(res.status()))
    }
}

// ── SSE → island ─────────────────────────────────────────────────────────────

#[derive(Default)]
struct Tracker {
    cwd: HashMap<String, String>,
    busy: HashSet<String>,
    seen_parts: HashSet<String>,
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut delay = 1u64;
        loop {
            match stream(&app).await {
                Ok(()) => delay = 1,
                Err(e) => log::line(format!("opencode stream: {e} — retry in {delay}s")),
            }
            tokio::time::sleep(Duration::from_secs(delay)).await;
            delay = (delay * 2).min(15);
        }
    });
}

async fn stream(app: &AppHandle) -> Result<(), String> {
    let c = conn();
    let cl = Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = authed(&c, cl.get(format!("{}/global/event", c.url)))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if res.status() == StatusCode::NOT_FOUND {
        res = authed(&c, cl.get(format!("{}/event", c.url)))
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
    }
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    log::line("opencode stream connected");

    let mut tracker = Tracker::default();
    let mut buf = String::new();
    let mut bytes = res.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|e| e.without_url().to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
        while let Some(i) = buf.find("\n\n") {
            let block: String = buf.drain(..i + 2).collect();
            let data: String = block
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                handle(app, &mut tracker, v).await;
            }
        }
        if buf.len() > (1 << 22) {
            buf.clear();
        }
    }
    Ok(())
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// Stops the chat turn in flight.
///
/// The same endpoint `tasks::abort` uses, and the island needs it for the same
/// reason: a turn is ended on the front end by `chat-done` or `chat-error`, and a
/// stream that simply stops arriving sends neither. Without this the person can
/// only wait out the watchdog, watching a character that thinks and a send button
/// that will not press.
///
/// The draft is kept: the words that did arrive are still an answer, and this is
/// not a `reset`. A session that has not started yet has nothing to abort, which is
/// a success rather than an error — Stop can be pressed the instant a turn opens,
/// before OpenCode has been reached.
pub async fn abort_chat(chat: &Chat) -> Result<(), String> {
    let Some(session) = chat.session.lock().unwrap().clone() else {
        return Ok(());
    };
    let c = conn();
    let res = authed(&c, http().post(format!("{}/session/{session}/abort", c.url)))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    log::line(format!("chat aborted · {session}"));
    Ok(())
}

/// One line about a failed session, safe to show on the island and to log.
///
/// `session.error` carries a union discriminated on `name`, and two of its
/// members (`APIError`, `ContextOverflowError`) have `responseBody` fields. The
/// body is dropped here on purpose: the task UI shows this string, and a
/// provider error body can contain the very thing the user was working on.
fn summarize_error(p: &Value, name: &str) -> String {
    let err = p.get("error").unwrap_or(&Value::Null);
    let msg = s(err, "message").trim();
    let msg = if msg.is_empty() { "no detail" } else { msg };
    match name {
        "MessageAbortedError" => format!("aborted — {msg}"),
        "ProviderAuthError" => format!("not signed in — {msg}"),
        "ContextOverflowError" => "ran out of context — try a smaller task".into(),
        "ContentFilterError" => format!("stopped by a content filter — {msg}"),
        "MessageOutputLengthError" => "the answer was too long to finish".into(),
        "" => msg.to_string(),
        n => format!("{n} — {msg}"),
    }
    .chars()
    .take(200)
    .collect()
}

async fn cwd_of(t: &mut Tracker, session: &str) -> String {
    if let Some(d) = t.cwd.get(session) {
        return d.clone();
    }
    let c = conn();
    let d = match authed(
        &c,
        http()
            .get(format!("{}/session/{session}", c.url))
            .timeout(Duration::from_secs(3)),
    )
    .send()
    .await
    {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .ok()
            .map(|v| s(&v, "directory").to_string()),
        _ => None,
    }
    .unwrap_or_default();
    t.cwd.insert(session.to_string(), d.clone());
    d
}

/// The session an event belongs to, wherever the server put the id.
///
/// `sessionID` is at the top for `message.part.delta` and `session.*`, inside
/// `info` for `message.updated` and inside `part` for `message.part.updated`.
/// Only the first shape is where the agent path above looks, so a chat turn's
/// text would otherwise arrive with no session to match it against.
fn part_session(p: &Value) -> String {
    for holder in [
        p.clone(),
        p.get("info").cloned().unwrap_or(Value::Null),
        p.get("part").cloned().unwrap_or(Value::Null),
    ] {
        let id = s(&holder, "sessionID");
        if !id.is_empty() {
            return id.to_string();
        }
    }
    String::new()
}

/// The rule itself, split out so it can be tested without a live window.
/// `held` is `None` before the first chat turn, when nothing is a chat session.
fn chat_session_matches(held: Option<&str>, session: &str) -> bool {
    !session.is_empty() && held.is_some_and(|id| id == session)
}

async fn handle(app: &AppHandle, t: &mut Tracker, raw: Value) {
    // /global/event wraps: { directory, payload: { type, properties } }
    let (dir, ev) = match raw.get("payload") {
        Some(p) => (s(&raw, "directory").to_string(), p.clone()),
        None => (String::new(), raw),
    };
    let kind = s(&ev, "type");
    let p = ev.get("properties").cloned().unwrap_or(Value::Null);
    let session = s(&p, "sessionID").to_string();
    let session = if session.is_empty() {
        s(p.get("info").unwrap_or(&Value::Null), "id").to_string()
    } else {
        session
    };
    if !dir.is_empty() && !session.is_empty() {
        t.cwd.entry(session.clone()).or_insert(dir);
    }

    // The Ask-mode conversation is one long-lived session of Piko's own, and its
    // events are not an agent working. Every session here was being translated
    // into Claude-Code-style hooks for the agent the island watches, so a chat
    // turn's `session.idle` arrived as `Stop` and the island replaced the open
    // conversation with a "Session finished" card after every single reply. The
    // task registry already ignored this session; the hook emit did not.
    //
    // What is left of it is the reply itself: the text parts of this session are
    // streamed to the chat, and `message.part.updated` / `message.part.delta` put
    // their session id one level down where the agent events above never look.
    let chat_sid = app
        .try_state::<Chat>()
        .and_then(|c| c.session.lock().ok().and_then(|g| g.clone()));
    let ev_session = if session.is_empty() {
        part_session(&p)
    } else {
        session.clone()
    };
    if chat_session_matches(chat_sid.as_deref(), &ev_session) {
        chat_event(app, &kind, &p, &ev_session);
        t.busy.remove(&ev_session);
        t.seen_parts.clear();
        t.cwd.remove(&ev_session);
        return;
    }

    match kind {
        "session.created" => {
            let cwd = cwd_of(t, &session).await;
            emit(
                app,
                json!({ "hook_event_name": "SessionStart", "session_id": session, "cwd": cwd }),
            );
        }
        "session.status" => {
            let ty = p.get("status").map(|x| s(x, "type")).unwrap_or_default();
            if ty == "busy" && t.busy.insert(session.clone()) {
                let cwd = cwd_of(t, &session).await;
                emit(
                    app,
                    json!({ "hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": cwd }),
                );
            }
        }
        "session.idle" => {
            t.busy.remove(&session);
            t.seen_parts.clear();
            let cwd = cwd_of(t, &session).await;
            crate::tasks::on_finished(app, &session, "finished", None);
            emit(
                app,
                json!({ "hook_event_name": "Stop", "session_id": session, "cwd": cwd }),
            );
        }
        "session.error" => {
            t.busy.remove(&session);
            let cwd = cwd_of(t, &session).await;
            // Only the discriminated `name` is read. The body is never logged:
            // an APIError can carry a provider response, and that can carry
            // whatever the user was working on.
            let name = p.get("error").map(|e| s(e, "name")).unwrap_or_default();
            crate::tasks::on_finished(app, &session, "error", Some(summarize_error(&p, name)));
            emit(
                app,
                json!({ "hook_event_name": "StopFailure", "session_id": session, "cwd": cwd }),
            );
        }
        "session.deleted" => {
            t.cwd.remove(&session);
            t.busy.remove(&session);
            // A deleted session takes its open permissions with it. Without
            // this they would sit in the map forever, holding the badge at a
            // count nobody can clear.
            let dropped: Vec<String> =
                drop_session(&mut app.state::<Pending>().0.lock().unwrap(), &session);
            if !dropped.is_empty() {
                log::line(format!(
                    "session ended with {} permission(s) open",
                    dropped.len()
                ));
                repaint(app);
            }
            emit(
                app,
                json!({ "hook_event_name": "SessionEnd", "session_id": session }),
            );
        }
        // `todo.updated` — the server's name for it. It is *not*
        // `session.todo.updated`, which appears nowhere in 1.18.34. The whole
        // list arrives each time, so there is nothing to merge.
        "todo.updated" => {
            let sid = s(&p, "sessionID").to_string();
            if sid.is_empty() {
                return;
            }
            let todos: Vec<crate::tasks::Todo> = p
                .get("todos")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(crate::tasks::Todo::from_value)
                        .collect()
                })
                .unwrap_or_default();
            crate::tasks::on_todos(app, &sid, todos);
        }
        "message.part.updated" => {
            let part = p.get("part").cloned().unwrap_or(Value::Null);
            if s(&part, "type") != "tool" {
                return;
            }
            let status = part
                .get("state")
                .map(|x| s(x, "status"))
                .unwrap_or_default();
            let id = s(&part, "id").to_string();
            let sid = s(&part, "sessionID").to_string();
            let cwd = cwd_of(t, &sid).await;
            // A task keeps its own current step so the overview can show one
            // line per running task instead of a flat stream of steps.
            if matches!(status, "running" | "pending") {
                let input = part["state"].get("input").cloned().unwrap_or(json!({}));
                let label = crate::tasks::step_label(s(&part, "tool"), Some(&input));
                crate::tasks::on_step(app, &sid, &label);
            }
            match status {
                "running" if t.seen_parts.insert(id) => emit(
                    app,
                    json!({
                        "hook_event_name": "PreToolUse",
                        "session_id": sid,
                        "cwd": cwd,
                        "tool_name": s(&part, "tool"),
                        "tool_input": part["state"].get("input").cloned().unwrap_or(json!({})),
                    }),
                ),
                "error" => emit(
                    app,
                    json!({ "hook_event_name": "PostToolUseFailure", "session_id": sid, "cwd": cwd }),
                ),
                "completed" => emit(
                    app,
                    json!({ "hook_event_name": "PostToolUse", "session_id": sid, "cwd": cwd }),
                ),
                _ => {}
            }
        }
        // `permission.asked` (new) / `permission.updated` (older builds)
        "permission.asked" | "permission.updated" => {
            let perm_id = s(&p, "id").to_string();
            if perm_id.is_empty() || session.is_empty() {
                return;
            }
            let tool = {
                let a = s(&p, "permission");
                if a.is_empty() {
                    s(&p, "type")
                } else {
                    a
                }
            }
            .to_string();
            let meta = p.get("metadata").cloned().unwrap_or(Value::Null);
            let patterns: Vec<String> = match p.get("patterns").or_else(|| p.get("pattern")) {
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect(),
                Some(Value::String(x)) => vec![x.clone()],
                _ => vec![],
            };
            let mut input = serde_json::Map::new();
            let command = meta
                .get("command")
                .and_then(Value::as_str)
                .map(String::from);
            let file = meta
                .get("filepath")
                .or_else(|| meta.get("filePath"))
                .and_then(Value::as_str)
                .map(String::from);
            if let Some(cmd) = command.or_else(|| (tool == "bash").then(|| patterns.join(" ; "))) {
                input.insert("command".into(), json!(cmd));
            } else if let Some(f) = file.or_else(|| patterns.first().cloned()) {
                input.insert("file_path".into(), json!(f));
            } else if !s(&p, "title").is_empty() {
                input.insert("prompt".into(), json!(s(&p, "title")));
            }
            let request_id = format!("oc-{perm_id}");
            app.state::<Pending>().0.lock().unwrap().insert(
                request_id.clone(),
                Target {
                    session: session.clone(),
                    permission: perm_id,
                },
            );
            let cwd = cwd_of(t, &session).await;

            // Raise the person before the card: the island is a 6px strip and is
            // easy to miss from another window. The detail in the toast is the
            // same text the card shows, so the choice is never a surprise.
            let detail = input
                .get("command")
                .or_else(|| input.get("file_path"))
                .or_else(|| input.get("prompt"))
                .and_then(Value::as_str)
                .unwrap_or(&tool);
            let alert = if input.contains_key("command") {
                notify::Alert::command(detail, Some(&cwd))
            } else if input.contains_key("file_path") {
                notify::Alert::file(detail)
            } else {
                notify::Alert::generic(detail)
            };
            notify::set_pending(
                app,
                notify::Source::OpenCode,
                app.state::<Pending>().0.lock().unwrap().len(),
            );
            notify::raise(app, alert);

            emit(
                app,
                json!({
                    "hook_event_name": "PermissionRequest",
                    "request_id": request_id,
                    "session_id": session,
                    "cwd": cwd,
                    "tool_name": tool,
                    "tool_input": input,
                }),
            );
        }
        // Answered somewhere else (TUI / desktop): take the card down.
        "permission.replied" => {
            let pid = if s(&p, "requestID").is_empty() {
                s(&p, "permissionID")
            } else {
                s(&p, "requestID")
            };
            let rid = format!("oc-{pid}");
            let was_pending = app
                .state::<Pending>()
                .0
                .lock()
                .unwrap()
                .remove(&rid)
                .is_some();
            // Only repaint if it was one of ours: a permission answered in the
            // terminal should not blank a badge for a request still open here.
            if was_pending {
                repaint(app);
            }
            emit(
                app,
                json!({ "hook_event_name": "PermissionReplied", "request_id": rid }),
            );
        }
        _ => {}
    }
}

// ── chat ─────────────────────────────────────────────────────────────────────

/// The reply being assembled from the stream.
///
/// A chat turn used to be one blocking `POST /message` that came back whole, so
/// the island had nothing to show until the model had finished. It now fires the
/// prompt the way a task does and reads the answer off the stream, which arrives
/// as a `message.part.delta` per fragment and as `message.part.updated` carrying
/// the whole part each time it grows. Either is enough; both are consumed so a
/// provider that only sends one of them still streams.
#[derive(Default)]
struct Draft {
    /// Text parts already closed by the next `step-start`.
    done: Vec<String>,
    /// The part being written right now.
    part: String,
    /// Message ids the server has said are the assistant's.
    assistant: HashSet<String>,
    /// Whether any text at all came down the stream this turn. A turn that
    /// streamed nothing is answered from the server instead, rather than left as
    /// an empty bubble.
    any: bool,
}

impl Draft {
    /// Whether a text part is the assistant's, and so part of the reply.
    ///
    /// The prompt the person typed comes back down the same stream as a text part
    /// of a `user` message, and answering them with their own question is the one
    /// mistake this cannot make.
    fn accepts(&self, message_id: &str) -> bool {
        self.assistant.contains(message_id)
    }

    /// The reply so far. Every closed part, then the one in progress.
    fn text(&self) -> String {
        let mut out = self.done.join("\n");
        if !self.part.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&self.part);
        }
        out
    }

    /// Closes the part in progress and empties the draft for the next turn.
    fn finish(&mut self) -> String {
        if !self.part.is_empty() {
            self.done.push(std::mem::take(&mut self.part));
        }
        let text = self.text();
        self.done.clear();
        self.assistant.clear();
        self.any = false;
        text
    }
}

#[derive(Default)]
pub struct Chat {
    session: Mutex<Option<String>>,
    draft: Mutex<Draft>,
}

impl Chat {
    pub fn reset(&self) {
        *self.session.lock().unwrap() = None;
        *self.draft.lock().unwrap() = Draft::default();
    }
}

/// One of the chat's own events, which the agent path above must never see.
///
/// Everything is filtered on the message being the assistant's: the prompt the
/// person just typed comes back down the same stream as a text part of a *user*
/// message, and answering that with itself is the one mistake this cannot make.
fn chat_event(app: &AppHandle, kind: &str, p: &Value, session: &str) {
    let Some(chat) = app.try_state::<Chat>() else {
        return;
    };
    match kind {
        "message.updated" => {
            let info = p.get("info").cloned().unwrap_or(Value::Null);
            let id = s(&info, "id").to_string();
            if id.is_empty() {
                return;
            }
            let mut d = chat.draft.lock().unwrap();
            if s(&info, "role") == "assistant" {
                d.assistant.insert(id);
            } else {
                d.assistant.remove(&id);
            }
        }
        "message.part.delta" => {
            if s(p, "field") != "text" {
                return;
            }
            let delta = s(p, "delta");
            if delta.is_empty() {
                return;
            }
            let mid = s(p, "messageID").to_string();
            let (text, ok) = {
                let mut d = chat.draft.lock().unwrap();
                if !d.accepts(&mid) {
                    return;
                }
                d.part.push_str(delta);
                d.any = true;
                (d.text(), true)
            };
            if ok {
                let _ = app.emit_to(WINDOW_LABEL, "chat-text", json!({ "text": text }));
            }
        }
        "message.part.updated" => {
            let part = p.get("part").cloned().unwrap_or(Value::Null);
            match s(&part, "type") {
                // A step is what separates two text parts, and an answer with a
                // tool call in the middle of it is several of them.
                "step-start" => {
                    let mut d = chat.draft.lock().unwrap();
                    if !d.part.is_empty() {
                        let part = std::mem::take(&mut d.part);
                        d.done.push(part);
                    }
                }
                "text" => {
                    let mid = s(&part, "messageID").to_string();
                    let text = s(&part, "text").to_string();
                    let out = {
                        let mut d = chat.draft.lock().unwrap();
                        if !d.accepts(&mid) {
                            return;
                        }
                        // The server sends the whole part every time, so this is
                        // the authority on what has been written; the deltas only
                        // made it arrive sooner. Never let a shorter repeat undo
                        // text that has already been shown.
                        if text.len() > d.part.len() {
                            d.part = text;
                            d.any = true;
                        }
                        d.text()
                    };
                    let _ = app.emit_to(WINDOW_LABEL, "chat-text", json!({ "text": out }));
                }
                _ => {}
            }
        }
        "session.idle" => {
            let streamed = {
                let mut d = chat.draft.lock().unwrap();
                d.finish()
            };
            if streamed.trim().is_empty() {
                // Nothing came down the stream, so the deltas are not something
                // this server build sends for this session. Ask it directly rather
                // than leaving an empty bubble in the conversation.
                let session = session.to_string();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let text = last_reply(&session).await.unwrap_or_default();
                    if !text.trim().is_empty() {
                        let _ = app.emit_to(WINDOW_LABEL, "chat-text", json!({ "text": text }));
                    }
                    let _ = app.emit_to(WINDOW_LABEL, "chat-done", json!({}));
                });
                return;
            }
            let _ = app.emit_to(WINDOW_LABEL, "chat-text", json!({ "text": streamed }));
            let _ = app.emit_to(WINDOW_LABEL, "chat-done", json!({}));
        }
        "session.error" => {
            // The same one line the blocking call used to read out of the reply.
            let mut d = chat.draft.lock().unwrap();
            d.any = false;
            let name = p.get("error").map(|e| s(e, "name")).unwrap_or_default();
            let why = summarize_error(p, name);
            drop(d);
            let _ = app.emit_to(WINDOW_LABEL, "chat-error", json!({ "message": why }));
        }
        "session.deleted" => chat.reset(),
        _ => {}
    }
}

/// The last assistant message of a session, straight from the server.
///
/// The safety net for a turn whose text never arrived on the stream. Reads the
/// same shape the old blocking call did, so a provider failure comes back as the
/// same sentence rather than as silence.
async fn last_reply(session: &str) -> Result<String, String> {
    if session.is_empty() {
        return Err("no chat session".into());
    }
    let c = conn();
    let res = authed(
        &c,
        http()
            .get(format!("{}/session/{session}/message", c.url))
            .timeout(Duration::from_secs(5)),
    )
    .send()
    .await
    .map_err(|e| e.without_url().to_string())?;
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    let list: Vec<Value> = res
        .json()
        .await
        .map_err(|_| "unexpected response".to_string())?;
    let last = list
        .iter()
        .rev()
        .find(|m| s(m.get("info").unwrap_or(m), "role") == "assistant")
        .cloned()
        .ok_or("no answer")?;
    if let Some(why) = reply_error(&last) {
        return Err(why);
    }
    Ok(last
        .get("parts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|p| s(p, "type") == "text")
                .map(|p| s(p, "text"))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File {
        name: String,
        path: String,
    },
    Window {
        app_name: String,
        title: String,
        url: Option<String>,
    },
}

/// What a fired prompt has to say: nothing. The answer arrives on the stream, and
/// waiting for it here is what made the room feel slow.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSent {}

const MAX_INLINE_TEXT: u64 = 200_000;

fn context_text(ctx: &ChatContext) -> Option<String> {
    match ctx {
        ChatContext::File { name, path } => {
            let meta = std::fs::metadata(path).ok()?;
            if meta.len() > MAX_INLINE_TEXT {
                return Some(format!("File: {name} (too large to inline, path: {path})"));
            }
            match std::fs::read_to_string(path) {
                Ok(text) => Some(format!("File: {name}\n\n{text}")),
                Err(_) => Some(format!("File: {name} (binary, path: {path})")),
            }
        }
        ChatContext::Window {
            app_name,
            title,
            url,
        } => {
            let mut t = format!("Context — App: {app_name}, Window: {title}");
            if let Some(u) = url {
                t.push_str(&format!(", URL: {u}"));
            }
            Some(t)
        }
    }
}

async fn ensure_session(chat: &Chat, c: &Conn) -> Result<String, String> {
    if let Some(id) = chat.session.lock().unwrap().clone() {
        return Ok(id);
    }
    let res = authed(
        c,
        http()
            .post(format!("{}/session", c.url))
            .json(&json!({ "title": "Mochi" })),
    )
    .send()
    .await
    .map_err(|e| format!("OpenCode unreachable ({})", e.without_url()))?;
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    let v: Value = res
        .json()
        .await
        .map_err(|_| "unexpected response".to_string())?;
    let id = s(&v, "id").to_string();
    if id.is_empty() {
        return Err("OpenCode returned no session id".into());
    }
    *chat.session.lock().unwrap() = Some(id.clone());
    Ok(id)
}

/// Fires a chat turn and returns as soon as the server has accepted it.
///
/// This used to POST `/session/{id}/message` and block on the whole answer with a
/// 300 s timeout, so the island showed nothing but typing dots for the entire turn.
/// It now uses `prompt_async` — the same call a task uses — and the reply is read
/// off the SSE stream the app already holds open (`chat_event`).
pub async fn send(
    chat: &Chat,
    query: String,
    context: Option<ChatContext>,
    agent: Option<String>,
) -> Result<ChatSent, String> {
    let c = conn();
    let first = chat.session.lock().unwrap().is_none();
    let session = ensure_session(chat, &c).await?;

    let mut parts = vec![];
    if first {
        // Context rides along with the first message only, as before.
        if let Some(t) = context.as_ref().and_then(context_text) {
            parts.push(json!({ "type": "text", "text": t }));
        }
    }
    parts.push(json!({ "type": "text", "text": query }));

    // Sent per message rather than at session creation: the chat keeps one long
    // session for its whole life, so an agent chosen at creation could never be
    // changed afterwards. Verified against the 1.18.34 server — `info.agent`
    // comes back as exactly what was asked for, and an unknown name is an error
    // rather than being ignored.
    let agent = agent
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    let mut body = json!({ "parts": parts });
    if let Some(a) = agent.as_deref() {
        body["agent"] = json!(a);
    }

    let res = authed(
        &c,
        http()
            .post(format!("{}/session/{session}/prompt_async", c.url))
            .timeout(Duration::from_secs(30))
            .json(&body),
    )
    .send()
    .await
    .map_err(|e| format!("OpenCode unreachable ({})", e.without_url()))?;
    if res.status() == StatusCode::NOT_FOUND {
        // The session vanished under us. The turn is lost either way, but the next
        // one must start a fresh session rather than fail the same way forever.
        chat.reset();
        return Err("that conversation is gone — ask again".into());
    }
    if !res.status().is_success() {
        return Err(status_hint(res.status()));
    }
    // A turn in flight owns the draft: whatever is left over from the last one is
    // not part of this answer.
    *chat.draft.lock().unwrap() = Draft::default();
    Ok(ChatSent {})
}

/// The provider/model failure carried by a chat reply, as one readable line.
/// Returns `None` for a healthy reply.
fn reply_error(v: &Value) -> Option<String> {
    let info = v.get("info")?;
    let err = info.get("error")?;
    if err.is_null() {
        return None;
    }
    let kind = s(err, "name");
    let detail = err
        .get("data")
        .and_then(|d| d.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let provider = s(info, "providerID");
    let model = s(info, "modelID");

    let mut out = String::new();
    if !kind.is_empty() {
        out.push_str(kind);
    }
    if !detail.is_empty() {
        if !out.is_empty() {
            out.push_str(" — ");
        }
        out.push_str(detail);
    }
    if !provider.is_empty() && !model.is_empty() {
        out.push_str(&format!(" [{provider}/{model}]"));
    }
    if out.is_empty() {
        out.push_str("the model call failed with no detail");
    }
    Some(out)
}

// ── helpers kept from the old claude.rs (used by integrations.rs) ────────────

pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// -- finding the OpenCode CLI ------------------------------------------------
//
// Piko does not start a server any more. It talks to one that is already running,
// at an address the person gave it or picked with Auto-detect. What is left of the
// old managed machinery is the one thing still needed: the path to the `opencode`
// binary, used to open a project in it.

/// The one thing left to do about the managed era.
///
/// That era wrote `opencode-url` — a loopback port it had picked for a server it
/// then stopped on exit — into the Credential Manager. Keeping the value would
/// leave Piko pointed at a dead port for ever, failing in a way that reads like a
/// bug rather than like a setting nobody chose any more. So it is dropped once, and
/// `conn()` falls back to the default address until somebody saves a real one.
///
/// Only when the settings file says the install was managed: a URL somebody typed
/// is theirs, however unreachable it looks, and guessing at that would be Piko
/// rewriting a preference behind their back.
pub fn forget_managed_connection(was_managed: bool) {
    if !was_managed || secrets::get("opencode-url").is_none() {
        return;
    }
    // `set` with an empty value deletes the entry, which is the whole operation.
    match secrets::set("opencode-url", "") {
        Ok(()) => log::line(
            "dropped the URL the managed server left behind - set yours in Settings -> OpenCode",
        ),
        Err(e) => log::line(&format!("could not drop the managed OpenCode URL: {e}")),
    }
}

/// What to tell someone whose PATH has no `opencode`. The alternative is an
/// "unreachable" that reads like a bug in Piko.
pub fn install_hint() -> String {
    "OpenCode is not installed - no `opencode` on PATH. Install it with \
     `npm i -g opencode-ai` (or `brew install opencode`), then restart Piko."
        .into()
}

/// How runnable a candidate is. Only the ranking matters: without it the
/// extensionless POSIX shim that npm drops next to `opencode.cmd` wins over the
/// shim we could actually run, and CreateProcess answers with error 193.
fn run_rank(path: &std::path::Path) -> u8 {
    match path.extension().and_then(|e| e.to_str()) {
        Some(e) if e.eq_ignore_ascii_case("exe") => 0,
        Some(e) if e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat") => 1,
        None => 2,
        Some(_) => 3,
    }
}

/// The first `opencode` we can run. Windows order wins: `.exe`, then the npm
/// shims. PATH comes first, then the two directories npm puts its global shims
/// in, because a machine that installed OpenCode without adding `%APPDATA%\npm`
/// to PATH has the CLI sitting right there and PATH is simply lying about it.
pub fn cli() -> Option<std::path::PathBuf> {
    let mut found: Option<std::path::PathBuf> = None;
    let mut consider = |dir: std::path::PathBuf| {
        for name in ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"] {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            let rank = run_rank(&candidate);
            let better = found.as_deref().map(|f| rank < run_rank(f)).unwrap_or(true);
            if better {
                found = Some(candidate);
            }
        }
    };

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            consider(dir);
        }
    }
    for var in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            consider(std::path::PathBuf::from(base).join("npm"));
        }
    }
    found
}

/// One `/global/health` answer: the version, or None for "not a working server".
async fn probe(url: &str, c: &Conn) -> Option<String> {
    let res = authed(
        c,
        http()
            .get(format!("{url}/global/health"))
            .timeout(Duration::from_secs(3)),
    )
    .send()
    .await
    .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let v: Value = res.json().await.ok()?;
    (v.get("healthy").and_then(Value::as_bool) == Some(true)).then(|| {
        v.get("version")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string()
    })
}

// ── Connection: health, start, reconnect ──────────────────────────────────────
//
// Piko does not own an OpenCode (see above), but "not running" is still a state it
// has to answer honestly: what the address is, whether anything answers it, and —
// when the person asks for it — a way to start one. Everything here is opt-in from
// the island; nothing is started on its own.

/// `CREATE_NO_WINDOW`. A console app launched from a GUI app without it flashes a
/// black window on every attempt.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long a single health check may take before it counts as "not there".
const HEALTH_TIMEOUT: Duration = Duration::from_secs(4);
/// How long to keep waiting for a server Piko just started.
const START_WAIT: Duration = Duration::from_secs(25);

/// What the island shows about the connection.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub url: String,
    pub version: Option<String>,
    /// Why it failed, in the server's own words where it has any.
    pub reason: Option<String>,
    /// The `opencode` program is not installed — a different problem from "not
    /// running", and the only one no amount of retrying will fix.
    pub cli_missing: bool,
}

/// One health check against the configured address, with the reason kept.
///
/// The reason is the point. "Unreachable" on its own sends people looking at Piko
/// instead of at their own machine, and `reqwest`'s own text ("error sending
/// request") says nothing at all, so the underlying cause is logged verbatim and
/// the short form is what the interface shows.
pub async fn health() -> Health {
    let c = conn();
    let mut out = Health {
        ok: false,
        url: c.url.clone(),
        version: None,
        reason: None,
        cli_missing: cli().is_none(),
    };
    let res = match authed(
        &c,
        http()
            .get(format!("{}/global/health", c.url))
            .timeout(HEALTH_TIMEOUT),
    )
    .send()
    .await
    {
        Ok(res) => res,
        Err(e) => {
            // The whole error, source chain included: `error sending request` is
            // the top of a reqwest error whose bottom is the reason it failed.
            let detail = format!("{e:#}");
            log::line(&format!("opencode health at {} failed: {detail}", c.url));
            out.reason = Some(match &out.cli_missing {
                true => install_hint(),
                false => format!("{detail} — nothing is answering at {}", c.url),
            });
            return out;
        }
    };
    if !res.status().is_success() {
        let why = status_hint(res.status());
        log::line(&format!("opencode health at {} said {why}", c.url));
        out.reason = Some(why);
        return out;
    }
    let v: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            log::line(&format!("opencode health at {} was not json: {e}", c.url));
            out.reason = Some(format!("unexpected answer from {}", c.url));
            return out;
        }
    };
    match v.get("healthy").and_then(Value::as_bool) {
        Some(true) => {
            let version = v
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string();
            log::line(&format!("opencode connected at {} ({version})", c.url));
            out.ok = true;
            out.version = Some(version);
        }
        _ => out.reason = Some(format!("{} answers but reports itself unhealthy", c.url)),
    }
    out
}

/// The port the configured URL names — the one thing `opencode serve` needs.
///
/// Parsed out of the address rather than stored separately, so there is a single
/// place the port can live and it cannot drift from the URL.
pub fn port_of(url: &str) -> Option<u16> {
    let after = url.split_once("://")?.1;
    let hostport = after.split('/').next()?;
    hostport
        .rsplit_once(':')?
        .1
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
}

/// The `opencode serve` this process started, if it started one.
///
/// Held so it can be stopped on the way out — and only then. An OpenCode the person
/// started themselves belongs to them, and killing it because the overlay is
/// quitting would be the worst possible answer to "quit Piko".
static OWNED: std::sync::OnceLock<Mutex<Option<std::process::Child>>> =
    std::sync::OnceLock::new();

fn owned() -> &'static Mutex<Option<std::process::Child>> {
    OWNED.get_or_init(|| Mutex::new(None))
}

/// `opencode serve --hostname 127.0.0.1 --port <port>`, windowless.
///
/// npm installs `opencode.cmd` rather than an `.exe`, which CreateProcess cannot
/// run, so a shim goes through `cmd.exe` — which then makes cmd the tracked child.
fn spawn_server(cli: &std::path::Path, port: u16) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    let args = [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        &port.to_string(),
    ];
    let shimmed = cli
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut cmd = if shimmed {
        let mut c = std::process::Command::new("cmd.exe");
        c.arg("/C").arg(cli).args(args);
        c
    } else {
        let mut c = std::process::Command::new(cli);
        c.args(args);
        c
    };
    // Null rather than piped: a pipe nobody drains fills and wedges the child, and
    // a log line could carry anything the server prints.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
}

/// Stops the server this process started, and only that one.
///
/// Called on the way out. `taskkill /T` rather than `Child::kill` because a server
/// reached through an npm shim is a grandchild, and `Child::kill` only ever reaches
/// the child — leaking an `opencode serve` that holds the port is worse than the
/// extra process.
pub fn shutdown_owned() {
    let mut slot = owned().lock().unwrap();
    let Some(mut child) = slot.take() else {
        return;
    };
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let _ = child.wait();
    log::line("stopped the OpenCode Piko started");
}

/// Starts an OpenCode, if the person asked for one and there is not one already.
///
/// The health check comes first and is the point: Piko talks to an address the
/// person owns, and "start one" must never mean "start a second one" next to a
/// server that is already answering. Only a server this call started is ever
/// stopped by [`shutdown_owned`].
pub async fn start_server() -> Result<String, String> {
    let before = health().await;
    if before.ok {
        // Already there. Saying so is the whole answer — starting a rival on the
        // same port would fail, or worse, bind somewhere else.
        return Ok(before.version.unwrap_or_else(|| "?".into()));
    }
    let Some(cli) = cli() else {
        return Err(install_hint());
    };
    let c = conn();
    let Some(port) = port_of(&c.url) else {
        return Err(format!(
            "{} has no port in it, so there is nowhere to start OpenCode",
            c.url
        ));
    };
    log::line(&format!("starting `opencode serve` on port {port}"));
    let child = spawn_server(&cli, port).map_err(|e| format!("could not start it: {e}"))?;
    *owned().lock().unwrap() = Some(child);

    // A process that started is not a server that works: poll health until it says
    // so, and give the port back if it never does.
    let mut waited = Duration::ZERO;
    let mut step = 150u64;
    while waited < START_WAIT {
        tokio::time::sleep(Duration::from_millis(step)).await;
        waited += Duration::from_millis(step);
        step = (step * 2).min(1_000);
        let h = health().await;
        if h.ok {
            return Ok(h.version.unwrap_or_else(|| "?".into()));
        }
    }
    let _ = owned().lock().unwrap().take();
    log::line("`opencode serve` started but never became healthy");
    Err(format!(
        "started OpenCode but it never answered on port {port}"
    ))
}

/// Whether the island wants the reconnect loop running. Set from the chat room.
static RECONNECT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// One loop at a time, so a second request joins the one already running instead of
/// starting a rival that doubles every probe.
static RECONNECTING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Emits the connection status the island renders.
fn emit_status(app: &AppHandle, h: &Health) {
    let _ = app.emit_to(WINDOW_LABEL, "opencode-status", h);
}

/// Keeps trying to reach OpenCode, with the delay doubling up to half a minute.
///
/// Started when the chat room opens and stopped when it closes, because that is
/// the only time a connection the island cannot see is worth anything: a room that
/// is closed cannot be sending a turn that failed. Ends the moment health passes —
/// the person can see it connected, and a loop that kept going would be a request
/// every thirty seconds forever for no reason. The island re-arms it on the next
/// failure.
pub fn watch(app: AppHandle, on: bool) {
    RECONNECT.store(on, std::sync::atomic::Ordering::Relaxed);
    if !on {
        return;
    }
    if RECONNECTING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return; // one is already on its way
    }
    tauri::async_runtime::spawn(async move {
        let mut delay = 1u64;
        loop {
            if !RECONNECT.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let h = health().await;
            emit_status(&app, &h);
            if h.ok {
                break;
            }
            if !sleep_unless_stopped(delay).await {
                break;
            }
            delay = (delay * 2).min(30);
        }
        RECONNECTING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

/// Sleeps in slices, so a stop request is never stuck behind a thirty-second nap.
///
/// Returns false when the caller should give up — either the island stopped asking
/// or the loop that was waiting has been superseded.
async fn sleep_unless_stopped(seconds: u64) -> bool {
    let mut left = Duration::from_secs(seconds);
    let slice = Duration::from_millis(200);
    while !left.is_zero() {
        if !RECONNECT.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        let step = left.min(slice);
        tokio::time::sleep(step).await;
        left -= step;
    }
    RECONNECT.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    fn target(session: &str) -> Target {
        Target {
            session: session.into(),
            permission: "p1".into(),
        }
    }

    fn filled() -> HashMap<String, Target> {
        let mut m = HashMap::new();
        m.insert("oc-1".to_string(), target("alpha"));
        m.insert("oc-2".to_string(), target("beta"));
        m.insert("oc-3".to_string(), target("alpha"));
        m
    }

    #[test]
    fn ending_a_session_drops_only_its_own_permissions() {
        let mut m = filled();
        let dropped = drop_session(&mut m, "alpha");
        assert_eq!(dropped.len(), 2);
        // The other session's request must survive, or a user answering a beta
        // permission would find it already gone.
        assert!(m.contains_key("oc-2"), "beta's permission was dropped");
        assert!(!m.contains_key("oc-1"));
        assert!(!m.contains_key("oc-3"));
    }

    #[test]
    fn ending_a_session_leaves_no_pending_behind() {
        // This is what the tray badge counts: an entry left here would show a
        // permanent "1 waiting" that no button can clear.
        let mut m = filled();
        for s in ["alpha", "beta"] {
            drop_session(&mut m, s);
        }
        assert!(m.is_empty(), "{m:?}");
    }

    #[test]
    fn ending_a_session_nobody_had_permissions_for_is_harmless() {
        let mut m = filled();
        let dropped = drop_session(&mut m, "gamma");
        assert!(dropped.is_empty());
        assert_eq!(m.len(), 3);
    }

    #[test]
    fn a_settings_file_from_the_managed_era_still_loads() {
        // Every install on disk has `managedServer` in it. The field is gone, so
        // the key has to be ignored rather than rejected — otherwise the first
        // launch after this change fails to parse the file and Piko starts with
        // defaults, which is a worse outcome than ignoring an obsolete switch.
        let older = r#"{
            "soundEnabled": true, "soundVolume": 0.12,
            "autoCloseInterval": 15.0, "absenceInterval": 180.0,
            "activeIntegrations": [], "screen": "primary",
            "autostart": false, "hooksInstalled": false, "model": "opencode",
            "managedServer": true, "taskAgent": "build", "chatAgent": "plan"
        }"#;
        let parsed: Settings = serde_json::from_str(older).expect("a managed-era settings file");
        // The parts that are still ours survive the obsolete key.
        assert_eq!(parsed.task_agent, "build");
        assert_eq!(parsed.chat_agent, "plan");
        assert_eq!(parsed.sound_volume, 0.12);
        // And the key itself is read, because it is the only thing that says the
        // stored URL belongs to a server Piko started.
        assert_eq!(parsed.managed_server, Some(true));
    }

    #[test]
    fn a_manual_install_is_never_mistaken_for_a_managed_one() {
        // `Some(false)` is somebody who already pointed Piko at their own server:
        // that URL is theirs and must survive untouched, so the migration has to
        // tell the two apart rather than treat any old settings file as managed.
        let manual = r#"{
            "soundEnabled": true, "soundVolume": 0.5,
            "autoCloseInterval": 15.0, "absenceInterval": 180.0,
            "activeIntegrations": [], "screen": "primary",
            "autostart": false, "hooksInstalled": false, "model": "opencode",
            "managedServer": false
        }"#;
        let parsed: Settings = serde_json::from_str(manual).expect("a manual-era settings file");
        assert_eq!(parsed.managed_server, Some(false));
    }

    #[test]
    fn the_port_to_start_on_comes_out_of_the_configured_url() {
        // The one source of truth for the port is the URL itself, so a URL and a
        // separately stored port cannot disagree about where the server goes.
        assert_eq!(port_of("http://127.0.0.1:4096"), Some(4096));
        assert_eq!(port_of("http://localhost:1234/"), Some(1234));
        // No port, no scheme, nonsense: refused rather than guessed, because
        // guessing here means starting a server somewhere nobody is looking.
        assert_eq!(port_of("http://127.0.0.1"), None);
        assert_eq!(port_of("127.0.0.1:4096"), None);
        assert_eq!(port_of("http://127.0.0.1:0"), None);
        assert_eq!(port_of(""), None);
    }

    #[test]
    fn the_managed_flag_is_not_written_back_out() {
        // One shot. If the key survived a save, the migration would run on every
        // launch and keep clearing a URL the person had since saved by hand —
        // the one way this could become destructive.
        let mut settings = Settings::default();
        settings.managed_server = Some(true);
        let json = serde_json::to_string(&settings).expect("settings serialise");
        assert!(
            !json.contains("managedServer"),
            "the migration marker leaked into settings.json: {json}"
        );
        // And a file without it reads back as "no opinion", which is what a fresh
        // install and every manual one now look like.
        assert_eq!(Settings::default().managed_server, None);
    }

    #[test]
    fn the_missing_cli_message_says_how_to_install_it() {
        let hint = install_hint();
        assert!(hint.contains("npm i -g opencode-ai"), "{hint}");
        // Never "unreachable": that reads like a bug in Piko rather than a
        // missing program.
        assert!(!hint.contains("unreachable"));
    }

    #[test]
    fn the_port_scan_only_answers_for_opencode_processes() {
        // No test can rely on what is running, so this only asserts the two
        // things that hold either way: no duplicate ports, and nothing invented
        // that could not be a real socket.
        let ports = listening_opencode_ports();
        let mut sorted = ports.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ports, sorted);
        assert!(ports.iter().all(|p| *p > 0));
    }

    #[test]
    fn a_process_name_comes_back_without_its_path() {
        // This process, whatever it is called. Windows sometimes refuses to name
        // the current process without extra rights, so absence is allowed.
        if let Some(name) = process_name(std::process::id()) {
            assert!(!name.contains('\\'), "{name}");
            assert!(!name.is_empty());
        }
    }

    /// The body OpenCode returns with HTTP 200 when the model call fails: no
    /// text parts, and the reason parked in `info.error`. Captured verbatim from
    /// a real reply, because this shape is what made a provider outage look like
    /// a dead chat room.
    fn failed_reply() -> Value {
        serde_json::json!({
            "info": {
                "role": "assistant",
                "providerID": "tokeen",
                "modelID": "z-ai/glm-5.3-free",
                "cost": 0,
                "tokens": { "input": 0, "output": 0 },
                "error": {
                    "name": "APIError",
                    "data": {
                        "message": "No available channel for model z-ai/glm-5.3-free \
                                    under group default (distributor)"
                    }
                }
            },
            "parts": []
        })
    }

    #[test]
    fn a_provider_failure_is_reported_rather_than_swallowed() {
        let why = reply_error(&failed_reply()).expect("the failure must be surfaced");
        // The reason OpenCode gave, not a generic "no answer".
        assert!(why.contains("No available channel"), "{why}");
        // And which model to go and fix, without opening the config first.
        assert!(why.contains("tokeen/z-ai/glm-5.3-free"), "{why}");
    }

    #[test]
    fn a_healthy_reply_reports_no_error() {
        let ok = serde_json::json!({
            "info": { "role": "assistant", "providerID": "anthropic", "modelID": "claude" },
            "parts": [{ "type": "text", "text": "hello" }]
        });
        assert_eq!(reply_error(&ok), None);
    }

    #[test]
    fn an_error_with_no_detail_still_says_something() {
        let bare = serde_json::json!({ "info": { "error": {} }, "parts": [] });
        assert_eq!(
            reply_error(&bare).as_deref(),
            Some("the model call failed with no detail")
        );
    }

    #[test]
    fn a_null_error_is_not_a_failure() {
        let v = serde_json::json!({
            "info": { "role": "assistant", "error": null },
            "parts": [{ "type": "text", "text": "hi" }]
        });
        assert_eq!(reply_error(&v), None);
    }

    #[test]
    fn the_chat_session_is_recognised_so_its_idle_is_not_a_finished_agent() {
        // The session Ask mode creates is held by `Chat`; its `session.idle` must
        // not be turned into the `Stop` hook that replaced the conversation with
        // a "Session finished" card.
        assert!(chat_session_matches(Some("ses_chat"), "ses_chat"));
    }

    #[test]
    fn other_sessions_are_still_watched() {
        // A task, or a VS Code session Piko did not start, must keep reporting.
        assert!(!chat_session_matches(Some("ses_chat"), "ses_task"));
        assert!(!chat_session_matches(Some("ses_chat"), ""));
    }

    #[test]
    fn nothing_is_the_chat_before_the_first_turn() {
        assert!(!chat_session_matches(None, "ses_chat"));
    }

    #[test]
    fn a_session_id_is_found_wherever_the_server_put_it() {
        // The agent path only ever reads the top level, which is why a chat turn's
        // text parts needed this: two of the three shapes bury it.
        let top = json!({ "sessionID": "ses_a", "messageID": "msg_a" });
        let in_info = json!({ "info": { "id": "msg_a", "sessionID": "ses_a" } });
        let in_part = json!({ "part": { "id": "prt_a", "sessionID": "ses_a" } });
        assert_eq!(part_session(&top), "ses_a");
        assert_eq!(part_session(&in_info), "ses_a");
        assert_eq!(part_session(&in_part), "ses_a");
        assert_eq!(part_session(&json!({ "messageID": "msg_a" })), "");
    }

    #[test]
    fn only_the_assistants_own_parts_are_the_reply() {
        // The prompt the person typed comes back as a text part under a `user`
        // message, so the message has to be recognised rather than assumed.
        let mut d = Draft::default();
        assert!(!d.accepts("msg_user"));
        d.assistant.insert("msg_bot".to_string());
        assert!(d.accepts("msg_bot"));
        assert!(!d.accepts("msg_user"));
    }

    #[test]
    fn the_reply_is_every_text_part_and_the_one_being_written() {
        // An answer with a tool call in the middle of it is several text parts,
        // and each one starts after a step-start.
        let mut d = Draft::default();
        d.assistant.insert("msg_bot".to_string());
        d.part.push_str("let me look");
        assert_eq!(d.text(), "let me look");

        let closed = std::mem::take(&mut d.part);
        d.done.push(closed);
        d.part.push_str("found it");
        assert_eq!(d.text(), "let me look\nfound it");
    }

    #[test]
    fn finishing_a_turn_returns_the_whole_reply_and_empties_the_draft() {
        let mut d = Draft::default();
        d.assistant.insert("msg_bot".to_string());
        d.part.push_str("hello");
        let first = std::mem::take(&mut d.part);
        d.done.push(first);
        d.part.push_str(" again");
        d.any = true;

        assert_eq!(d.finish(), "hello\n again");
        // Nothing carries into the next turn, or two answers run together.
        assert_eq!(d.text(), "");
        assert!(!d.any);
        assert!(d.done.is_empty());
    }

    #[test]
    fn a_turn_that_streamed_nothing_is_recognised_as_one() {
        // That is the case `last_reply` covers, so it must be visible here and not
        // be confused with a reply that is genuinely empty.
        let mut d = Draft::default();
        assert!(!d.any);
        d.any = true;
        assert_eq!(d.finish(), "");
        assert!(!d.any);
    }
}

#[test]
fn the_runnable_opencode_beats_the_posix_shim() {
    // npm puts four files in one directory: opencode, opencode.cmd,
    // opencode.ps1 and none of them an .exe. Picking the extensionless one
    // gives CreateProcess something that is not a program at all.
    assert_eq!(run_rank(std::path::Path::new("opencode.exe")), 0);
    assert_eq!(run_rank(std::path::Path::new("opencode.cmd")), 1);
    assert_eq!(run_rank(std::path::Path::new("opencode.bat")), 1);
    assert_eq!(run_rank(std::path::Path::new("opencode")), 2);
    assert!(
        run_rank(std::path::Path::new("opencode.exe"))
            < run_rank(std::path::Path::new("opencode.cmd"))
    );
    assert!(
        run_rank(std::path::Path::new("opencode.cmd")) < run_rank(std::path::Path::new("opencode"))
    );
}
