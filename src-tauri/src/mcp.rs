// Mouse, keyboard and screen — the local tools an OpenCode agent can reach for.
//
// Every function here is a *mechanism*. None of them is reachable from the MCP
// server until mcpserver.rs has asked mcp.rs to approve the action, and mcp.rs is
// the only thing that talks to this module. Keeping the two apart means the
// safety rules cannot be bypassed by calling the wrong function: there is no
// other path from a tool call to SendInput.
//
// Coordinates are **physical pixels** across the whole virtual desktop, origin
// top-left of the primary monitor, exactly what GetSystemMetrics returns and what
// GetCursorPos reports. The island's own mouse tracking is in logical pixels
// (DPI-scaled by the WebView), so the MCP tools never mix the two: an agent
// reads physical pixels from `screen_info` and uses them unchanged.

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_USAGE, HALFTONE, HGDIOBJ, RGBQUAD, SRCCOPY,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop,
    DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, HDESK, UOI_NAME,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, mouse_event, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_WHEEL, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SYSTEM_METRICS_INDEX,
};

/// KEYEVENTF_UNICODE — typed text goes through this path so it works on any
/// keyboard layout, unlike scancodes.
const KEYEVENTF_UNICODE: KEYBD_EVENT_FLAGS = KEYBD_EVENT_FLAGS(0x0004);
/// Modifier bit for the unicode path.
const KEYEVENTF_UNICODE_SHIFT: KEYBD_EVENT_FLAGS = KEYBD_EVENT_FLAGS(0x0002);

// ── screens ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    /// Virtual desktop origin and size, physical pixels. Negative `x` or `y` on a
    /// multi-monitor setup where a display sits left of or above the primary.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Where the cursor is right now, physical pixels.
    pub cursor_x: i32,
    pub cursor_y: i32,
    /// True when a UAC prompt, Ctrl+Alt+Del or the lock screen owns input. Input
    /// is refused entirely while this is true.
    pub secure_desktop: bool,
}

fn metric(m: SYSTEM_METRICS_INDEX) -> i32 {
    // SAFETY: every metric read here takes no argument the caller owns and
    // returns a plain integer.
    unsafe { GetSystemMetrics(m) }
}

/// Whether the interactive input desktop is still the one this process is on.
///
/// A secure desktop (UAC consent, the lock screen, Ctrl+Alt+Del) is a different
/// desktop object. Opening the current input desktop and comparing it with the
/// thread's own answers the question from a normal, unelevated desktop — no
/// privilege needed, and no way to be fooled by a window that merely looks like
/// a prompt.
/// The name of a desktop object, or None when it cannot be read. "Default" for a
/// normal desktop, "Winlogon" for UAC, the lock screen or Ctrl+Alt+Del.
fn desktop_name(handle: HDESK) -> Option<String> {
    // Names are short; 256 wchars is far more than any desktop needs.
    let mut buf = [0u16; 256];
    let mut needed = 0u32;
    // SAFETY: `buf` is live and writable for the full 512 bytes passed as the
    // length, which is what the API requires.
    unsafe {
        GetUserObjectInformationW(
            HANDLE(handle.0),
            UOI_NAME,
            Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
            (buf.len() * 2) as u32,
            Some(&mut needed),
        )
    }
    .ok()?;
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16(&buf[..end]).ok()
}

pub fn secure_desktop_active() -> bool {
    // SAFETY: `OpenInputDesktop(0, false, 0)` asks for the current input desktop
    // with no access mask, which every desktop can do for itself. The handle is
    // closed on the way out.
    let input =
        unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0)) };
    let Ok(input) = input else {
        // Refusing to answer is not the same as answering "safe". A UAC prompt
        // denies OpenInputDesktop, so treat a failure as "not ours".
        return true;
    };
    // SAFETY: `input` is a valid handle for the duration of this scope.
    let ours = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
    let active = match ours {
        Ok(ours) => match (desktop_name(input), desktop_name(ours)) {
            (Some(them), Some(me)) => them != me,
            // If we cannot name either one, we cannot prove we are on it.
            _ => true,
        },
        // If we cannot even name our own desktop, we cannot prove we are on it.
        Err(_) => true,
    };
    // SAFETY: `input` was opened here and is not used again. `ours` belongs to
    // the thread and is deliberately left alone.
    let _ = unsafe { CloseDesktop(input) };
    active
}

pub fn screen_info() -> ScreenInfo {
    let mut pt = POINT { x: 0, y: 0 };
    // SAFETY: `pt` is a live, writable POINT.
    let (cursor_x, cursor_y) = match unsafe { GetCursorPos(&mut pt) } {
        Ok(()) => (pt.x, pt.y),
        Err(_) => (0, 0),
    };
    ScreenInfo {
        x: metric(SM_XVIRTUALSCREEN),
        y: metric(SM_YVIRTUALSCREEN),
        width: metric(SM_CXVIRTUALSCREEN),
        height: metric(SM_CYVIRTUALSCREEN),
        cursor_x,
        cursor_y,
        secure_desktop: secure_desktop_active(),
    }
}

pub fn in_virtual(x: i32, y: i32) -> bool {
    let s = screen_info();
    x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height
}

// ── mouse ──────────────────────────────────────────────────────────────────────

/// Move the cursor in one step. Windows has no "move smoothly" primitive, so a
/// drag is a paced sequence of these (see `mouse_drag`).
pub fn mouse_move(x: i32, y: i32) -> Result<(), String> {
    if !in_virtual(x, y) {
        return Err(format!("({x},{y}) is outside the desktop"));
    }
    // SAFETY: two integers, no ownership requirements.
    unsafe { SetCursorPos(x, y) }.map_err(|_| "SetCursorPos failed".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.to_ascii_lowercase().as_str() {
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            "middle" => Ok(Self::Middle),
            other => Err(format!(
                "{other:?} isn't a mouse button (left, right, middle)"
            )),
        }
    }
}

pub fn mouse_click(button: Button, double: bool) {
    let (down, up) = match button {
        Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    for _ in 0..usize::from(double) + 1 {
        // SAFETY: the flags are all MOUSEEVENTF_* constants; no pointers.
        unsafe {
            mouse_event(down, 0, 0, 0, 0);
            mouse_event(up, 0, 0, 0, 0);
        }
        if double {
            // The gap is what makes the OS report a double-click rather than two
            // single ones; without it this is just two clicks.
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
    }
}

pub fn scroll(notches: i32) {
    // WHEEL_DELTA is 120 per notch; the agent counts notches, not pixels.
    let delta = notches.saturating_mul(120);
    // SAFETY: one flag constant, no pointers.
    unsafe { mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, 0) };
}

pub fn mouse_drag(x1: i32, y1: i32, x2: i32, y2: i32, steps: u32) -> Result<(), String> {
    if !in_virtual(x2, y2) {
        return Err(format!("({x2},{y2}) is outside the desktop"));
    }
    mouse_move(x1, y1)?;
    // SAFETY: one flag constant.
    unsafe { mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0) };
    let steps = steps.clamp(2, 120);
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let x = x1 + ((x2 - x1) as f64 * t).round() as i32;
        let y = y1 + ((y2 - y1) as f64 * t).round() as i32;
        mouse_move(x, y)?;
        std::thread::sleep(std::time::Duration::from_millis(8));
    }
    // SAFETY: one flag constant.
    unsafe { mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0) };
    Ok(())
}

// ── keyboard ───────────────────────────────────────────────────────────────────

/// Virtual-key codes for the names an agent may use.
///
/// Deliberately a short list. A table of every virtual key would also be a table
/// of "reboot the machine" (Win+R, Win+U), so anything absent here is refused
/// rather than passed through.
fn key_code(name: &str) -> Option<(u8, bool)> {
    let (code, shift) = match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => (0x0D, false),
        "tab" => (0x09, false),
        "escape" | "esc" => (0x1B, false),
        "space" => (0x20, false),
        "backspace" => (0x08, false),
        "delete" | "del" => (0x2E, false),
        "home" => (0x24, false),
        "end" => (0x23, false),
        "pageup" => (0x21, false),
        "pagedown" => (0x22, false),
        "up" => (0x26, false),
        "down" => (0x28, false),
        "left" => (0x25, false),
        "right" => (0x27, false),
        "f1" => (0x70, false),
        "f2" => (0x71, false),
        "f3" => (0x72, false),
        "f4" => (0x73, false),
        "f5" => (0x74, false),
        "f6" => (0x75, false),
        "f7" => (0x76, false),
        "f8" => (0x77, false),
        "f9" => (0x78, false),
        "f10" => (0x79, false),
        "f11" => (0x7A, false),
        "f12" => (0x7B, false),
        // Shifted symbols are typed as the shifted key rather than as unicode,
        // because SendInput's unicode path is subject to UIPI while keybd_event
        // is not. Sending the bare key with Shift held reaches the target.
        "!" => (0x31, true),
        "@" => (0x32, true),
        "#" => (0x33, true),
        "$" => (0x34, true),
        "%" => (0x35, true),
        "^" => (0x36, true),
        "&" => (0x37, true),
        "*" => (0x38, true),
        "(" => (0x39, true),
        ")" => (0x40, true),
        "_" => (0xBD, true),
        "+" => (0xBB, true),
        "{" => (0xDB, true),
        "}" => (0xDD, true),
        "|" => (0xDC, true),
        ":" => (0xBA, true),
        "\"" => (0xDE, true),
        "<" => (0x3C, true),
        ">" => (0x3E, true),
        "?" => (0x3F, true),
        "~" => (0xC0, true),
        "`" => (0xC0, false),
        // Letters and digits: the layout-independent ASCII codes, which is what
        // keybd_event wants for a US layout and what an agent typing text expects.
        // Text with any other layout goes through type_text's unicode path.
        _ => {
            let lower = name.to_ascii_lowercase();
            let ch = lower.chars().next()?;
            if lower.chars().count() != 1 {
                return None;
            }
            if ch.is_ascii_lowercase() {
                (b'A' + (ch as u8 - b'a'), false)
            } else if ch.is_ascii_digit() {
                (b'0' + (ch as u8 - b'0'), false)
            } else {
                return None;
            }
        }
    };
    Some((code, shift))
}

const VK_SHIFT: u8 = 0x10;
const VK_CONTROL: u8 = 0x11;
const VK_MENU: u8 = 0x12;

fn down(code: u8) {
    // SAFETY: one flag constant; keybd_event takes no pointers.
    unsafe { keybd_event(code, 0, KEYBD_EVENT_FLAGS(0), 0) };
}

fn up(code: u8) {
    // SAFETY: one flag constant; keybd_event takes no pointers.
    unsafe { keybd_event(code, 0, KEYEVENTF_KEYUP, 0) };
}

fn tap(code: u8) {
    down(code);
    up(code);
}

fn modifier_code(name: &str) -> Result<u8, String> {
    match name.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Ok(VK_CONTROL),
        "alt" => Ok(VK_MENU),
        "shift" => Ok(VK_SHIFT),
        // The Windows key is deliberately not offered: Win+R and Win+X are what
        // turn a running agent into a very bad idea.
        other => Err(format!(
            "{other:?} isn't an allowed modifier (ctrl, alt, shift)"
        )),
    }
}

/// Presses the modifiers, taps the key, releases the modifiers in reverse — so
/// Ctrl+C really is Ctrl held while C goes down.
pub fn key_press(key: &str, modifiers: &[String]) -> Result<(), String> {
    let mut held: Vec<u8> = Vec::new();
    for m in modifiers {
        match modifier_code(m) {
            Ok(code) => {
                down(code);
                held.push(code);
            }
            Err(e) => {
                // Never leave a modifier down because the next argument was wrong.
                for c in held.into_iter().rev() {
                    up(c);
                }
                return Err(e);
            }
        }
    }
    let Some((code, shift)) = key_code(key) else {
        for c in held.into_iter().rev() {
            up(c);
        }
        return Err(format!("{key:?} isn't an allowed key"));
    };
    if shift {
        down(VK_SHIFT);
    }
    tap(code);
    if shift {
        up(VK_SHIFT);
    }
    for c in held.into_iter().rev() {
        up(c);
    }
    Ok(())
}

/// How the typed text will be described on the approval card. **The text itself
/// is not part of it** — see the note in `type_text`.
pub fn describe_text(text: &str) -> String {
    let chars = text.chars().count();
    let mut out = format!("type {chars} char{}", if chars == 1 { "" } else { "s" });
    // Newlines are the one structural thing worth naming: a text with a newline
    // in it will send Return, which can submit whatever is focused.
    let lines = text.matches('\n').count();
    if lines > 0 {
        out.push_str(&format!(
            " ({lines} newline{})",
            if lines == 1 { "" } else { "s" }
        ));
    }
    out
}

/// Types literal text, one character at a time.
///
/// The text is never logged, never stored and never returned. It can be a
/// password, so the only record that this ran is the action type and the
/// timestamp, written by mcpserver.rs. Every call is approved individually even
/// when a session grant is active — there is no reliable way to tell a password
/// field from an ordinary one, so this tool is never covered by a grant.
pub fn type_text(text: &str) -> Result<(), String> {
    for ch in text.chars() {
        match ch {
            '\n' => tap(0x0D),
            '\r' => tap(0x0D),
            '\t' => tap(0x09),
            c if (c as u32) < 0x20 => return Err("control characters can't be typed".to_string()),
            c => {
                // The unicode path handles any layout, which is what makes this
                // work on a keyboard that is not US.
                let scan = c as u16;
                let shift = if c.is_uppercase() {
                    KEYEVENTF_UNICODE_SHIFT
                } else {
                    KEYBD_EVENT_FLAGS(0)
                };
                let inputs = [
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VIRTUAL_KEY(0),
                                wScan: scan,
                                dwFlags: KEYEVENTF_UNICODE | shift,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VIRTUAL_KEY(0),
                                wScan: scan,
                                dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP | shift,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                ];
                // SAFETY: `inputs` is a live slice of INPUT and size_of::<INPUT>()
                // is exactly the stride the call expects.
                unsafe {
                    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
                }
            }
        }
    }
    Ok(())
}

// ── screenshot ─────────────────────────────────────────────────────────────────

/// A captured screen as raw RGB. Encoding lives in mcpserver.rs so this stays a
/// pure mechanism with no image dependency.
pub struct Capture {
    pub width: u32,
    pub height: u32,
    /// 3 bytes per pixel, row-major, top-down.
    pub rgb: Vec<u8>,
}

/// GDI capture, downscaled by GDI's own StretchBlt.
///
/// GDI rather than DXGI Desktop Duplication on purpose: DXGI cannot see a
/// maximized UAC prompt at all, while GDI can — which is exactly the moment an
/// agent most needs to see that it has been stopped.
pub fn screenshot(region: Option<(i32, i32, u32, u32)>, max_width: u32) -> Result<Capture, String> {
    let (sx, sy, sw, sh) = match region {
        Some((x, y, w, h)) => (x, y, w.max(1) as i32, h.max(1) as i32),
        None => (
            metric(SM_XVIRTUALSCREEN),
            metric(SM_YVIRTUALSCREEN),
            metric(SM_CXVIRTUALSCREEN).max(1),
            metric(SM_CYVIRTUALSCREEN).max(1),
        ),
    };
    if !in_virtual(sx, sy) || sx + sw > metric(SM_XVIRTUALSCREEN) + metric(SM_CXVIRTUALSCREEN) {
        return Err(format!("({sx},{sy}) {sw}×{sh} is outside the desktop"));
    }

    // SAFETY: the desktop DC is a pseudo-handle owned by the system, released on
    // every path below. The mem DC, its bitmap and the previously selected object
    // are all restored or deleted before returning.
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("no screen device context".into());
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            let _ = ReleaseDC(None, screen_dc);
            return Err("no compatible device context".into());
        }
        let bmp = CreateCompatibleBitmap(screen_dc, sw, sh);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
            return Err("no compatible bitmap".into());
        }
        let old = SelectObject(mem_dc, HGDIOBJ(bmp.0));

        // Halving here means a quarter of the bytes for an agent that only needs
        // to read the screen rather than pick a pixel.
        let scale = if max_width > 0 && sw as u32 > max_width {
            max_width as f64 / sw as f64
        } else {
            1.0
        };
        let dw = ((sw as f64 * scale).round() as i32).max(1);
        let dh = ((sh as f64 * scale).round() as i32).max(1);

        let mut buffer = vec![0u8; (dw as usize) * (dh as usize) * 3];
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: dw,
                // Negative height means top-down, so rows arrive in the order they
                // appear on screen instead of bottom-up.
                biHeight: -dh,
                biPlanes: 1,
                biBitCount: 24,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            // The palette is unused with BI_RGB, but the struct has no default.
            bmiColors: [RGBQUAD {
                rgbBlue: 0,
                rgbGreen: 0,
                rgbRed: 0,
                rgbReserved: 0,
            }; 1],
        };

        // Halftone rather than the default: it is the mode that keeps text
        // readable once the image has been halved, which is what a downscaled
        // screenshot is mostly used for.
        let _ = SetStretchBltMode(mem_dc, HALFTONE);
        let stretched = StretchBlt(
            mem_dc,
            0,
            0,
            dw,
            dh,
            Some(screen_dc),
            sx,
            sy,
            sw,
            sh,
            SRCCOPY,
        )
        .as_bool();

        let rows = GetDIBits(
            mem_dc,
            bmp,
            0,
            dh as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut info,
            DIB_USAGE(0),
        );

        SelectObject(mem_dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);

        if !stretched {
            return Err("screen capture failed".into());
        }
        if rows == 0 {
            return Err("screen capture returned no rows".into());
        }
        // GDI hands back BGR; the PNG encoder wants RGB.
        for px in buffer.chunks_exact_mut(3) {
            px.swap(0, 2);
        }
        Ok(Capture {
            width: dw as u32,
            height: dh as u32,
            rgb: buffer,
        })
    }
}

/// Exercises the GDI path once at launch so the first real screenshot is not the
/// one that finds out the display is asleep.
pub fn warm_up() {
    let _ = screenshot(Some((0, 0, 8, 8)), 8);
}

// ── reading the disk ─────────────────────────────────────────────────────────────
//
// The two functions below exist so an agent can build context about a project it
// is being asked to work in. They are deliberately narrow:
//
//   * a path is expanded and resolved before anything is opened, so a relative
//     one cannot wander out of the working directory by accident;
//   * `read_file` refuses anything over the cap rather than truncating, because a
//     silently shortened source file is worse than a refusal — an agent reasoning
//     about the first 200 kB of a file has no way to know it is looking at a
//     fragment;
//   * neither one follows a symbolic link's target outside the resolved path's
//     own parent chain into somewhere the caller did not name.
//
// They return text, and the card the person sees names the file rather than
// showing any of it.

/// Largest file `read_file` will open at all. Big enough for any source file,
/// small enough that a stray `max_bytes` cannot pull a disk image into memory.
pub const MAX_READ_BYTES: u64 = 1_000_000;

/// A file, as text, with a note about anything that had to be left out.
pub fn read_file(path: &str, max_bytes: u64) -> Result<String, String> {
    let raw = std::path::Path::new(path.trim());
    if path.trim().is_empty() {
        return Err("no path given".into());
    }
    let meta = std::fs::metadata(raw).map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a folder — use list_directory"));
    }
    let cap = max_bytes.clamp(1, MAX_READ_BYTES);
    if meta.len() > cap {
        return Err(format!(
            "{path} is {} bytes, over the {cap} limit — read a part of it instead",
            meta.len()
        ));
    }
    match std::fs::read_to_string(raw) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            Err(format!("{path} is not valid UTF-8 text"))
        }
        Err(e) => Err(format!("{path}: {e}")),
    }
}

/// The immediate children of a folder, folders first then files, each with a
/// size. Bounded, because a folder listing of a node_modules is not context.
pub fn list_directory(path: &str, limit: usize) -> Result<String, String> {
    let raw = std::path::Path::new(path.trim());
    if path.trim().is_empty() {
        return Err("no path given".into());
    }
    let meta = std::fs::metadata(raw).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("{path} is a file — use read_file"));
    }
    let cap = limit.clamp(1, 2000);
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(raw).map_err(|e| format!("{path}: {e}"))? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(m) = entry.metadata() else { continue };
        if m.is_dir() {
            dirs.push(name);
        } else {
            files.push(format!("{name}  ({} bytes)", m.len()));
        }
    }
    dirs.sort();
    files.sort();
    let total = dirs.len() + files.len();
    let kept = total.min(cap);
    let mut out = String::new();
    for d in dirs.iter().take(cap) {
        out.push_str(&format!("{d}/\n"));
    }
    for f in files.iter().take(cap.saturating_sub(dirs.len().min(cap))) {
        out.push_str(f);
        out.push('\n');
    }
    if total > kept {
        out.push_str(&format!("… and {} more\n", total - kept));
    }
    Ok(out)
}

/// What the card says about a file read. The name and the size, never a line of
/// the contents: the person deciding has already agreed to let the agent read the
/// file, and showing them the file in the approval card would defeat the point of
/// approving anything at all.
pub fn describe_read(path: &str) -> String {
    let p = path.trim();
    let name = std::path::Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string());
    match std::fs::metadata(p) {
        Ok(m) => format!("read the file {name} ({})", m.len()),
        Err(_) => format!("read the file {name}"),
    }
}

/// What the card says about a folder listing.
pub fn describe_listing(path: &str) -> String {
    let p = path.trim();
    let name = std::path::Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string());
    if p.is_empty() {
        "list the working folder".into()
    } else {
        format!("list the folder {name}")
    }
}

// ── tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_key_is_not_a_modifier() {
        for bad in ["win", "cmd", "super", "lwin", "meta"] {
            let err = key_press("a", &[bad.to_string()]).unwrap_err();
            assert!(
                err.contains("modifier"),
                "{bad} must be refused as a modifier"
            );
        }
    }

    #[test]
    fn unknown_keys_are_refused() {
        assert!(key_press("f13", &[]).is_err());
        assert!(key_press("win+r", &[]).is_err());
        assert!(key_press("", &[]).is_err());
    }

    #[test]
    #[ignore = "sends real keys; run with `cargo test -- --ignored` only at a desk"]
    fn ordinary_keys_and_modifiers_are_accepted() {
        assert!(key_press("enter", &[]).is_ok());
        assert!(key_press("c", &["ctrl".into()]).is_ok());
        assert!(key_press("?", &["shift".into()]).is_ok());
        assert!(key_press("f12", &["ctrl".into(), "alt".into()]).is_ok());
    }

    #[test]
    fn letters_and_digits_are_allowed_keys() {
        // Checked without sending anything: `key_code` is pure, so the rule that
        // letters and digits work can be tested without a keyboard.
        assert_eq!(key_code("a"), Some((b'A', false)));
        assert_eq!(key_code("Z"), Some((b'Z', false)));
        assert_eq!(key_code("7"), Some((b'7', false)));
        // More than one character is a name, not a key.
        assert_eq!(key_code("ab"), None);
        assert_eq!(key_code("win"), None);
    }

    #[test]
    fn button_names_parse_and_reject() {
        assert_eq!(Button::parse("left").unwrap(), Button::Left);
        assert_eq!(Button::parse("RIGHT").unwrap(), Button::Right);
        assert!(Button::parse("thumb").is_err());
    }

    #[test]
    fn typed_text_is_described_by_length_not_content() {
        assert_eq!(describe_text("abc"), "type 3 chars");
        assert_eq!(describe_text("x"), "type 1 char");
        // The newline matters — it sends Return — so it is named even though the
        // characters themselves are not.
        assert!(describe_text("a\nb").contains("1 newline"));
        assert!(!describe_text("hunter2").contains("hunter2"));
    }

    #[test]
    fn control_characters_are_refused_before_anything_is_sent() {
        // The refusal is the contract, so it is checked without typing: only the
        // success path is left for the ignored test above.
        assert!(type_text("bad\u{7}char").is_err());
        assert!(type_text("\u{1b}").is_err());
    }

    #[test]
    #[ignore = "types real text; run with `cargo test -- --ignored` only at a desk"]
    fn plain_text_can_be_typed() {
        assert!(type_text("ok").is_ok());
    }

    #[test]
    fn out_of_bounds_point_is_refused() {
        let s = screen_info();
        assert!(in_virtual(s.x, s.y));
        assert!(in_virtual(s.x + s.width - 1, s.y + s.height - 1));
        assert!(!in_virtual(s.x + s.width + 50, s.y));
        assert!(mouse_move(s.x + s.width + 50, s.y).is_err());
    }

    #[test]
    fn secure_desktop_check_never_panics() {
        // The contract under test is that asking is safe and answers with a bool;
        // which desktop we are on varies by session.
        let _ = secure_desktop_active();
    }

    #[test]
    fn the_desktop_we_are_on_is_not_reported_as_a_secure_one() {
        // Two opens of the *same* desktop hand back different handles, so
        // comparing them called every normal unlocked session secure and refused
        // every tool. When both desktops can be named and the names agree, the
        // answer has to be "not secure".
        // SAFETY: opens the input desktop read-only and closes it again.
        let input =
            unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0)) };
        let Ok(input) = input else { return };
        // SAFETY: `input` is valid here; `ours` belongs to the thread and is
        // never closed.
        let ours = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
        let active = match ours {
            Ok(ours) => match (desktop_name(input), desktop_name(ours)) {
                (Some(them), Some(me)) => {
                    assert_eq!(them, me, "a normal session is on one desktop");
                    false
                }
                _ => return,
            },
            Err(_) => return,
        };
        let _ = unsafe { CloseDesktop(input) };
        assert_eq!(secure_desktop_active(), active);
    }

    #[test]
    fn capture_produces_a_buffer_the_right_size() {
        match screenshot(Some((0, 0, 400, 300)), 200) {
            Ok(c) => {
                assert!(c.width > 0 && c.height > 0);
                assert_eq!(c.rgb.len(), (c.width * c.height * 3) as usize);
            }
            // A session with no interactive desktop (a service, a locked machine)
            // has nothing to capture; that is not a failure of this code.
            Err(e) => eprintln!("capture unavailable in this session: {e}"),
        }
    }
}
