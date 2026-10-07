// Getting the user's attention when an agent wants something.
//
// The island is a 6-pixel strip glued to the top of the screen: it is easy to
// miss entirely when the person is looking at another window. Two channels
// reach past it:
//
//   • a Windows toast, so the request follows the person into VS Code / Chrome
//   • a count on the tray icon, so the badge is there even if the toast was
//     dismissed, blocked by Focus Assist, or silently dropped by a policy
//
// Both are advisory. Neither is ever a decision: the island card stays the one
// place an approval is actually given or refused.
//
// Everything here is best-effort. A missing plugin, a denied permission prompt
// or a shell with no notification host must never take down the approval path
// it is trying to advertise — every function swallows its errors and returns.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use tauri::AppHandle;

use crate::log;

/// Which approval system a count came from. Two systems keep separate slots and
/// the badge is their sum: a single shared counter would be wrong the moment an
/// OpenCode permission and a screen-control card were open at once, because
/// whichever reported last would erase the other.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    OpenCode,
    ScreenControl,
}

static OC_PENDING: AtomicUsize = AtomicUsize::new(0);
static MCP_PENDING: AtomicUsize = AtomicUsize::new(0);

/// Whether toasts are wanted. Off until the app has been up long enough to know
/// it is not still starting up, so a burst of events during boot is silent.
static TOASTS_ON: AtomicBool = AtomicBool::new(false);

/// What to tell the user, without them having to open the island.
pub struct Alert {
    pub title: &'static str,
    pub body: String,
    /// True when the island holds a card the person can answer. Kept as data
    /// rather than folded into `raise` so a future channel (a toast action
    /// button, a sound) can tell an answerable alert from a plain notice.
    #[allow(dead_code)]
    pub interactive: bool,
}

impl Alert {
    /// An agent asked to run a command.
    pub fn command(cmd: &str, dir: Option<&str>) -> Self {
        let mut body = truncate(cmd.trim(), 180);
        if let Some(d) = dir {
            body.push_str(&format!("\n{d}"));
        }
        Self {
            title: "OpenCode needs your approval",
            body,
            interactive: true,
        }
    }

    /// An agent asked to touch a file.
    pub fn file(path: &str) -> Self {
        Self {
            title: "OpenCode wants to change a file",
            body: truncate(path, 200),
            interactive: true,
        }
    }

    /// Anything else — a permission we have no detail for.
    pub fn generic(what: &str) -> Self {
        Self {
            title: "OpenCode needs your approval",
            body: truncate(what, 200),
            interactive: true,
        }
    }

    /// The agent asked the user a question rather than for a permission.
    #[allow(dead_code)]
    pub fn question(q: &str) -> Self {
        Self {
            title: "OpenCode has a question",
            body: truncate(q, 200),
            interactive: true,
        }
    }
}

/// Called once at startup: works out whether toasts can work at all.
pub fn init(app: &AppHandle) {
    TOASTS_ON.store(toast_capable(app), Ordering::Relaxed);
    log::line(if toasts_on() {
        "notifications: toasts on"
    } else {
        "notifications: no toast host, tray badge only"
    });
}

fn toast_capable(app: &AppHandle) -> bool {
    #[cfg(feature = "toast")]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title("Piko")
            .body("Notifications are on")
            .show()
            .is_ok()
    }
    #[cfg(not(feature = "toast"))]
    {
        let _ = app;
        false
    }
}

pub fn toasts_on() -> bool {
    TOASTS_ON.load(Ordering::Relaxed)
}

/// Records how many approvals one system has open, and repaints the tray badge
/// from the sum. Returns the new total.
pub fn set_pending(app: &AppHandle, source: Source, n: usize) -> usize {
    let slot = match source {
        Source::OpenCode => &OC_PENDING,
        Source::ScreenControl => &MCP_PENDING,
    };
    slot.store(n, Ordering::Relaxed);
    let total = OC_PENDING.load(Ordering::Relaxed) + MCP_PENDING.load(Ordering::Relaxed);
    crate::tray::set_badge(app, total);
    total
}

#[allow(dead_code)]
pub fn pending() -> usize {
    OC_PENDING.load(Ordering::Relaxed) + MCP_PENDING.load(Ordering::Relaxed)
}

/// Raises one alert. The caller has already updated the badge.
pub fn raise(app: &AppHandle, alert: Alert) {
    if !toasts_on() {
        return;
    }
    #[cfg(feature = "toast")]
    {
        use tauri_plugin_notification::NotificationExt;
        // Windows toasts carry no click action through this plugin, so the
        // toast's job is only to say the request exists. The buttons live on
        // the island card, which is the one place a decision is made.
        let b = app
            .notification()
            .builder()
            .title(alert.title)
            .body(&alert.body);
        // A refusal here means the host declined, which is a Windows setting,
        // not a bug to chase. The badge and the island card still stand.
        if let Err(e) = b.show() {
            log::line(format!("toast failed: {e}"));
        }
    }
    #[cfg(not(feature = "toast"))]
    {
        let _ = (app, alert);
    }
}

/// Test and helper: keeps long commands from filling the toast.
fn truncate(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_command_is_left_alone() {
        assert_eq!(truncate("npm install express", 180), "npm install express");
    }

    #[test]
    fn whitespace_is_flattened_so_the_toast_stays_two_lines() {
        assert_eq!(
            truncate("npm   install\n\texpress", 180),
            "npm install express"
        );
    }

    #[test]
    fn a_long_command_is_cut_with_an_ellipsis_and_stays_under_the_limit() {
        let long = "x".repeat(400);
        let out = truncate(&long, 180);
        assert_eq!(out.chars().count(), 180);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn truncation_counts_characters_not_bytes() {
        // Four bytes each in UTF-8: a byte-based cut would slice a char in half.
        let long = "é".repeat(400);
        let out = truncate(&long, 180);
        assert_eq!(out.chars().count(), 180);
    }

    #[test]
    fn an_alert_carries_the_command_and_the_directory() {
        let a = Alert::command("npm install express", Some("C:\\work\\app"));
        assert!(a.body.contains("npm install express"));
        assert!(a.body.contains("C:\\work\\app"));
        assert!(a.interactive);
    }

    #[test]
    fn a_question_is_told_apart_from_a_permission() {
        let a = Alert::question("Which branch?");
        assert_ne!(a.title, Alert::generic("x").title);
        assert!(a.body.contains("Which branch?"));
    }
}
