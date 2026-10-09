// Notification-area icon: Open, Settings, Pause, Quit.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

/// Tray id, fixed so `set_badge` can find the icon again later.
pub const TRAY_ID: &str = "piko";

/// The bare brand mark, alpha only — not the app-icon tile.
///
/// A notification-area slot is 16–24px, and a rounded dark square inside it is a
/// smudge; the mark alone is what stays legible there. The RGB underneath is white
/// and never seen, because Windows draws a tray icon through its alpha channel —
/// which is also why this one file is right on a light taskbar and a dark one, with
/// no theme check and no second asset.
static TRAY_PNG: &[u8] = include_bytes!("../icons/piko-tray.png");

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Piko", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &sep1, &settings, &pause, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Piko")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    // Decoded rather than shipped as a Rust byte array: `png` is already a direct
    // dependency — the MCP screenshot tool encodes with it — so this adds nothing
    // to the build, and the asset stays a PNG a person can open and look at.
    if let Ok(mut reader) = png::Decoder::new(TRAY_PNG).read_info() {
        let mut buf = vec![0u8; reader.output_buffer_size()];
        if let Ok(info) = reader.next_frame(&mut buf) {
            if info.bit_depth == png::BitDepth::Eight && info.color_type == png::ColorType::Rgba
            {
                builder = builder.icon(Image::new(&buf, info.width, info.height));
            }
        }
    }

    builder.build(app)?;
    Ok(())
}

/// What the badge says for `pending` open approvals: the tray title and the
/// tooltip. Split out from `set_badge` because the tray needs an AppHandle and
/// the wording should still be testable.
fn badge_text(pending: usize) -> (String, String) {
    if pending == 0 {
        return (String::new(), "Piko".to_string());
    }
    // Windows truncates a tray title hard and keeps the tail, so the count has
    // to lead and the dot has to be a symbol rather than a colour name.
    let title = if pending > 99 {
        "🔴 99+".to_string()
    } else {
        format!("🔴 {pending}")
    };
    let tip = format!(
        "Piko — {pending} approval{} waiting",
        if pending == 1 { "" } else { "s" }
    );
    (title, tip)
}

/// Repaints the badge on the tray icon: `🔴 2` while two approvals are open,
/// plain `Piko` when none are.
///
/// A missing tray is not an error worth logging: the icon can be rebuilt under
/// us during an update, and the toast still carries the news.
pub fn set_badge(app: &AppHandle, pending: usize) {
    let (title, tip) = badge_text(pending);
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let _ = tray.set_title(Some(title));
    let _ = tray.set_tooltip(Some(tip));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_waiting_means_no_badge() {
        let (title, tip) = badge_text(0);
        assert!(title.is_empty(), "an idle app must not look busy");
        assert_eq!(tip, "Piko");
    }

    #[test]
    fn one_waiting_is_not_plural() {
        let (_, tip) = badge_text(1);
        assert_eq!(tip, "Piko — 1 approval waiting");
    }

    #[test]
    fn the_count_is_the_number_that_matters() {
        assert!(badge_text(3).0.contains('3'));
        assert!(badge_text(12).0.contains("12"));
    }

    #[test]
    fn a_huge_count_is_capped_rather_than_being_cut_off_by_windows() {
        // Without the cap Windows truncates "🔴 1000" to something meaningless
        // or hides the title entirely.
        let (title, tip) = badge_text(1000);
        assert!(title.contains("99+"), "{title}");
        // The tooltip keeps the real number, so nothing is actually lost.
        assert!(tip.contains("1000"), "{tip}");
    }

    #[test]
    fn the_count_survives_windows_title_truncation() {
        // Windows keeps a short number of characters from a tray title. The
        // count therefore has to be at the front, not after a word of prose.
        for n in [1usize, 7, 42, 99] {
            let (title, _) = badge_text(n);
            let text = title.trim();
            let head: String = text.chars().take(4).collect();
            assert!(
                head.contains(&n.to_string()),
                "{n} not in the first chars of {title:?}"
            );
        }
    }
}
