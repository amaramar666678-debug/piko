// Editing a JSONC config without destroying the parts of it that are not ours.
//
// OpenCode reads `opencode.jsonc`, and that file is the user's own: comments,
// key order, indentation and all. Re-serialising it through `serde_json` to add
// one key would quietly throw all of that away — so for a commented file the
// entry is spliced in as text instead, inside a marker pair that makes the edit
// findable, replaceable and removable.
//
// Everything else in this file's approach still holds: nothing is written
// without a human having read the diff, the previous file is copied to a backup
// first, and the write is refused unless the file still matches the approved
// fingerprint.
//
// The scanner below is the risky part, so it refuses rather than guesses. If it
// cannot see the structure clearly enough to be sure where the `mcp` object
// begins, the caller gets an error and nothing is written.

/// Start and end of the region we own. Both are JSONC comments, so they are
/// invisible to any conformant reader, and they let a later run find exactly
/// what a previous run added.
pub const BEGIN: &str = "/*piko-mcp:begin*/";
pub const END: &str = "/*piko-mcp:end*/";

/// Where a top-level key's value starts.
pub enum Slot {
    /// There is no `mcp` key: splice a whole `"mcp": { … }` in after the root `{`.
    NoMcp { insert_at: usize },
    /// There is an `mcp` object: splice just our key in after its `{`.
    McpObject { insert_at: usize },
}

/// Walks JSONC well enough to find the root object's `{` and, if present, the `{`
/// that opens the top-level `mcp` value.
///
/// Strings and both comment styles are skipped, so a `"mcp"` inside a string or a
/// comment is never mistaken for the real key.
pub fn find_slot(text: &str) -> Result<Slot, String> {
    let bytes = text.as_bytes();

    // Root `{`.
    let root = match find_char(text, b'{', 0) {
        Some(at) => at,
        None => return Err("no `{` found, so this is not a JSONC object".into()),
    };
    let mut i = root + 1;

    loop {
        i = skip_trivia(text, i);
        if i >= bytes.len() {
            return Err("the root object is never closed".into());
        }
        match bytes[i] {
            b'}' => {
                return Ok(Slot::NoMcp {
                    insert_at: root + 1,
                })
            }
            b',' => {
                i += 1;
            }
            b'"' => {
                let (key, after) = read_string(text, i)?;
                i = skip_trivia(text, after);
                if i >= bytes.len() || bytes[i] != b':' {
                    return Err("a top-level key is not followed by `:`".into());
                }
                i = skip_trivia(text, i + 1);
                if key == "mcp" {
                    // Only a plain object can be spliced into safely. `"mcp":
                    // false` or a string would be overwritten by an insert.
                    if i >= bytes.len() || bytes[i] != b'{' {
                        return Err(
                            "\"mcp\" is present but is not an object — fix it by hand before registering"
                                .into(),
                        );
                    }
                    return Ok(Slot::McpObject { insert_at: i + 1 });
                }
                i = skip_value(text, i)?;
            }
            _ => {
                return Err(format!(
                    "unexpected character {} at byte {i} in the root object",
                    bytes[i] as char
                ))
            }
        }
    }
}

/// Inserts `entry` (a `"piko": {…}` fragment) into `text`, replacing a region
/// this module wrote earlier if one is there.
///
/// The marker pair always wraps the *whole* thing we added, including the
/// `"mcp": { … }` wrapper when there was no `mcp` key to go inside. That makes
/// removal symmetric with insertion: `unsplice` can cut exactly BEGIN..END plus
/// one trailing comma and hand the file back unchanged.
pub fn splice(text: &str, entry: &str) -> Result<String, String> {
    // A region from a previous run is cut out and the insert redone from scratch.
    // Re-indenting into the old block instead would drift a little each time, so
    // a second visit would show a whitespace-only diff and the Settings window
    // could never say "already registered".
    if marker_span(text).is_some() {
        let stripped = remove_region(text).ok_or("the marker region is malformed")?;
        return splice(&stripped, entry);
    }

    let wrap = match find_slot(text)? {
        Slot::NoMcp { insert_at } => {
            let body = reindent(entry, 4);
            // No trailing newline after END: whatever followed our `{` is the
            // user's own whitespace and has to be left exactly as it was.
            (
                insert_at,
                format!("\n  {BEGIN}\n  \"mcp\": {{\n{body}\n  }},\n  {END}"),
            )
        }
        Slot::McpObject { insert_at } => {
            let body = reindent(entry, 4);
            (insert_at, format!("\n    {BEGIN}\n{body},\n    {END}"))
        }
    };

    let mut out = String::with_capacity(text.len() + wrap.1.len());
    out.push_str(&text[..wrap.0]);
    out.push_str(&wrap.1);
    out.push_str(&text[wrap.0..]);
    Ok(out)
}

/// Shifts every line of `entry` right by `n` spaces.
fn reindent(entry: &str, n: usize) -> String {
    let pad = " ".repeat(n);
    entry
        .lines()
        .map(|l| format!("{pad}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Takes back out whatever `splice` added. Returns `None` when there was nothing
/// of ours to remove, which is not an error.
pub fn unsplice(text: &str) -> Option<String> {
    remove_region(text)
}

/// Byte range of the region we own, END included.
fn marker_span(text: &str) -> Option<(usize, usize)> {
    let b = text.find(BEGIN)?;
    let e = text.find(END)? + END.len();
    (e > b).then_some((b, e))
}

/// Cuts out `b..e` along with the whitespace we added around it.
///
/// The insert point is always immediately after a `{` and our block ends exactly
/// at END, so every byte between those two points is ours: the whitespace before
/// BEGIN and the comma inside the block. Anything at or after END belongs to the
/// user and is kept verbatim — trimming it would eat their line breaks.
fn remove_region(text: &str) -> Option<String> {
    let (b, e) = marker_span(text)?;
    let head = text[..b].trim_end_matches([' ', '\t', '\n', '\r']);
    let mut out = String::with_capacity(text.len());
    out.push_str(head);
    out.push_str(&text[e..]);
    Some(out)
}

/// Byte offset of the first `needle` at or after `from`, ignoring anything
/// inside a string or a comment.
fn find_char(text: &str, needle: u8, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let (_, after) = read_string(text, i).ok()?;
                i = after;
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                i = text[i..]
                    .find('\n')
                    .map(|n| i + n + 1)
                    .unwrap_or(bytes.len());
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => {
                i = text[i + 2..]
                    .find("*/")
                    .map(|n| i + 2 + n + 2)
                    .unwrap_or(bytes.len());
            }
            c if c == needle => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// Skips whitespace and comments.
fn skip_trivia(text: &str, mut i: usize) -> usize {
    let bytes = text.as_bytes();
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            i = text[i..]
                .find('\n')
                .map(|n| i + n + 1)
                .unwrap_or(bytes.len());
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i = text[i + 2..]
                .find("*/")
                .map(|n| i + 2 + n + 2)
                .unwrap_or(bytes.len());
            continue;
        }
        return i;
    }
}

/// Reads a `"…"` string starting at `i`, honouring backslash escapes. Returns the
/// unescaped-enough content and the offset just past the closing quote.
fn read_string(text: &str, i: usize) -> Result<(String, usize), String> {
    let bytes = text.as_bytes();
    debug_assert_eq!(bytes[i], b'"');
    let mut out = String::new();
    let mut j = i + 1;
    while j < bytes.len() {
        match bytes[j] {
            b'\\' => {
                if j + 1 >= bytes.len() {
                    return Err("a string ends in a backslash".into());
                }
                let esc = bytes[j + 1];
                out.push(match esc {
                    b'n' => '\n',
                    b't' => '\t',
                    b'r' => '\r',
                    other => other as char,
                });
                j += 2;
            }
            b'"' => return Ok((out, j + 1)),
            _ => {
                // Copy the whole UTF-8 sequence, not one byte, so a multi-byte
                // character cannot be corrupted into U+FFFD.
                let ch = text[j..].chars().next().ok_or("bad utf-8 in a string")?;
                out.push(ch);
                j += ch.len_utf8();
            }
        }
    }
    Err("a string is never closed".into())
}

/// Skips one value starting at `i`, returning the offset just past it. Only the
/// shapes that actually appear in a config are handled; anything else is an error
/// rather than a guess.
fn skip_value(text: &str, i: usize) -> Result<usize, String> {
    let bytes = text.as_bytes();
    match bytes.get(i) {
        None => Err("the file ends where a value was expected".into()),
        Some(b'"') => read_string(text, i).map(|(_, after)| after),
        Some(b'{') | Some(b'[') => {
            let open = bytes[i];
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth = 0usize;
            let mut j = i;
            while j < bytes.len() {
                match bytes[j] {
                    b'"' => {
                        let (_, after) = read_string(text, j)?;
                        j = after;
                        continue;
                    }
                    b'/' if j + 1 < bytes.len()
                        && (bytes[j + 1] == b'/' || bytes[j + 1] == b'*') =>
                    {
                        j = skip_trivia_at(text, j);
                        continue;
                    }
                    c if c == open => depth += 1,
                    c if c == close => {
                        depth -= 1;
                        if depth == 0 {
                            return Ok(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            Err("a bracket is never closed".into())
        }
        Some(_) => {
            // A number, true, false or null: run to the next structural byte.
            let mut j = i;
            while j < bytes.len()
                && !bytes[j].is_ascii_whitespace()
                && !matches!(bytes[j], b',' | b'}' | b']')
            {
                j += 1;
            }
            Ok(j)
        }
    }
}

/// Like `skip_trivia`, but guaranteed to consume a comment if one starts here.
fn skip_trivia_at(text: &str, i: usize) -> usize {
    let after = skip_trivia(text, i);
    if after > i {
        after
    } else if text[i..].starts_with("//") {
        text[i..]
            .find('\n')
            .map(|n| i + n + 1)
            .unwrap_or(text.len())
    } else {
        text[i + 2..]
            .find("*/")
            .map(|n| i + 2 + n + 2)
            .unwrap_or(text.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = "\"piko\": { \"type\": \"local\", \"enabled\": true }";

    fn spliced(text: &str) -> String {
        splice(text, ENTRY).expect("splice")
    }

    /// Every splice/unsplice pair must hand back exactly what it was given.
    fn round_trips(before: &str) {
        let after = spliced(before);
        let back = unsplice(&after).unwrap_or_else(|| panic!("nothing to unsplice:\n{after}"));
        assert_eq!(back, before, "round trip changed the user's file");
    }

    #[test]
    fn a_config_with_no_mcp_gets_one() {
        let out = spliced(r#"{"model": "x"}"#);
        assert!(out.contains(BEGIN) && out.contains(END));
        assert!(out.contains("\"mcp\""));
        assert!(out.contains("\"piko\""));
        assert!(out.contains(r#""model": "x""#));
    }

    #[test]
    fn comments_and_layout_survive_byte_for_byte() {
        let before = "{\n  // my note\n  \"model\": \"x\", /* trailing */\n  \"provider\": { \"a\": 1 }\n}\n";
        let out = spliced(before);
        assert!(out.contains("// my note"), "a line comment was lost");
        assert!(out.contains("/* trailing */"), "a block comment was lost");
        assert!(
            out.contains("\"provider\": { \"a\": 1 }"),
            "formatting was rewritten"
        );
        round_trips(before);
    }

    #[test]
    fn an_existing_mcp_object_gets_our_key_inside_it() {
        let out = spliced(r#"{"mcp": { "other": { "type": "local" } }}"#);
        assert!(out.contains("\"other\""), "another server was lost");
        assert!(out.contains("\"piko\""));
        assert_eq!(out.matches("\"mcp\"").count(), 1, "{out}");
    }

    #[test]
    fn splicing_twice_does_not_duplicate_the_entry() {
        let once = spliced(r#"{"model":"x"}"#);
        let twice = spliced(&once);
        assert_eq!(twice.matches("\"piko\"").count(), 1, "{twice}");
        assert_eq!(twice.matches(BEGIN).count(), 1, "{twice}");
        assert_eq!(twice.matches(END).count(), 1, "{twice}");
    }

    #[test]
    fn removing_gives_back_the_original_text() {
        round_trips("{\n  // note\n  \"model\": \"x\"\n}\n");
    }

    #[test]
    fn removing_from_an_existing_mcp_object_gives_it_back() {
        round_trips("{\n  \"mcp\": {\n    \"other\": { \"type\": \"local\" }\n  }\n}\n");
    }

    #[test]
    fn a_single_line_file_survives_a_round_trip() {
        round_trips("{\"model\":\"x\"}");
    }

    #[test]
    fn a_file_ending_without_a_newline_survives_a_round_trip() {
        round_trips("{\n  \"model\": \"x\"\n}");
    }

    #[test]
    fn removing_from_a_file_that_never_had_our_entry_is_not_an_error() {
        assert!(unsplice(r#"{"model":"x"}"#).is_none());
    }

    #[test]
    fn a_word_mcp_inside_a_string_is_not_the_key() {
        let out = spliced(r#"{"note": "do not touch mcp here"}"#);
        assert_eq!(out.matches("\"mcp\"").count(), 1, "{out}");
        assert!(out.contains(r#""note": "do not touch mcp here""#));
    }

    #[test]
    fn a_word_mcp_inside_a_comment_is_not_the_key() {
        let before = "{\n  // the mcp key lives below\n  \"model\": \"x\"\n}\n";
        let out = spliced(before);
        assert_eq!(out.matches("\"mcp\"").count(), 1, "{out}");
        assert!(out.contains("// the mcp key lives below"));
        round_trips(before);
    }

    #[test]
    fn an_mcp_that_is_not_an_object_is_refused_not_overwritten() {
        let e = splice(r#"{"mcp": false}"#, ENTRY).expect_err("must refuse");
        assert!(e.contains("not an object"), "{e}");
    }

    #[test]
    fn a_file_that_is_not_an_object_is_refused() {
        assert!(splice("[1,2,3]", ENTRY).is_err());
    }

    #[test]
    fn an_unclosed_file_is_refused_rather_than_guessed() {
        assert!(splice("{\"model\": \"x\"", ENTRY).is_err());
    }

    #[test]
    fn an_escaped_quote_does_not_end_the_string_early() {
        let out = spliced(r#"{"note": "a \" b", "model": "x"}"#);
        assert!(out.contains(r#"\" "#), "the string was cut short");
        assert!(out.contains("\"piko\""));
    }

    #[test]
    fn a_brace_inside_a_string_does_not_confuse_the_depth_count() {
        let out = spliced(r#"{"note": "{[}]", "model": "x"}"#);
        assert!(out.contains("\"piko\""));
        assert_eq!(out.matches("\"mcp\"").count(), 1, "{out}");
    }

    #[test]
    fn a_nested_mcp_is_not_mistaken_for_the_top_level_one() {
        let out = spliced(r#"{"mcp": { "a": { "mcp": "decoy" } }}"#);
        assert!(out.contains("\"a\""));
        assert_eq!(out.matches(BEGIN).count(), 1, "{out}");
    }

    #[test]
    fn a_multibyte_character_is_not_corrupted() {
        // Splitting on byte offsets would turn these into U+FFFD.
        round_trips("{\n  \"note\": \"مرحبا بالعالم\", \"model\": \"x\"\n}\n");
        let out = spliced("{\n  \"note\": \"مرحبا\", \"model\": \"x\"\n}\n");
        assert!(out.contains("مرحبا"), "{out}");
    }

    #[test]
    fn a_comment_containing_our_marker_is_not_mistaken_for_our_region() {
        // Someone documenting the block must not let us rewrite their words.
        let before = "{\n  /* piko-mcp:begin is what we look for */\n  \"model\": \"x\"\n}\n";
        let out = spliced(before);
        assert!(out.contains("piko-mcp:begin is what we look for"), "{out}");
        assert_eq!(out.matches("\"piko\"").count(), 1, "{out}");
    }
}
