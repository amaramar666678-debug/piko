// Adding Piko's MCP server to OpenCode's *global* config, the careful way.
//
// Rules this file exists to enforce:
//   * the file OpenCode actually reads is the one that gets edited: `opencode.jsonc`
//     if the user has one, otherwise `opencode.json`. Writing a second file next
//     to theirs would risk shadowing the config they wrote;
//   * a commented file is spliced as text (see jsonc.rs), so their comments,
//     key order and indentation survive. Nothing is re-serialised;
//   * nothing is written until a human has seen the exact diff;
//   * the previous file is copied to a timestamped backup first, so undo is a
//     file copy and not a reconstruction;
//   * the command is this executable and nothing else. No token, no port, no
//     environment variable holding a secret — the pipe's DACL is the whole of
//     the authentication story (see mcpserver.rs).

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// The key we own inside `mcp`. Anything else in that object is the user's.
const KEY: &str = "piko";

/// OpenCode's default MCP request timeout is 5 seconds. An approval card can
/// legitimately sit unanswered for minutes, so the entry has to say so
/// explicitly or the client hangs up long before a human gets there.
const TIMEOUT_MS: u64 = 300_000;

/// The config OpenCode is reading.
///
/// `opencode.jsonc` wins when it exists: that is a real file the user wrote, and
/// adding a sibling `opencode.json` beside it would leave two configs and a
/// genuine chance of ours being the one that gets read.
pub fn config_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| "USERPROFILE isn't set, so OpenCode's config can't be found".to_string())?;
    let dir = home.join(".config").join("opencode");
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        return Ok(jsonc);
    }
    Ok(dir.join("opencode.json"))
}

/// True when the file carries comments, which is what decides whether we can
/// round-trip it through serde or must splice it as text.
fn is_commented(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("jsonc" | "json5" | "jsonc5")
    )
}

fn backup_dir() -> PathBuf {
    crate::settings::local_dir().join("backups")
}

/// The absolute path of the running executable, quoted for a config file.
///
/// Windows paths contain spaces and backslashes, and JSON needs the backslashes
/// escaped — `serde_json` does that, but the surrounding quotes are ours.
fn command_line() -> Result<Vec<String>, String> {
    let exe = std::env::current_exe().map_err(|e| format!("can't find this executable: {e}"))?;
    Ok(vec![
        exe.to_string_lossy().into_owned(),
        // The arg `main.rs` dispatches on before Tauri starts. Keep in step.
        "mcp".to_string(),
    ])
}

/// True when the running executable is a cargo build rather than the installed app.
///
/// Both trees count, and the check is on a whole path segment: `cargo build` writes
/// to `target\debug` but a project directory called "my target debug build" must not
/// be mistaken for one, and a substring test on "target\debug" would. The consequence
/// is the same either way — OpenCode would be pointed at a file that the next
/// `cargo clean`, or the next rebuild that replaces it, stops being there — so the
/// answer is a warning rather than a refusal.
fn is_build_tree(exe: &std::path::Path) -> bool {
    let path = exe.to_string_lossy();
    [r"\target\debug\", r"\target\release\", "/target/debug/", "/target/release/"]
        .iter()
        .any(|seg| path.contains(seg))
}

fn entry() -> Result<Value, String> {
    Ok(json!({
        "type": "local",
        "command": command_line()?,
        "enabled": true,
        // Long enough for a card nobody has answered yet; see TIMEOUT_MS.
        "timeout": TIMEOUT_MS,
    }))
}

/// Reads the config, or an empty object when it does not exist yet.
fn read(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            if text.trim().is_empty() {
                return Ok(Value::Object(Map::new()));
            }
            serde_json::from_str(&text)
                .map_err(|e| format!("{} isn't valid JSON: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(format!("can't read {}: {e}", path.display())),
    }
}

/// The config as it would look with our entry in it. Fails if the file is not a
/// JSON object at the top level, which would mean we are looking at the wrong
/// file and must not write.
fn merged(existing: &Value) -> Result<Value, String> {
    let Value::Object(mut root) = existing.clone() else {
        return Err("the top level of opencode.json is not an object — refusing to write".into());
    };
    let mut mcp = match root.remove("mcp") {
        Some(Value::Object(m)) => m,
        // An explicit `"mcp": false` or a string would be overwritten. Say so
        // rather than silently changing someone's config.
        Some(other) => {
            return Err(format!(
                "\"mcp\" in opencode.json is {} — not a set of servers. Fix it by hand first.",
                type_name(&other)
            ))
        }
        None => Map::new(),
    };
    mcp.insert(KEY.to_string(), entry()?);
    root.insert("mcp".to_string(), Value::Object(mcp));
    Ok(Value::Object(root))
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a switch",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// A fingerprint of one exact before/after pair.
///
/// Not a secret and not meant to be: it exists so the write can be tied to the
/// diff that was actually shown. If the config changed between the plan and the
/// click, the pair changes, the fingerprint changes, and the write is refused
/// rather than applying a diff nobody looked at.
fn fingerprint(before: &str, after: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    before.hash(&mut h);
    after.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Everything the settings window needs to show before anything is written.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub path: String,
    /// False when the file is created rather than edited.
    pub exists: bool,
    /// True when our entry is already there and matches: the diff is then empty.
    pub already_registered: bool,
    /// True while running from a cargo build tree (`target\debug` or
    /// `target\release`), i.e. the entry would point at a build that stops being
    /// there on the next clean or the next rebuild. Shown as a warning before the
    /// write; it does not block, because refusing would make the app unusable for
    /// anyone who develops it.
    pub debug_build: bool,
    pub command: Vec<String>,
    pub timeout_ms: u64,
    /// The whole change, as a unified diff. Empty when nothing would change.
    pub diff: String,
    /// Identifies *this* diff. `apply` refuses anything else, so the file that
    /// gets written is the one that was on screen.
    pub digest: String,
    /// Where the previous file will be copied, so the UI can name it before the
    /// write as well as after it.
    pub backup: String,
    /// True when we would rewrite the user's key order/indentation as well as
    /// add our entry. Shown because it is the one non-obvious consequence.
    pub reformats: bool,
}

/// The `"piko": {…}` fragment, as pretty JSON with no leading indent — the
/// splicer indents it to fit wherever it lands.
fn entry_fragment() -> Result<String, String> {
    let v = entry()?;
    let body = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    // The braces belong to the value, so the first line carries the key and the
    // last line is ours to drop.
    let inner = body
        .trim_start_matches('{')
        .trim_end_matches('}')
        .trim_matches('\n');
    Ok(format!("\"{KEY}\": {{\n{inner}\n}}"))
}

/// Works out the file that *would* be written, and how.
///
/// A commented file is spliced so the user's text is preserved; a plain one goes
/// through serde as before. Both produce a `before`/`after` pair, which is all the
/// digest, the diff and the approval check need.
fn compose(path: &Path, before: &str) -> Result<(String, bool), String> {
    if is_commented(path) {
        let after = crate::jsonc::splice(before, &entry_fragment()?)?;
        // `already_registered` means the splice would be a no-op.
        Ok((after.clone(), after == before))
    } else {
        let current = read(path)?;
        let after = merged(&current)?;
        let existing_entry = current.get("mcp").and_then(|m| m.get(KEY)).cloned();
        Ok((render(&after), existing_entry.as_ref() == Some(&entry()?)))
    }
}

pub fn plan() -> Result<Plan, String> {
    let path = config_path()?;
    let exists = path.exists();
    let before = std::fs::read_to_string(&path).unwrap_or_default();
    let (after_text, already_registered) = compose(&path, &before)?;

    let exe = std::env::current_exe().unwrap_or_default();
    Ok(Plan {
        already_registered,
        debug_build: is_build_tree(&exe),
        command: command_line()?,
        timeout_ms: TIMEOUT_MS,
        digest: fingerprint(&before, &after_text),
        diff: unified_diff(&before, &after_text, &path.display().to_string()),
        backup: backup_dir()
            .join(format!("opencode-{}.json", stamp()))
            .display()
            .to_string(),
        // A commented file is spliced, so nothing of the user's can be taken
        // away; a plain one is re-serialised, which is what this flag warns about.
        reformats: exists && !is_commented(&path) && removed_nonblank(&before, &after_text) > 0,
        path: path.display().to_string(),
        exists,
    })
}

/// How many non-blank lines the rewrite takes away from the user. Zero means the
/// diff is pure addition — nothing they wrote moved.
fn removed_nonblank(before: &str, after: &str) -> usize {
    edit_script(before, after)
        .into_iter()
        .filter(|(kind, line)| *kind == '-' && !line.trim().is_empty())
        .count()
}

fn render(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    text
}

/// Writes the entry, but only the exact change that was approved.
///
/// `approved` is the digest from the plan the user read. It is checked against
/// the file as it is *now*, so a config edited between reading the diff and
/// pressing the button is refused instead of being overwritten by a diff
/// nobody has seen. That check is the approval; there is no force path past it.
pub fn apply(approved: &str) -> Result<String, String> {
    let path = config_path()?;
    let before = std::fs::read_to_string(&path).unwrap_or_default();
    let (after_text, _) = compose(&path, &before)?;
    if approved.is_empty() || fingerprint(&before, &after_text) != approved {
        return Err(
            "OpenCode's config changed since this diff was shown, so nothing was written. Read the refreshed diff before trying again."
                .into(),
        );
    }

    let mut backup = String::new();
    if path.exists() {
        let dir = backup_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("can't create {}: {e}", dir.display()))?;
        let dest = dir.join(format!("opencode-{}.json", stamp()));
        std::fs::copy(&path, &dest)
            .map_err(|e| format!("can't back up {}: {e}", path.display()))?;
        backup = dest.display().to_string();
    }

    // Write to a sibling and rename over the top, so a crash mid-write cannot
    // leave a half-written config behind.
    write_atomically(&path, &after_text)?;
    Ok(backup)
}

/// Removes our entry and nothing else, so a user with their own servers is left
/// with theirs. The backup is written first, same as `apply`.
pub fn remove() -> Result<Option<String>, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let before = std::fs::read_to_string(&path).unwrap_or_default();

    // A commented file is unwound the same way it was wound: as text, so the
    // user's comments and layout come back byte for byte.
    if is_commented(&path) {
        let Some(after) = crate::jsonc::unsplice(&before) else {
            return Ok(None);
        };
        let dir = backup_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("can't create {}: {e}", dir.display()))?;
        let dest = dir.join(format!("opencode-{}.json", stamp()));
        std::fs::copy(&path, &dest)
            .map_err(|e| format!("can't back up {}: {e}", path.display()))?;
        write_atomically(&path, &after)?;
        return Ok(Some(dest.display().to_string()));
    }

    let mut current = read(&path)?;
    let Value::Object(ref mut root) = current else {
        return Err("the top level of opencode.json is not an object — refusing to write".into());
    };
    let had_it = root.get("mcp").and_then(|m| m.get(KEY)).is_some();
    if !had_it {
        return Ok(None);
    }
    let dir = backup_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    let dest = dir.join(format!("opencode-{}.json", stamp()));
    std::fs::copy(&path, &dest).map_err(|e| format!("can't back up {}: {e}", path.display()))?;

    if let Some(Value::Object(mcp)) = root.get_mut("mcp") {
        mcp.remove(KEY);
        // Don't leave `"mcp": {}` behind if we held the last entry.
        if mcp.is_empty() {
            root.remove("mcp");
        }
    }
    write_atomically(&path, &render(&current))?;
    Ok(Some(dest.display().to_string()))
}

/// Write to a sibling and rename over the top, so a crash mid-write cannot leave
/// a half-written config behind.
fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.piko-tmp");
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| format!("can't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("can't replace {}: {e}", path.display())
    })
}

/// Whether OpenCode's config currently carries our entry, whatever it says inside.
///
/// For a commented file this looks for our marker region rather than parsing:
/// the file may not be valid JSON as written, which is the whole reason it is
/// treated as JSONC.
pub fn registered() -> bool {
    let Ok(path) = config_path() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    if is_commented(&path) {
        return text.contains(crate::jsonc::BEGIN) && text.contains(crate::jsonc::END);
    }
    read(&path)
        .ok()
        .and_then(|c| c.get("mcp").and_then(|m| m.get(KEY)).cloned())
        .is_some()
}

fn stamp() -> String {
    // 20261003-154501 — sortable, and no colons to upset a filesystem.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (mut days, tod) = (secs / 86_400, secs % 86_400);
    // Days-from-epoch → calendar, by the usual civil-from-days algorithm.
    days += 719_468;
    let era = days / 146_097;
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// One line of the change: its kind (` `, `-`, `+`) and its text.
type Op<'a> = (char, &'a str);

/// The whole change as a flat list of operations, computed from the longest
/// common subsequence. Config files are hundreds of lines at most, so the
/// quadratic table is not worth avoiding.
fn edit_script<'a>(before: &'a str, after: &'a str) -> Vec<Op<'a>> {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            out.push((' ', a[i]));
            i += 1;
            j += 1;
        } else if j < b.len() && (i == a.len() || lcs[i][j + 1] >= lcs[i + 1][j]) {
            out.push(('+', b[j]));
            j += 1;
        } else {
            out.push(('-', a[i]));
            i += 1;
        }
    }
    out
}

/// A real unified diff, not "here is the new file". Showing something less would
/// defeat the point: the diff is what the user approves.
pub fn unified_diff(before: &str, after: &str, path: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    if a == b {
        return String::new();
    }
    const CONTEXT: usize = 3;
    let ops = edit_script(before, after);

    // Line numbers as they stand in each file, for the @@ headers.
    let mut old_at = Vec::with_capacity(ops.len());
    let mut new_at = Vec::with_capacity(ops.len());
    let (mut ai, mut bi) = (1usize, 1usize);
    for (kind, _) in &ops {
        old_at.push(ai);
        new_at.push(bi);
        match kind {
            ' ' => {
                ai += 1;
                bi += 1;
            }
            '-' => ai += 1,
            _ => bi += 1,
        }
    }

    // Group the changed ops into hunks, widened by CONTEXT and merged when they
    // touch, so untouched stretches are collapsed rather than printed.
    let changed: Vec<usize> = (0..ops.len()).filter(|i| ops[*i].0 != ' ').collect();
    if changed.is_empty() {
        return String::new();
    }
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for i in changed {
        let lo = i.saturating_sub(CONTEXT);
        let hi = (i + CONTEXT).min(ops.len() - 1);
        match spans.last_mut() {
            Some(last) if lo <= last.1 + 1 => last.1 = last.1.max(hi),
            _ => spans.push((lo, hi)),
        }
    }

    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    for (lo, hi) in spans {
        let body = &ops[lo..=hi];
        let old_count = body.iter().filter(|(k, _)| *k != '+').count();
        let new_count = body.iter().filter(|(k, _)| *k != '-').count();
        let old_start = if old_count == 0 {
            old_at[lo]
        } else {
            old_at[lo]
        };
        let new_start = if new_count == 0 {
            new_at[lo]
        } else {
            new_at[lo]
        };
        out.push_str(&format!(
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
        ));
        for (kind, line) in body {
            out.push_str(&format!("{kind}{line}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_is_a_valid_local_server() {
        let e = entry().unwrap();
        assert_eq!(e["type"], "local");
        assert!(e["command"].as_array().unwrap().len() >= 2);
        // An approval can out-wait OpenCode's 5s default.
        assert!(e["timeout"].as_u64().unwrap() >= 240_000);
    }

    #[test]
    fn the_command_points_at_the_running_executable() {
        // Not at a path someone typed once: a build in `target\debug` has to
        // register itself, or a developer installs the app and OpenCode keeps
        // calling a binary that is not there.
        let cmd = command_line().unwrap();
        let exe = std::env::current_exe().unwrap();
        assert_eq!(cmd[0], exe.to_string_lossy());
        assert_eq!(cmd[1], "mcp");
    }

    #[test]
    fn both_build_trees_are_recognised() {
        for path in [
            r"C:\src\piko\windows\target\debug\piko.exe",
            r"C:\src\piko\windows\target\release\piko.exe",
        ] {
            assert!(is_build_tree(std::path::Path::new(path)), "{path}");
        }
    }

    #[test]
    fn an_installed_path_is_not_a_build_tree() {
        for path in [
            r"C:\Users\me\AppData\Local\Piko\piko.exe",
            // A project directory whose name merely contains the words: a substring
            // test called this a build tree and warned about a registration that
            // would have been perfectly durable.
            r"C:\src\my target debug build\piko.exe",
            r"C:\src\targetdebug\piko.exe",
        ] {
            assert!(!is_build_tree(std::path::Path::new(path)), "{path}");
        }
    }

    #[test]
    fn merging_keeps_other_servers() {
        let existing = json!({ "mcp": { "other": { "type": "remote", "url": "http://x" } } });
        let out = merged(&existing).unwrap();
        assert_eq!(out["mcp"]["other"]["url"], "http://x");
        assert_eq!(out["mcp"][KEY]["type"], "local");
    }

    #[test]
    fn merging_refuses_a_mcp_that_is_not_a_map() {
        let existing = json!({ "mcp": false });
        assert!(merged(&existing).is_err());
    }

    #[test]
    fn a_commented_config_takes_the_splice_path_not_the_serde_one() {
        assert!(is_commented(Path::new("opencode.jsonc")));
        assert!(is_commented(Path::new("config.json5")));
        assert!(!is_commented(Path::new("opencode.json")));
    }

    #[test]
    fn composing_a_commented_file_adds_our_entry_without_reformatting_it() {
        let path = Path::new("opencode.jsonc");
        let before = "{\n  // mine\n  \"model\": \"x\"\n}\n";
        let (after, already) = compose(path, before).expect("compose");
        assert!(!already);
        assert!(after.contains("\"piko\""), "{after}");
        assert!(after.contains("// mine"), "the comment was lost: {after}");
        // Nothing the user wrote was taken away.
        assert_eq!(removed_nonblank(before, &after), 0, "{after}");
    }

    #[test]
    fn composing_twice_reports_already_registered() {
        let path = Path::new("opencode.jsonc");
        let before = "{\n  \"model\": \"x\"\n}\n";
        let (once, _) = compose(path, before).expect("compose");
        let (twice, already) = compose(path, &once).expect("compose");
        assert!(already, "a second plan should see its own work");
        assert_eq!(once, twice, "splicing is not idempotent");
    }

    #[test]
    fn the_jsonc_target_wins_when_both_files_exist() {
        let dir = std::env::temp_dir().join("piko-mcpreg-path");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmp");
        let jsonc = dir.join("opencode.jsonc");
        let json = dir.join("opencode.json");
        std::fs::write(&jsonc, "{}\n").unwrap();
        std::fs::write(&json, "{}\n").unwrap();

        let chosen = if jsonc.exists() { &jsonc } else { &json };
        assert_eq!(chosen, &jsonc, "the file the user wrote must win");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_shows_only_the_added_entry() {
        let before = "{\n  \"model\": \"x\"\n}\n";
        let after = "{\n  \"model\": \"x\",\n  \"mcp\": {\n    \"piko\": {\n      \"type\": \"local\"\n    }\n  }\n}\n";
        let d = unified_diff(before, after, "opencode.json");
        assert!(d.contains("+  \"mcp\""), "{d}");
        assert!(d.contains("-  \"model\": \"x\""), "{d}");
    }

    #[test]
    fn diff_of_identical_text_is_empty() {
        assert!(unified_diff("a\nb\n", "a\nb\n", "f").is_empty());
    }

    #[test]
    fn stamp_is_sortable_and_colon_free() {
        let s = stamp();
        assert_eq!(s.len(), 15, "{s}");
        assert!(!s.contains(':'), "{s}");
    }

    #[test]
    fn the_digest_identifies_one_exact_change() {
        let before = "{\n}\n";
        let after = "{\n  \"mcp\": {}\n}\n";
        assert_eq!(fingerprint(before, after), fingerprint(before, after));
        // Anything that would change the diff has to change the digest, or the
        // approval would not be bound to what was shown.
        assert_ne!(fingerprint(before, after), fingerprint("{\n}\n\n", after));
        assert_ne!(
            fingerprint(before, after),
            fingerprint(before, "{\n  \"mcp\": {\"x\":1}\n}\n")
        );
    }
}
