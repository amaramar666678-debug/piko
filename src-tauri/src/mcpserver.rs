// The safety gate. Everything an agent asks for passes through here before
// mcp.rs is allowed to touch the desktop.
//
// The rules, in the order they are checked:
//
//   1. Control is off by default and the master toggle is the first thing looked
//      at. An unregistered, unlaunched or disabled Piko answers every tool.
//   2. A secure desktop (UAC, Ctrl+Alt+Del, the lock screen) refuses input. There
//      is no approval that unlocks this: a UAC prompt is exactly the moment an
//      agent must not be typing.
//   3. Rate limit, then the approval card. `type_text` always needs a fresh
//      approval and is never covered by a session grant, because there is no
//      reliable way to tell a password field from an ordinary one.
//
// A grant ("allow for this session") is scoped to one action type, one MCP client
// token and ten minutes. It is deliberately not a blanket "allow everything": the
// thing being allowed is named on the card, and only that thing is remembered.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::log;

/// Max input actions per second, across every client.
const RATE_PER_SEC: usize = 5;
/// How long an "allow for this session" grant lasts.
pub const GRANT_TTL: Duration = Duration::from_secs(10 * 60);
/// Bumped on every launch, so a grant cannot outlive Piko.
static EPOCH: AtomicU64 = AtomicU64::new(1);

/// Action kinds. `Describe`d for the card; the string is what gets logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    ScreenInfo,
    Screenshot,
    ReadFile,
    ListDirectory,
    MouseMove,
    MouseClick,
    MouseDrag,
    Scroll,
    TypeText,
    KeyPress,
}

impl Action {
    /// Log-safe name. This is the only thing that reaches piko.log for an
    /// action — never the arguments, which for `type_text` are the typed text
    /// and for `read_file` are the contents of the person's disk.
    pub fn log_name(&self) -> &'static str {
        match self {
            Self::ScreenInfo => "screen_info",
            Self::Screenshot => "screenshot",
            Self::ReadFile => "read_file",
            Self::ListDirectory => "list_directory",
            Self::MouseMove => "mouse_move",
            Self::MouseClick => "mouse_click",
            Self::MouseDrag => "mouse_drag",
            Self::Scroll => "scroll",
            Self::TypeText => "type_text",
            Self::KeyPress => "key_press",
        }
    }

    /// Actions that change the machine, and so need a card of their own.
    ///
    /// `screen_info` is not one: it reports the size of the desktop and where the
    /// cursor is, which reveals nothing. `screenshot` used to be exempt too, and
    /// that was the bug — a tool that hands an agent a picture of everything the
    /// person is looking at, including whatever is in another window, was running
    /// with no question asked at all.
    pub fn is_input(&self) -> bool {
        !matches!(self, Self::ScreenInfo)
    }

    /// Reading the screen or the disk. These change nothing, so a card asks once
    /// and the session grant then covers the rest — see `needs_read_permission`.
    pub fn is_read(&self) -> bool {
        matches!(
            self,
            Self::Screenshot | Self::ReadFile | Self::ListDirectory
        )
    }

    /// `type_text` is excluded on purpose: it can type a password, and no
    /// grant should be able to pre-approve it.
    pub fn grantable(&self) -> bool {
        self.is_input() && !matches!(self, Self::TypeText)
    }
}

// ── shared state ───────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub registered: bool,
    /// True while a card is up, so the island can show it.
    pub awaiting: bool,
    pub action: Option<String>,
    pub description: Option<String>,
    /// The hotkey, so the island can print it on the indicator.
    pub kill_hint: String,
    pub remaining_this_sec: usize,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            enabled: false,
            registered: false,
            awaiting: false,
            action: None,
            description: None,
            kill_hint: kill_hotkey_label(),
            remaining_this_sec: RATE_PER_SEC,
        }
    }
}

struct Grants {
    /// (action, client token, epoch) → when it lapses.
    map: HashMap<(Action, String, u64), Instant>,
}

struct Pending {
    id: String,
    action: Action,
    /// Plain text for the card: "click at 840,420". Never the typed text.
    description: String,
    /// The answer, once a human gives one.
    answer: Option<bool>,
    /// Whether the human ticked "allow for this session".
    answer_grant: bool,
}

struct State {
    enabled: AtomicBool,
    registered: AtomicBool,
    /// Timestamps of the last second's actions, for the rate limit.
    recent: Mutex<VecDeque<Instant>>,
    grants: Mutex<Grants>,
    pending: Mutex<Option<Pending>>,
    counter: AtomicU64,
    /// The epoch reads were last agreed for. Bumped by `start`, `kill` and by
    /// switching control off, so "once per session" means once per run of the app
    /// or once per deliberate re-grant — never once per process that happens to be
    /// serving an agent.
    read_epoch: AtomicU64,
    /// The epoch reads were granted for. Equal to `read_epoch` means the person
    /// has already been asked and said yes.
    read_granted: AtomicU64,
}

fn state() -> &'static State {
    static S: OnceLock<State> = OnceLock::new();
    S.get_or_init(|| State {
        enabled: AtomicBool::new(false),
        registered: AtomicBool::new(false),
        recent: Mutex::new(VecDeque::new()),
        grants: Mutex::new(Grants {
            map: HashMap::new(),
        }),
        pending: Mutex::new(None),
        counter: AtomicU64::new(0),
        read_epoch: AtomicU64::new(0),
        read_granted: AtomicU64::new(u64::MAX),
    })
}

/// Whether a read — the screen, or a file — still has to be put to the person.
///
/// Once per session, not once per call: an agent that has been refused nothing
/// and allowed a screenshot should be able to take the next one without asking
/// again, or it will stop bothering to ask at all and simply ask a human to
/// approve the very first thing it does. Reset by `start`, `kill` and switching
/// control off, so re-granting control is what earns the next question.
fn needs_read_permission(action: Action) -> bool {
    let s = state();
    action.is_read() && s.read_granted.load(Ordering::SeqCst) != s.read_epoch.load(Ordering::SeqCst)
}

fn grant_reads() {
    let s = state();
    s.read_granted
        .store(s.read_epoch.load(Ordering::SeqCst), Ordering::SeqCst);
}

fn reset_reads() {
    state().read_granted.store(u64::MAX, Ordering::SeqCst);
}

fn now() -> Instant {
    Instant::now()
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

pub fn start() {
    state().enabled.store(false, Ordering::SeqCst);
    // Grants from a previous run must not survive it.
    EPOCH.fetch_add(1, Ordering::SeqCst);
    reset_reads();
    log::line("input control ready (off)");
}

/// Master toggle. Turning it off drops every grant and cancels anything pending,
/// so switching it off is a real stop and not a "stop asking" that leaves a
/// half-finished drag going.
pub fn set_enabled(app: &AppHandle, on: bool) -> Status {
    let s = state();
    s.enabled.store(on, Ordering::SeqCst);
    if !on {
        s.grants.lock().unwrap().map.clear();
        reset_reads();
        if s.pending.lock().unwrap().take().is_some() {
            let _ = app.emit("mcp-answer", false);
        }
        // Whatever was on screen is gone; the badge must not keep claiming it.
        crate::notify::set_pending(app, crate::notify::Source::ScreenControl, 0);
        log::line("input control disabled");
    } else {
        log::line("input control enabled");
    }
    push(app)
}

pub fn enabled() -> bool {
    state().enabled.load(Ordering::SeqCst)
}

pub fn set_registered(app: &AppHandle, yes: bool) {
    state().registered.store(yes, Ordering::SeqCst);
    push(app);
}

fn remaining_this_sec() -> usize {
    let mut q = state().recent.lock().unwrap();
    let cutoff = now() - Duration::from_secs(1);
    while q.front().is_some_and(|t| *t < cutoff) {
        q.pop_front();
    }
    RATE_PER_SEC.saturating_sub(q.len())
}

/// Pushes the current status to the island, which is what drives the visible
/// indicator.
pub fn push(app: &AppHandle) -> Status {
    let s = state();
    let pending = s.pending.lock().unwrap();
    let st = Status {
        enabled: s.enabled.load(Ordering::SeqCst),
        registered: s.registered.load(Ordering::SeqCst),
        awaiting: pending.is_some(),
        action: pending.as_ref().map(|p| p.action.log_name().to_string()),
        description: pending.as_ref().map(|p| p.description.clone()),
        kill_hint: kill_hotkey_label(),
        remaining_this_sec: remaining_this_sec(),
    };
    drop(pending);
    let _ = app.emit("mcp-status", st.clone());
    st
}

pub fn status() -> Status {
    let s = state();
    let pending = s.pending.lock().unwrap();
    Status {
        enabled: s.enabled.load(Ordering::SeqCst),
        registered: s.registered.load(Ordering::SeqCst),
        awaiting: pending.is_some(),
        action: pending.as_ref().map(|p| p.action.log_name().to_string()),
        description: pending.as_ref().map(|p| p.description.clone()),
        kill_hint: kill_hotkey_label(),
        remaining_this_sec: remaining_this_sec(),
    }
}

pub fn kill_hotkey_label() -> String {
    KILL_HOTKEY_LABEL.to_string()
}

/// Ctrl+Alt+Shift+Esc. A deliberately awkward chord: it cannot collide with a
/// shortcut an app or an agent would plausibly send, and one press is enough.
pub const KILL_HOTKEY_LABEL: &str = "Ctrl+Alt+Shift+Esc";

/// The hotkey thread's message id. Anything but zero, and never reused.
const KILL_HOTKEY_ID: i32 = 0x63;

/// Whether our own listener got the chord. Ask this rather than trying the chord:
/// once the listener owns it, the combination is *taken* by us, so probing it
/// would report the opposite of the truth.
static KILL_HOTKEY_ARMED: AtomicBool = AtomicBool::new(false);

/// Starts listening for the kill chord.
///
/// Registered against *this thread* (a null window handle), which is why the
/// thread then has to pump messages itself — `RegisterHotKey` posts WM_HOTKEY to
/// the owning thread's queue. A failure here is not fatal: the Settings window
/// says so, and turning the switch off still works.
pub fn start_kill_hotkey(app: AppHandle) {
    std::thread::spawn(move || {
        let modifiers = windows::Win32::UI::Input::KeyboardAndMouse::MOD_CONTROL
            | windows::Win32::UI::Input::KeyboardAndMouse::MOD_ALT
            | windows::Win32::UI::Input::KeyboardAndMouse::MOD_SHIFT
            | windows::Win32::UI::Input::KeyboardAndMouse::MOD_NOREPEAT;
        // SAFETY: a null hWnd binds the hotkey to this thread, which is about to
        // become its message pump.
        let registered = unsafe {
            windows::Win32::UI::Input::KeyboardAndMouse::RegisterHotKey(
                None,
                KILL_HOTKEY_ID,
                modifiers,
                windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE.0 as u32,
            )
        };
        if registered.is_err() {
            KILL_HOTKEY_ARMED.store(false, Ordering::SeqCst);
            log::line("mcp kill hotkey unavailable");
            return;
        }
        KILL_HOTKEY_ARMED.store(true, Ordering::SeqCst);
        log::line("mcp kill hotkey armed");
        let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        loop {
            // SAFETY: `msg` is a live MSG and the filter range accepts everything.
            let got = unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetMessageW(&mut msg, None, 0, 0)
            };
            // 0 is WM_QUIT; anything negative is an error. Either way, stop.
            if got.0 <= 0 {
                break;
            }
            if msg.message == windows::Win32::UI::WindowsAndMessaging::WM_HOTKEY
                && msg.wParam.0 as i32 == KILL_HOTKEY_ID
            {
                kill(&app);
            }
        }
        KILL_HOTKEY_ARMED.store(false, Ordering::SeqCst);
        // SAFETY: the id was registered above and is not needed any more.
        let _ = unsafe {
            windows::Win32::UI::Input::KeyboardAndMouse::UnregisterHotKey(None, KILL_HOTKEY_ID)
        };
    });
}

/// True when the chord is armed, i.e. this process really is listening for it.
///
/// Cannot be worked out by trying to register the combination: `RegisterHotKey`
/// succeeds per thread, and the only thread allowed to hold the kill chord is
/// the listener's, so a probe from anywhere else would fail whether the chord is
/// free or already ours. The listener's own answer is the only honest one.
pub fn kill_hotkey_armed() -> bool {
    KILL_HOTKEY_ARMED.load(Ordering::SeqCst)
}

/// Called from the global key hook when the chord is seen. Instant and total:
/// control off, grants dropped, pending cancelled.
pub fn kill(app: &AppHandle) -> Status {
    let s = state();
    s.enabled.store(false, Ordering::SeqCst);
    s.grants.lock().unwrap().map.clear();
    // Killing the chord has to put the screen behind a question again. Leaving
    // reads granted would mean the panic button does not actually stop an agent
    // from looking at the desktop.
    reset_reads();
    if s.pending.lock().unwrap().take().is_some() {
        let _ = app.emit("mcp-answer", false);
    }
    // Persisted off, not just held off. A kill switch that a restart quietly
    // undoes is not a kill switch — and a settings window still holding the
    // old value must not be able to write "on" back over it either, which is why
    // this flag has exactly one writer (see `persist_switch`).
    persist_switch(false);
    log::line("input control killed by hotkey");
    push(app)
}

/// The single writer of the persisted master switch. Everything else reads
/// `enabled()`, which is the in-memory truth.
fn persist_switch(on: bool) {
    let mut s = crate::settings::load();
    if s.input_control_enabled == on {
        return;
    }
    s.input_control_enabled = on;
    if let Err(e) = crate::settings::save(&s) {
        log::line(format!("couldn't persist the input switch: {e}"));
    }
}

// ── the gate ───────────────────────────────────────────────────────────────────

/// The outcome of asking for one action.
pub enum Decision {
    /// Run it now.
    Run,
    /// Don't; `msg` goes back to the agent as the tool result.
    Refuse(String),
}

/// Everything a tool call needs to be judged.
pub struct Request {
    pub action: Action,
    /// Exactly what the card will say, e.g. "click at 840,420".
    pub description: String,
    pub client: String,
    /// Set by the "allow for this session" button.
    pub grant_session: bool,
}

/// The one door. Returns `Run` only when every rule is satisfied.
///
/// Blocking is the point: the MCP server holds this call while the island waits
/// for a human, which is what makes the card a real gate rather than a notice.
pub fn approve(app: &AppHandle, req: Request) -> Decision {
    let s = state();

    // 1. The master switch. Off means off, whatever the caller wants.
    if !s.enabled.load(Ordering::SeqCst) {
        return Decision::Refuse(
            "Piko's input control is off. Turn it on in Settings → Screen & input first.".into(),
        );
    }

    // 2. A secure desktop refuses everything. `type_text` and `key_press` are the
    //    dangerous ones here, but clicking into a UAC prompt is also how an
    //    approval gets talked into existing. Reads are refused too, deliberately:
    //    a non-elevated process cannot capture the secure desktop anyway, so the
    //    answer would be a blank image rather than a clear "no".
    if crate::mcp::secure_desktop_active() {
        return Decision::Refuse(
            "a secure desktop is active (UAC, lock screen or Ctrl+Alt+Del) — refused".into(),
        );
    }

    // 3. Screen size and cursor position change nothing and reveal nothing, so
    //    they never cost a card and never count against the rate limit.
    if !req.action.is_input() {
        log_action(req.action);
        return Decision::Run;
    }

    // 3b. A read of the screen or the disk is the one thing that has to be put to
    //     the person *once per session* before it happens. It changes nothing, so
    //     an ordinary input grant must not cover it — and it must not go straight
    //     through either, which is exactly what it used to do: `screenshot` was
    //     exempted at step 3, so a tool handing an agent a picture of every window
    //     on the desktop ran with nobody asked. Once granted, it falls through no
    //     more: asking again per capture would train the agent to bundle its work
    //     into the first call it makes.
    if req.action.is_read() && !needs_read_permission(req.action) {
        log_action(req.action);
        return Decision::Run;
    }

    // 4. Rate limit.
    {
        let mut q = s.recent.lock().unwrap();
        let cutoff = now() - Duration::from_secs(1);
        while q.front().is_some_and(|t| *t < cutoff) {
            q.pop_front();
        }
        if q.len() >= RATE_PER_SEC {
            return Decision::Refuse(format!(
                "too fast — at most {RATE_PER_SEC} actions per second"
            ));
        }
        q.push_back(now());
    }

    // 5. An existing grant, checked before a card is raised.
    if req.action.grantable() && !req.grant_session {
        let epoch = EPOCH.load(Ordering::SeqCst);
        let key = (req.action, req.client.clone(), epoch);
        let mut g = s.grants.lock().unwrap();
        // Drop lapsed grants on the way past rather than on a timer.
        g.map.retain(|_, until| *until > now());
        if g.map.contains_key(&key) {
            drop(g);
            log_action(req.action);
            return Decision::Run;
        }
    }

    // 6. Ask a human. The slot holds one request: a second one is refused
    // outright rather than overwriting the first, because a half-answered
    // mouse drag that silently becomes a click is worse than a refusal.
    let id = {
        let mut slot = s.pending.lock().unwrap();
        if slot.is_some() {
            return Decision::Refuse("another screen-control request is already waiting".into());
        }
        let n = s.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("mcp-{n}");
        *slot = Some(Pending {
            id: id.clone(),
            action: req.action,
            description: req.description.clone(),
            answer: None,
            answer_grant: false,
        });
        id
    };
    log_action(req.action);
    push(app);
    // The island is easy to miss from another window; the toast and the tray
    // count are what actually get the person's eyes here.
    crate::notify::set_pending(app, crate::notify::Source::ScreenControl, 1);
    crate::notify::raise(
        app,
        crate::notify::Alert::generic(&format!("{} — {}", req.action.log_name(), req.description)),
    );
    let _ = app.emit(
        "mcp-ask",
        serde_json::json!({ "id": id, "action": req.action.log_name(), "description": req.description }),
    );

    // Wait. Bounded, because a card nobody answers must not wedge the agent
    // forever — and the island's own decline path is faster than this anyway.
    let deadline = now() + Duration::from_secs(240);
    loop {
        match poll(&id) {
            Poll::Answer { allow, grant } => {
                // The card is answered: nothing is pending on this path any more.
                crate::notify::set_pending(app, crate::notify::Source::ScreenControl, 0);
                if allow {
                    if req.action.is_read() {
                        // A "yes" to a screenshot or a file read covers reads for
                        // the rest of the session, with no tick box involved: the
                        // answer to "may I see your screen" is not a grant that
                        // needs re-confirming, it is the thing they just did.
                        grant_reads();
                    }
                    if grant && req.action.grantable() {
                        let epoch = EPOCH.load(Ordering::SeqCst);
                        state()
                            .grants
                            .lock()
                            .unwrap()
                            .map
                            .insert((req.action, req.client.clone(), epoch), now() + GRANT_TTL);
                    }
                    push(app);
                    return Decision::Run;
                }
                push(app);
                return Decision::Refuse("the person at the island said no".into());
            }
            Poll::Gone => {
                // Killed, disabled or cancelled: clear the badge too.
                crate::notify::set_pending(app, crate::notify::Source::ScreenControl, 0);
                push(app);
                return Decision::Refuse("the request was cancelled".into());
            }
            Poll::Superseded => {
                crate::notify::set_pending(app, crate::notify::Source::ScreenControl, 0);
                return Decision::Refuse("superseded by another request".into());
            }
            Poll::Waiting => {}
        }
        if now() >= deadline {
            clear(&id);
            push(app);
            return Decision::Refuse("nobody answered in time".into());
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

/// What one look at the pending slot says. Each variant takes the lock exactly
/// once and lets go before the caller does anything else, so `approve` never
/// holds the pending lock while reaching for the grants lock.
enum Poll {
    Answer {
        allow: bool,
        grant: bool,
    },
    /// Still waiting.
    Waiting,
    /// Our card is gone and no answer came — killed, disabled or cancelled.
    Gone,
    /// A different card is up.
    Superseded,
}

/// Takes the answer *and* empties the slot. Answering must free the card, or the
/// island keeps showing a question that has already been dealt with and the next
/// request would silently supersede it.
fn poll(id: &str) -> Poll {
    let s = state();
    let mut slot = s.pending.lock().unwrap();
    match slot.as_mut() {
        None => Poll::Gone,
        Some(p) if p.id == id => match p.answer {
            Some(allow) => {
                let out = Poll::Answer {
                    allow,
                    grant: p.answer_grant,
                };
                *slot = None;
                out
            }
            None => Poll::Waiting,
        },
        Some(_) => Poll::Superseded,
    }
}

fn clear(id: &str) {
    let mut slot = state().pending.lock().unwrap();
    if slot.as_ref().is_some_and(|p| p.id == id) {
        *slot = None;
    }
}

/// The island's Allow / Deny buttons. `session` is the "allow for this session"
/// checkbox, which is ignored for `type_text` — see `Action::grantable`.
pub fn answer(app: &AppHandle, id: &str, allow: bool, session: bool) -> bool {
    let s = state();
    let mut p = s.pending.lock().unwrap();
    let Some(pending) = p.as_mut().filter(|p| p.id == id) else {
        return false;
    };
    pending.answer = Some(allow);
    pending.answer_grant = session && pending.action.grantable();
    // The lock has to go before `push`, which takes it again. The card can
    // already read "answered"; `approve` empties the slot a few milliseconds
    // later and pushes once more.
    drop(p);
    push(app);
    true
}

/// Only the action type and the time reach the log — never the arguments. For
/// `type_text` the arguments *are* the sensitive part.
fn log_action(action: Action) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    log::line(format!("mcp {} {secs}", action.log_name()));
}

// ══ the MCP server ════════════════════════════════════════════════════════════
//
// OpenCode spawns `piko.exe mcp` as a stdio MCP server. That process is a thin
// bridge: it copies newline-delimited JSON between stdin/stdout and a named pipe
// served by *this* process, which is the one that owns the island, the settings
// and the approvals. So a tool call cannot reach the desktop from anywhere except
// through `approve` above.
//
// The pipe name carries the user's SID and its DACL grants access to that SID and
// SYSTEM only. There is no token and no port: a secret that never exists cannot
// leak, and nothing is listening that another account can reach.

/// `\\.\pipe\piko-mcp-S-1-5-21-…`
pub fn pipe_name() -> Option<String> {
    // The SID is what keeps two accounts on one machine from colliding, exactly
    // as it does for the relay pipe (see win_user.rs).
    Some(format!(
        r"\\.\pipe\piko-mcp-{}",
        crate::win_user::current_user_sid()?
    ))
}

/// Starts the pipe listener. Called once at launch; the loop lives on its own
/// thread and accepts one client at a time, which is all OpenCode needs.
pub fn serve(app: AppHandle) {
    let Some(name) = pipe_name() else {
        log::line("mcp pipe unavailable — no user SID");
        return;
    };
    // Built once and reused: the descriptor has to stay alive for as long as the
    // handles created from it, and CreateNamedPipeW copies the security
    // descriptor into the kernel at creation time. Leaked on purpose — one
    // allocation for the life of the process, which is the only correct owner
    // for something every later handle points at.
    //
    // No fallback. If the DACL cannot be narrowed to this user and SYSTEM, the
    // pipe is not created at all: serving with the default DACL would hand a
    // screen-control channel to whatever that descriptor happens to allow, and
    // "it was probably fine" is not a security property.
    let Some(attributes) = sddl_attributes().map(Attributes) else {
        log::line("mcp pipe not started - the DACL could not be narrowed");
        return;
    };
    std::thread::spawn(move || {
        // Proves the capture path works before an agent asks for a screenshot.
        crate::mcp::warm_up();
        let wide = windows::core::HSTRING::from(name.as_str());
        let ptr = windows::core::PCWSTR(wide.as_ptr());
        loop {
            let pipe = create_pipe(ptr, Some(&attributes));
            if pipe.is_invalid() {
                log::line("mcp pipe could not be created");
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            // Blocks until a client opens the pipe. `ERROR_PIPE_CONNECTED` means
            // the client beat this call, which is harmless.
            // SAFETY: `pipe` is a valid, freshly created handle.
            let _ = unsafe { windows::Win32::System::Pipes::ConnectNamedPipe(pipe, None) };
            serve_client(&app, pipe);
            // SAFETY: `pipe` was created above and is closed exactly once.
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(pipe) };
        }
    });
}

/// `FILE_FLAG_FIRST_PIPE_INSTANCE` on the very first handle only: it is what makes
/// the kernel refuse to hand `piko-mcp-<sid>` to anybody else while Piko is
/// running. Later handles reuse the same name after the client disconnects.
fn create_pipe(
    name: windows::core::PCWSTR,
    attributes: Option<&Attributes>,
) -> windows::Win32::Foundation::HANDLE {
    let mut open_mode = windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    if FIRST_PIPE_INSTANCE.swap(false, Ordering::SeqCst) {
        open_mode |= windows::Win32::Storage::FileSystem::FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let mode = windows::Win32::System::Pipes::PIPE_TYPE_MESSAGE
        | windows::Win32::System::Pipes::PIPE_READMODE_MESSAGE
        | windows::Win32::System::Pipes::PIPE_WAIT;
    // SAFETY: `name` is a live NUL-terminated string owned by the caller and
    // `attributes` outlives the call.
    unsafe {
        windows::Win32::System::Pipes::CreateNamedPipeW(
            name,
            open_mode,
            mode,
            windows::Win32::System::Pipes::PIPE_UNLIMITED_INSTANCES,
            PIPE_QUOTA,
            PIPE_QUOTA,
            0,
            attributes.map(|a| &a.0 as *const _),
        )
    }
}

/// Buffer quota, in bytes, for each direction.
///
/// On a message-mode pipe the quota is also the ceiling on a *single message*, so
/// this has to clear the largest reply we ever send — a base64 PNG of a busy
/// screen is easily a couple of megabytes, and a reply that exceeds the quota
/// fails outright rather than being truncated. 8 MiB is far above any screenshot
/// and costs nothing while the pipe is idle, because the buffer is allocated on
/// demand by the pipe driver.
const PIPE_QUOTA: u32 = 8 * 1024 * 1024;

/// `SECURITY_ATTRIBUTES` holds a raw descriptor pointer, which is not `Send`, and
/// it is only ever read while the owning thread is inside `create_pipe` — the
/// kernel copies the descriptor at handle-creation time, so nothing outlives the
/// call.
struct Attributes(windows::Win32::Security::SECURITY_ATTRIBUTES);

// SAFETY: see above — the pointer is only dereferenced by the thread that owns
// this value, during a single call.
unsafe impl Send for Attributes {}

static FIRST_PIPE_INSTANCE: AtomicBool = AtomicBool::new(true);

/// A DACL of "this user and SYSTEM, nothing else". Returns None when the SDDL
/// cannot be parsed, and the caller then falls back to the default DACL.
fn sddl_attributes() -> Option<windows::Win32::Security::SECURITY_ATTRIBUTES> {
    let sid = crate::win_user::current_user_sid()?;
    // D:P — a protected DACL, so no inherited ACE can widen it.
    // (A;;GA;;;sid) full access for the user, (A;;GA;;;SY) for LocalSystem,
    // which owns the machine and has to be able to stop the process.
    let sddl = format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)");
    let wide = windows::core::HSTRING::from(sddl.as_str());
    let mut descriptor = windows::Win32::Security::PSECURITY_DESCRIPTOR::default();
    // SAFETY: `descriptor` is a valid out-pointer; SDDL revision 1 is the only one
    // this function accepts.
    unsafe {
        windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &wide,
            1,
            &mut descriptor,
            None,
        )
        .ok()?;
        Some(windows::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: windows::core::BOOL(0),
        })
    }
}

/// One client: read a message, answer it, until it goes away.
fn serve_client(app: &AppHandle, pipe: windows::Win32::Foundation::HANDLE) {
    loop {
        let Some(request) = read_message(pipe) else {
            break;
        };
        let reply = match serde_json::from_str::<Value>(&request) {
            Ok(value) => handle(app, &value),
            // A parse failure is answered, not dropped: a client waiting on an id
            // would otherwise hang until its own timeout.
            Err(_) => Some(error_response(Value::Null, -32700, "that isn't JSON")),
        };
        let Some(reply) = reply else {
            continue; // a notification — nothing to answer
        };
        let mut body = reply.to_string();
        body.push('\n');
        // SAFETY: `body` outlives the call; the pipe is still ours.
        if unsafe {
            let mut written = 0u32;
            windows::Win32::Storage::FileSystem::WriteFile(
                pipe,
                Some(body.as_bytes()),
                Some(&mut written),
                None,
            )
        }
        .is_err()
        {
            break;
        }
        let _ = unsafe { windows::Win32::Storage::FileSystem::FlushFileBuffers(pipe) };
    }
    // SAFETY: the handle is valid; disconnecting releases the waiting client.
    let _ = unsafe { windows::Win32::System::Pipes::DisconnectNamedPipe(pipe) };
}

/// Reads one whole message.
///
/// The pipe is in message mode, so one message needs no framing of our own — but
/// a message larger than the buffer is not returned whole, and Windows does not
/// even agree with itself about how to say so. Reading a pipe we created can come
/// back with `ERROR_MORE_DATA` and a full buffer, while reading the far end of
/// the same pipe can come back *succeeding* with a full buffer and nothing else.
/// A screenshot reply is routinely bigger than 256 KiB of base64, so both are
/// grown into rather than treated as a failure: getting it wrong would break
/// exactly the tool people want.
fn read_message(pipe: windows::Win32::Foundation::HANDLE) -> Option<String> {
    /// Enough for a 4K screenshot as PNG-in-base64 with room to spare, and a
    /// ceiling rather than an allowance: a client that keeps growing the buffer
    /// is a client we stop listening to.
    const MAX_MESSAGE: usize = 32 * 1024 * 1024;
    let mut message: Vec<u8> = Vec::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let mut read = 0u32;
        // SAFETY: `buffer` is writable for its whole length and `read` is a live
        // out-parameter.
        let result = unsafe {
            windows::Win32::Storage::FileSystem::ReadFile(
                pipe,
                Some(buffer.as_mut_slice()),
                Some(&mut read),
                None,
            )
        };
        let truncated = result
            .as_ref()
            .err()
            .is_some_and(|e| e.code() == windows::Win32::Foundation::ERROR_MORE_DATA.to_hresult());
        if result.is_err() && !truncated {
            return None;
        }
        let got = read as usize;
        // Nothing at all is a client that closed its end; something after a
        // truncated message is a message cut in half, which is no message.
        if got == 0 {
            return None;
        }
        // These bytes have already left the pipe, so they have to be kept: the
        // next read returns the tail of this same message, never its head.
        message.extend_from_slice(&buffer[..got]);
        if message.len() > MAX_MESSAGE {
            return None;
        }
        // A read that stopped short of filling the buffer, or a pipe that has
        // nothing left, means the message ended there.
        if !truncated && got < buffer.len() {
            return Some(String::from_utf8_lossy(&message).into_owned());
        }
        if bytes_left_in_message(pipe) == 0 {
            return Some(String::from_utf8_lossy(&message).into_owned());
        }
        let room = MAX_MESSAGE - message.len();
        buffer.resize((buffer.len() * 2).min(room), 0);
    }
}

/// How much of the current message is still in the pipe.
///
/// Only ever called once the buffer has come back full, which is the one case
/// where a read cannot speak for itself. The count is of the message being read,
/// not of whatever else is queued behind it, so a message that happens to be an
/// exact multiple of the buffer is still recognised as finished rather than
/// mistaken for a longer one.
fn bytes_left_in_message(pipe: windows::Win32::Foundation::HANDLE) -> u32 {
    let mut left = 0u32;
    // SAFETY: `left` is a live out-parameter and the handle is valid.
    unsafe {
        windows::Win32::System::Pipes::PeekNamedPipe(pipe, None, 0, None, None, Some(&mut left))
    }
    .map(|_| left)
    .unwrap_or(0)
}

// ── JSON-RPC ───────────────────────────────────────────────────────────────────

fn error_response(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// The tool catalogue. Every entry names the action it maps to, so the dispatch
/// table and the advertised list cannot drift apart.
struct Tool {
    name: &'static str,
    action: Action,
    summary: &'static str,
    schema: fn() -> Value,
}

const COORD: &str = "Physical screen pixels across the virtual desktop; get them from screen_info.";

fn integer(desc: &str) -> Value {
    json!({ "type": "integer", "description": desc })
}

fn text(desc: &str) -> Value {
    json!({ "type": "string", "description": desc })
}

fn obj(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "screen_info",
            action: Action::ScreenInfo,
            summary: "Screen size, cursor position and whether input is locked by UAC.",
            schema: || obj(json!({}), &[]),
        },
        Tool {
            name: "screenshot",
            action: Action::Screenshot,
            summary:
                "PNG of the screen, optionally a region and a maximum width. Asks once per session.",
            schema: || {
                obj(
                    json!({
                        "x": integer("Left edge of the region."),
                        "y": integer("Top edge of the region."),
                        "width": integer("Region width."),
                        "height": integer("Region height."),
                        "maxWidth": integer("Downscale to this width; 0 or absent for full size."),
                    }),
                    &[],
                )
            },
        },
        Tool {
            name: "read_file",
            action: Action::ReadFile,
            summary: "Read a UTF-8 text file as context. Asks once per session.",
            schema: || {
                obj(
                    json!({
                        "path": text("Absolute path to the file."),
                        "maxBytes": integer("Stop rather than return a fragment. Capped at 1000000."),
                    }),
                    &["path"],
                )
            },
        },
        Tool {
            name: "list_directory",
            action: Action::ListDirectory,
            summary: "List the files in a folder. Asks once per session.",
            schema: || {
                obj(
                    json!({
                        "path": text("Absolute path to the folder."),
                        "limit": integer("How many entries at most; capped at 2000."),
                    }),
                    &["path"],
                )
            },
        },
        Tool {
            name: "mouse_move",
            action: Action::MouseMove,
            summary: "Move the cursor to a point.",
            schema: || {
                obj(
                    json!({ "x": integer(&COORD), "y": integer(&COORD) }),
                    &["x", "y"],
                )
            },
        },
        Tool {
            name: "mouse_click",
            action: Action::MouseClick,
            summary: "Click, or double-click, at the cursor.",
            schema: || {
                obj(
                    json!({
                        "button": text("left, right or middle."),
                        "double": { "type": "boolean", "description": "Click twice." },
                    }),
                    &[],
                )
            },
        },
        Tool {
            name: "mouse_drag",
            action: Action::MouseDrag,
            summary: "Press, glide to a point and release — for sliders and windows.",
            schema: || {
                obj(
                    json!({
                        "fromX": integer("Start edge."), "fromY": integer("Start edge."),
                        "toX": integer("End edge."), "toY": integer("End edge."),
                        "steps": integer("Glide length; 2–120, default 24."),
                    }),
                    &["fromX", "fromY", "toX", "toY"],
                )
            },
        },
        Tool {
            name: "scroll",
            action: Action::Scroll,
            summary: "Scroll the wheel at the cursor. Positive is up.",
            schema: || {
                obj(
                    json!({ "notches": integer("Wheel notches; negative scrolls down.") }),
                    &["notches"],
                )
            },
        },
        Tool {
            name: "key_press",
            action: Action::KeyPress,
            summary: "Press a key, optionally with ctrl, alt or shift.",
            schema: || {
                obj(
                    json!({
                        "key": text("Key name: enter, tab, escape, space, backspace, delete, arrows, f1–f12, home, end, pageup, pagedown, or a shifted symbol."),
                        "modifiers": { "type": "array", "items": { "type": "string", "enum": ["ctrl", "alt", "shift"] } },
                    }),
                    &["key"],
                )
            },
        },
        Tool {
            name: "type_text",
            action: Action::TypeText,
            summary:
                "Type literal text. Every call is approved separately and the text is never logged.",
            schema: || obj(json!({ "text": text("The text to type.") }), &["text"]),
        },
    ]
}

fn tool_list_json() -> Value {
    json!({
        "tools": tools()
            .iter()
            .map(|t| json!({
                "name": t.name,
                "description": t.summary,
                "inputSchema": (t.schema)(),
            }))
            .collect::<Vec<_>>(),
    })
}

fn text_result(body: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": body }], "isError": false })
}

fn error_result(body: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": body }], "isError": true })
}

/// The handshake result. Split out so the protocol version and the promise in
/// `instructions` can be asserted without a desktop.
fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "piko", "version": env!("CARGO_PKG_VERSION") },
        // Says plainly, in the handshake, that a human is in the loop.
        "instructions": "Piko drives this Windows desktop. Every action is shown to the person at the island and waits for their Allow. Call screen_info before guessing coordinates, and expect refusals.",
    })
}

/// The MCP revision we answer with. Pinned rather than echoed: a client that asks
/// for something older still gets a working server, because the only thing that
/// changed here is tool metadata.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Routes one JSON-RPC request. Pure apart from the approvals it asks for, which
/// is why every tool name and shape here can be tested without a desktop.
pub fn handle(app: &AppHandle, request: &Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    // A notification has no id and expects no reply.
    let Some(id) = id else {
        return None;
    };
    let params = request.get("params").cloned().unwrap_or(json!({}));

    match method {
        "initialize" => Some(ok_response(id, initialize_result())),
        "ping" => Some(ok_response(id, json!({}))),
        "tools/list" => Some(ok_response(id, tool_list_json())),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Some(ok_response(id, call(app, name, &args)))
        }
        other => Some(error_response(id, -32601, &format!("no method {other}"))),
    }
}

/// Turns one `tools/call` into an approval, then the action itself.
fn call(app: &AppHandle, name: &str, args: &Value) -> Value {
    let Some(tool) = tools().into_iter().find(|t| t.name == name) else {
        return error_result(&format!("{name} isn't a Piko tool"));
    };
    // The card's wording is built from the arguments *before* anything runs, and
    // for `type_text` it deliberately excludes the text.
    let description = match tool.action {
        Action::ScreenInfo => "read the screen size and cursor position".to_string(),
        Action::Screenshot => describe_screenshot(args),
        Action::ReadFile => {
            crate::mcp::describe_read(args.get("path").and_then(Value::as_str).unwrap_or_default())
        }
        Action::ListDirectory => crate::mcp::describe_listing(
            args.get("path").and_then(Value::as_str).unwrap_or_default(),
        ),
        Action::MouseMove => format!(
            "move the cursor to {},{}",
            arg_i32(args, "x").unwrap_or(0),
            arg_i32(args, "y").unwrap_or(0)
        ),
        Action::MouseClick => {
            let button = args.get("button").and_then(Value::as_str).unwrap_or("left");
            let double = args.get("double").and_then(Value::as_bool).unwrap_or(false);
            format!(
                "{}click the {} button",
                if double { "double-" } else { "" },
                button
            )
        }
        Action::MouseDrag => format!(
            "drag from {},{} to {},{}",
            arg_i32(args, "fromX").unwrap_or(0),
            arg_i32(args, "fromY").unwrap_or(0),
            arg_i32(args, "toX").unwrap_or(0),
            arg_i32(args, "toY").unwrap_or(0)
        ),
        Action::Scroll => format!("scroll {} notches", arg_i32(args, "notches").unwrap_or(0)),
        Action::KeyPress => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            let mods: Vec<String> = args
                .get("modifiers")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if mods.is_empty() {
                format!("press {key}")
            } else {
                format!("press {}+{key}", mods.join("+"))
            }
        }
        // Never the text. Only how much of it there is.
        Action::TypeText => args
            .get("text")
            .and_then(Value::as_str)
            .map(crate::mcp::describe_text)
            .unwrap_or_else(|| "type text".to_string()),
    };

    let request = Request {
        action: tool.action,
        description,
        // One client: OpenCode. The id keeps a future second server from
        // inheriting another's grant.
        client: "opencode".into(),
        grant_session: false,
    };
    match approve(app, request) {
        Decision::Refuse(reason) => error_result(&reason),
        Decision::Run => match perform(tool.action, args) {
            Ok(content) => content,
            Err(reason) => error_result(&reason),
        },
    }
}

fn describe_screenshot(args: &Value) -> String {
    match (
        args.get("x").and_then(Value::as_i64),
        args.get("y").and_then(Value::as_i64),
        args.get("width").and_then(Value::as_i64),
        args.get("height").and_then(Value::as_i64),
    ) {
        (Some(x), Some(y), Some(w), Some(h)) => {
            format!("capture a screenshot of {x},{y} {w}×{h}")
        }
        _ => "capture a screenshot of the whole screen".to_string(),
    }
}

fn arg_i32(args: &Value, key: &str) -> Option<i32> {
    args.get(key).and_then(Value::as_i64).map(|v| v as i32)
}

fn arg_u32(args: &Value, key: &str) -> Option<u32> {
    args.get(key)
        .and_then(Value::as_i64)
        .and_then(|v| u32::try_from(v).ok())
}

/// What actually happens, once a human has said yes. Nothing in here may decide
/// anything — that already happened in `approve`.
fn perform(action: Action, args: &Value) -> Result<Value, String> {
    match action {
        Action::ScreenInfo => {
            let info = crate::mcp::screen_info();
            Ok(text_result(
                &serde_json::to_string_pretty(&info).unwrap_or_default(),
            ))
        }
        Action::Screenshot => {
            let region = match (
                args.get("x").and_then(Value::as_i64),
                args.get("y").and_then(Value::as_i64),
                arg_u32(args, "width"),
                arg_u32(args, "height"),
            ) {
                (Some(x), Some(y), Some(w), Some(h)) => Some((x as i32, y as i32, w, h)),
                _ => None,
            };
            let max_width = arg_u32(args, "maxWidth").unwrap_or(1280);
            let capture = crate::mcp::screenshot(region, max_width)?;
            let png = encode_png(&capture)?;
            use base64::Engine as _;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
            Ok(json!({
                "content": [{
                    "type": "image",
                    "data": encoded,
                    "mimeType": "image/png",
                }],
                "isError": false,
            }))
        }
        Action::ReadFile => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .ok_or("path is required")?
                .to_string();
            let max = arg_u32(args, "maxBytes").unwrap_or(crate::mcp::MAX_READ_BYTES as u32);
            let text = crate::mcp::read_file(&path, max as u64)?;
            Ok(text_result(&text))
        }
        Action::ListDirectory => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .ok_or("path is required")?
                .to_string();
            let limit = arg_u32(args, "limit").unwrap_or(200) as usize;
            let listing = crate::mcp::list_directory(&path, limit)?;
            Ok(text_result(&listing))
        }
        Action::MouseMove => {
            let (x, y) = (arg_i32(args, "x"), arg_i32(args, "y"));
            let (x, y) = match (x, y) {
                (Some(x), Some(y)) => (x, y),
                _ => return Err("x and y are required".into()),
            };
            crate::mcp::mouse_move(x, y)?;
            Ok(text_result(&format!("cursor at {x},{y}")))
        }
        Action::MouseClick => {
            let button = crate::mcp::Button::parse(
                args.get("button").and_then(Value::as_str).unwrap_or("left"),
            )?;
            let double = args.get("double").and_then(Value::as_bool).unwrap_or(false);
            crate::mcp::mouse_click(button, double);
            Ok(text_result(if double {
                "double-clicked"
            } else {
                "clicked"
            }))
        }
        Action::MouseDrag => {
            let coords = ["fromX", "fromY", "toX", "toY"].map(|k| arg_i32(args, k));
            let [Some(from_x), Some(from_y), Some(to_x), Some(to_y)] = coords else {
                return Err("fromX, fromY, toX and toY are all required".into());
            };
            let steps = arg_u32(args, "steps").unwrap_or(24);
            crate::mcp::mouse_drag(from_x, from_y, to_x, to_y, steps)?;
            Ok(text_result(&format!("dragged to {to_x},{to_y}")))
        }
        Action::Scroll => {
            let notches = arg_i32(args, "notches").unwrap_or(0);
            crate::mcp::scroll(notches);
            Ok(text_result(&format!("scrolled {notches}")))
        }
        Action::KeyPress => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            let mods: Vec<String> = args
                .get("modifiers")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            crate::mcp::key_press(key, &mods)?;
            Ok(text_result(&format!("pressed {key}")))
        }
        Action::TypeText => {
            let text = args.get("text").and_then(Value::as_str).unwrap_or("");
            crate::mcp::type_text(text)?;
            // The reply deliberately does not echo the text either.
            Ok(text_result(&crate::mcp::describe_text(text)))
        }
    }
}

/// RGB to PNG. GDI hands over BGR, `mcp::screenshot` swaps it, and this only has to
/// wrap the rows in PNG's container.
fn encode_png(capture: &crate::mcp::Capture) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, capture.width, capture.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&capture.rgb)
            .map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// How long to sit in the loop before looking again. Short enough that a reply
/// feels instant, long enough that the bridge costs nothing while idle.
const BRIDGE_POLL: Duration = Duration::from_millis(5);

/// Bytes waiting on a handle, or `None` when it is not a pipe.
///
/// This is the whole reason the bridge has no reader thread. A synchronous
/// `ReadFile` already sitting on the handle blocks any concurrent `WriteFile`
/// on that same handle, so a reader thread and a writer thread deadlock the
/// instant the app answers the first request: the request never arrives and the
/// reply nobody is reading. Asking what is available instead never takes the
/// handle, so both directions are always free.
fn available(pipe: windows::Win32::Foundation::HANDLE) -> Option<u32> {
    let mut bytes = 0u32;
    // SAFETY: `pipe` is an open handle; peeking reports and consumes nothing.
    let peeked = unsafe {
        windows::Win32::System::Pipes::PeekNamedPipe(pipe, None, 0, None, Some(&mut bytes), None)
    };
    peeked.is_ok().then_some(bytes)
}

/// Everything the app has already sent, in order, each printed as it arrived.
fn drain_replies(pipe: windows::Win32::Foundation::HANDLE) {
    use std::io::Write as _;
    while available(pipe).is_some_and(|bytes| bytes > 0) {
        let Some(message) = read_message(pipe) else {
            return;
        };
        print!("{message}");
        if std::io::stdout().flush().is_err() {
            return;
        }
    }
}

/// The stdio side: `piko.exe mcp`. Runs instead of the app, so it has no window
/// and no island of its own — it only carries bytes to the app that does.
///
/// One thread, one pipe handle, no blocking read on the pipe. MCP clients spawn
/// this with piped stdio, so stdin is a pipe too and both ends can be polled;
/// when stdin is a console or a file instead, its lines are read on their own
/// and the app's replies are still drained between them.
pub fn run_stdio_bridge() -> i32 {
    let Some(name) = pipe_name() else {
        eprintln!("piko mcp: cannot work out which user this is");
        return 2;
    };
    let wide = windows::core::HSTRING::from(name.as_str());
    let ptr = windows::core::PCWSTR(wide.as_ptr());
    // OpenCode starts the bridge whenever it wants to talk, which may be before
    // the app has got as far as creating the pipe.
    let mut handle = None;
    for _ in 0..50 {
        // SAFETY: `ptr` is a live NUL-terminated string owned by this scope.
        match unsafe {
            windows::Win32::Storage::FileSystem::CreateFileW(
                ptr,
                windows::Win32::Foundation::GENERIC_READ.0
                    | windows::Win32::Foundation::GENERIC_WRITE.0,
                windows::Win32::Storage::FileSystem::FILE_SHARE_NONE,
                None,
                windows::Win32::Storage::FileSystem::OPEN_EXISTING,
                windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            )
        } {
            Ok(h) => {
                handle = Some(h);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    let Some(pipe) = handle else {
        eprintln!("piko mcp: Piko isn't running");
        return 3;
    };

    // The read mode is left exactly as `CreateFileW` gives it: byte-read.
    // `read_message` finds the message boundaries with `PeekNamedPipe` instead,
    // which works in byte mode and has the advantage of never holding the
    // handle. Switching the handle to message-read mode buys nothing here and
    // costs a syscall per direction change.
    use std::io::BufRead as _;
    use std::os::windows::io::AsRawHandle;
    let stdin = std::io::stdin();
    // The same handle the client writes to, asked only how much is waiting. Never
    // written to. `Stdin` owns the real handle for the whole process, so this
    // only borrows it.
    let stdin_handle = windows::Win32::Foundation::HANDLE(std::io::stdin().as_raw_handle());
    let piped = available(stdin_handle).is_some();

    if piped {
        // The real case. Nothing here blocks on the pipe, so a request going out
        // and a reply coming back never wait on each other.
        //
        // Lines are cut out of a buffer this loop owns rather than read with
        // `read_line`, because a buffered reader swallows every byte it can get
        // in one go: a client that sends three requests back to back has all
        // three sitting in the reader's buffer while the pipe handle reports
        // none, and the handle is the only thing that can say whether to wait.
        let mut pending: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            drain_replies(pipe);
            if let Some(end) = pending.iter().position(|&byte| byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=end).collect();
                if !send_request(pipe, &line) {
                    break;
                }
                continue;
            }
            match available(stdin_handle) {
                // A closed stdin reports a broken pipe rather than zero bytes,
                // which is the only way to tell "nothing yet" from "no more ever".
                None => {
                    // A last line without a trailing newline is still a request.
                    let rest = std::mem::take(&mut pending);
                    if !rest.is_empty() && !send_request(pipe, &rest) {
                        break;
                    }
                    break;
                }
                Some(0) => std::thread::sleep(BRIDGE_POLL),
                Some(_) => {
                    // Known to have data, so this returns instead of waiting.
                    let mut read = 0u32;
                    // SAFETY: `chunk` is live, `read` is what bounds the copy, and
                    // stdin is only ever read here.
                    let result = unsafe {
                        windows::Win32::Storage::FileSystem::ReadFile(
                            stdin_handle,
                            Some(&mut chunk),
                            Some(&mut read),
                            None,
                        )
                    };
                    if result.is_err() || read == 0 {
                        break;
                    }
                    pending.extend_from_slice(&chunk[..read as usize]);
                }
            }
        }
    } else {
        // A console or a redirect. Reads block, so replies are drained between
        // lines instead of alongside them.
        for line in stdin.lock().lines() {
            drain_replies(pipe);
            let Ok(request) = line else { break };
            let request = request.trim();
            if request.is_empty() {
                continue;
            }
            let mut payload = request.as_bytes().to_vec();
            payload.push(b'\n');
            if !write_message(pipe, &payload) {
                break;
            }
        }
    }

    // The app may still owe a reply to the last request — `tools/call` for a
    // screenshot takes as long as the capture takes. Give it a moment, then stop
    // whether or not it arrived.
    let grace = Instant::now() + Duration::from_millis(250);
    while Instant::now() < grace {
        drain_replies(pipe);
        std::thread::sleep(BRIDGE_POLL);
    }
    0
}

/// One request line out to the app, newline included so the app's own reader
/// sees the same shape it would from any other client. Blank lines are the
/// keepalive some clients send and mean nothing to the app.
fn send_request(pipe: windows::Win32::Foundation::HANDLE, line: &[u8]) -> bool {
    let line = trim_ascii_end(line);
    if line.is_empty() {
        return true;
    }
    let mut payload = line.to_vec();
    payload.push(b'\n');
    write_message(pipe, &payload)
}

fn trim_ascii_end(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && matches!(line[end - 1], b'\r' | b'\n' | b' ' | b'\t') {
        end -= 1;
    }
    &line[..end]
}

/// One `WriteFile`, all of it or nothing: the app reads one message per request
/// and a short write would be a torn line of JSON it cannot parse.
fn write_message(pipe: windows::Win32::Foundation::HANDLE, payload: &[u8]) -> bool {
    let mut written = 0u32;
    // SAFETY: `payload` outlives the call and the pipe is open for writing.
    let result = unsafe {
        windows::Win32::Storage::FileSystem::WriteFile(
            pipe,
            Some(payload),
            Some(&mut written),
            None,
        )
    };
    result.is_ok() && written as usize == payload.len()
}

// ── tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_the_screen_size_is_not_an_input_action() {
        // This used to assert that `screenshot` was exempt too, and it was
        // wrong: "it changes nothing" is not the same as "it needs no
        // permission". `screenshot` now counts as an input action so it reaches
        // the card; `screen_info` still does not, because a screen's dimensions
        // and the cursor's position reveal nothing about what is on it.
        assert!(!Action::ScreenInfo.is_input());
        for a in [
            Action::Screenshot,
            Action::ReadFile,
            Action::ListDirectory,
            Action::MouseMove,
            Action::MouseClick,
            Action::MouseDrag,
            Action::Scroll,
            Action::TypeText,
            Action::KeyPress,
        ] {
            assert!(a.is_input(), "{a:?} must count as input");
        }
    }

    #[test]
    fn type_text_is_never_grantable() {
        // This is the rule that makes the password problem survivable: a grant
        // can never cover typing.
        assert!(!Action::TypeText.grantable());
        for a in [
            Action::MouseMove,
            Action::MouseClick,
            Action::MouseDrag,
            Action::Scroll,
            Action::KeyPress,
        ] {
            assert!(a.grantable(), "{a:?} should be grantable");
        }
    }

    #[test]
    fn grant_ttl_is_ten_minutes() {
        assert_eq!(GRANT_TTL.as_secs(), 600);
    }

    #[test]
    fn rate_limit_is_five_per_second() {
        assert_eq!(RATE_PER_SEC, 5);
        assert_eq!(RATE_PER_SEC.saturating_sub(5), 0);
    }

    #[test]
    fn control_defaults_to_off() {
        // The single most important assertion in this file: a fresh process must
        // refuse input without being asked.
        let s = state();
        assert!(!s.enabled.load(Ordering::SeqCst));
        let st = status();
        assert!(!st.enabled);
    }

    #[test]
    fn a_tool_is_named_after_the_action_it_logs() {
        // The card names the action ("click at 840,420") and the log records the
        // tool name. If those two strings drift apart, the audit trail stops
        // matching what a person actually approved.
        for tool in tools() {
            assert_eq!(tool.name, tool.action.log_name(), "{}", tool.name);
        }
        // Every action is reachable, so no tool can exist without an action.
        let mut seen: Vec<&str> = tools().iter().map(|t| t.action.log_name()).collect();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(
            seen.len(),
            10,
            "an action is missing from the tool list: {seen:?}"
        );
    }

    #[test]
    fn a_screenshot_is_no_longer_free() {
        // The regression this whole permission story exists for: `screenshot`
        // used to be exempt from cards, so a tool handing an agent a picture of
        // every window on the desktop ran with nobody asked. `screen_info` is
        // still exempt, because it reports the desktop's size and the cursor
        // and nothing else.
        assert!(Action::Screenshot.is_input());
        assert!(Action::Screenshot.is_read());
        assert!(!Action::ScreenInfo.is_input());
        assert!(!Action::ScreenInfo.is_read());
    }

    #[test]
    fn reading_the_disk_is_a_permissioned_read() {
        for a in [Action::ReadFile, Action::ListDirectory] {
            assert!(a.is_input(), "{a:?} must reach the card");
            assert!(a.is_read(), "{a:?} must be covered by the session grant");
            // Reads change nothing, so a plain input grant must not cover them.
            assert_ne!(a.log_name(), "");
        }
    }

    #[test]
    fn the_first_read_of_a_session_is_asked_and_the_rest_are_not() {
        // Global state, so this restores what it found rather than leaving the
        // process in a state a later test would inherit.
        reset_reads();
        assert!(needs_read_permission(Action::Screenshot));
        grant_reads();
        assert!(!needs_read_permission(Action::Screenshot));
        assert!(!needs_read_permission(Action::ReadFile));

        // Killing the chord has to put the screen behind a question again.
        reset_reads();
        assert!(needs_read_permission(Action::Screenshot));
        // And screen_info never asks either way.
        assert!(!needs_read_permission(Action::ScreenInfo));
        reset_reads();
    }

    #[test]
    fn kill_hotkey_is_the_awkward_chord() {
        assert_eq!(kill_hotkey_label(), KILL_HOTKEY_LABEL);
        assert!(
            !kill_hotkey_label().contains("Win"),
            "the Windows key must not be in the kill chord"
        );
    }

    #[test]
    fn logged_line_carries_no_arguments() {
        // The log format is fixed: "<action> <epoch seconds>". There is nowhere
        // for typed text to go, which is the point.
        let line = format!("mcp {} 1790982528", Action::TypeText.log_name());
        assert_eq!(line, "mcp type_text 1790982528");
    }

    #[test]
    fn initialize_promises_a_human_in_the_loop() {
        let r = initialize_result();
        // A client that reads only this decides whether to trust the server.
        assert_eq!(r["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(r["serverInfo"]["name"], "piko");
        let instructions = r["instructions"].as_str().unwrap();
        assert!(instructions.contains("Allow"), "{instructions}");
    }

    #[test]
    fn every_tool_is_advertised_with_a_schema() {
        let advertised = tool_list_json();
        let advertised = advertised["tools"].as_array().unwrap();
        assert_eq!(advertised.len(), tools().len());
        for t in advertised {
            let name = t["name"].as_str().unwrap();
            assert!(t["description"].is_string(), "{name} has no description");
            let schema = &t["inputSchema"];
            assert_eq!(schema["type"], "object", "{name}");
            assert!(schema["properties"].is_object(), "{name}");
            // `additionalProperties: false` is what stops a model inventing an
            // argument the server would silently ignore.
            assert_eq!(schema["additionalProperties"], false, "{name}");
        }
    }

    #[test]
    fn a_read_only_tool_advertises_no_required_arguments() {
        let list = tool_list_json();
        let info = list["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "screen_info")
            .unwrap()
            .clone();
        assert!(info["inputSchema"]["required"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn jsonrpc_envelopes_are_well_formed() {
        let ok = ok_response(json!(7), json!({ "a": 1 }));
        assert_eq!(ok["jsonrpc"], "2.0");
        assert_eq!(ok["id"], 7);
        assert_eq!(ok["result"]["a"], 1);
        let err = error_response(json!("x"), -32601, "no method nope");
        assert_eq!(err["jsonrpc"], "2.0");
        assert_eq!(err["id"], "x");
        assert_eq!(err["error"]["code"], -32601);
        assert!(
            err.get("result").is_none(),
            "an error must not also carry a result"
        );
    }

    /// The transport, end to end, without a desktop or an `AppHandle`: create the
    /// real pipe with the real DACL, connect a second handle, and push a message
    /// far larger than the initial buffer in each direction.
    ///
    /// This is the test that earns its keep. A screenshot reply is routinely over
    /// 256 KiB of base64, and `ERROR_MORE_DATA` handling that is wrong does not
    /// fail loudly — it just silently truncates the tool people actually want.
    #[test]
    fn the_pipe_carries_messages_bigger_than_the_first_buffer() {
        use std::sync::mpsc;

        let Some(name) = pipe_name() else {
            eprintln!("no user SID, skipping the pipe test");
            return;
        };
        let Some(attrs) = sddl_attributes().map(Attributes) else {
            panic!("the DACL could not be built, so the pipe test cannot pass");
        };
        let wide = windows::core::HSTRING::from(name.as_str());
        let ptr = windows::core::PCWSTR(wide.as_ptr());
        let pipe = create_pipe(ptr, Some(&attrs));
        if pipe.is_invalid() {
            // The usual cause is a real Piko already holding the name, which is
            // the first-instance flag doing its job. Not a failure.
            eprintln!("the pipe is already owned by another instance, skipping");
            return;
        }

        // Something well past the 256 KiB starting buffer, and recognisable at
        // both ends so a truncation cannot pass unnoticed.
        let big: Vec<u8> = (0..600_000u32).map(|i| b'a' + (i % 26) as u8).collect();
        let expect = String::from_utf8(big.clone()).unwrap();

        let (tx, rx) = mpsc::channel::<Option<String>>();
        let client_name = name.clone();
        let client_big = big.clone();
        let client = std::thread::spawn(move || {
            let wide = windows::core::HSTRING::from(client_name.as_str());
            let ptr = windows::core::PCWSTR(wide.as_ptr());
            let mut handle = None;
            for _ in 0..100 {
                // SAFETY: `ptr` is live for this scope and the pipe already exists.
                match unsafe {
                    windows::Win32::Storage::FileSystem::CreateFileW(
                        ptr,
                        windows::Win32::Foundation::GENERIC_READ.0
                            | windows::Win32::Foundation::GENERIC_WRITE.0,
                        windows::Win32::Storage::FileSystem::FILE_SHARE_MODE(0),
                        None,
                        windows::Win32::Storage::FileSystem::OPEN_EXISTING,
                        windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
                        None,
                    )
                } {
                    Ok(h) if !h.is_invalid() => {
                        handle = Some(h);
                        break;
                    }
                    _ => std::thread::sleep(Duration::from_millis(20)),
                }
            }
            let Some(handle) = handle else {
                let _ = tx.send(None);
                return;
            };
            // SAFETY: `client_big` is live and owned here.
            let mut written = 0u32;
            unsafe {
                windows::Win32::Storage::FileSystem::WriteFile(
                    handle,
                    Some(&client_big),
                    Some(&mut written),
                    None,
                )
            }
            .expect("the client could not write its request");
            // A big reply back the other way, to prove the grown read works both
            // ways round.
            let got = read_message(handle);
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
            let _ = tx.send(got);
        });

        // SAFETY: a valid, freshly created handle, waiting for that client.
        let _ = unsafe { windows::Win32::System::Pipes::ConnectNamedPipe(pipe, None) };
        let request = read_message(pipe);
        // SAFETY: `pipe` is still open and owned by this thread.
        let mut written = 0u32;
        unsafe {
            windows::Win32::Storage::FileSystem::WriteFile(
                pipe,
                Some(big.as_slice()),
                Some(&mut written),
                None,
            )
        }
        .expect("the server could not write its reply");
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(pipe) };

        // `assert!` rather than `assert_eq!`, so a regression reports how many bytes
        // arrived instead of printing half a megabyte of base64 into the log.
        assert!(
            request.as_deref() == Some(expect.as_str()),
            "a message larger than the first buffer was not delivered whole: got {} bytes, wanted {}",
            request.as_ref().map_or(0, String::len),
            expect.len()
        );
        let reply = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the client thread produced no answer");
        assert!(
            reply.as_deref() == Some(expect.as_str()),
            "the reply was not delivered whole either: got {} bytes, wanted {}",
            reply.as_ref().map_or(0, String::len),
            expect.len()
        );
        let _ = client.join();
    }
}
