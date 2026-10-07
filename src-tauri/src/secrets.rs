// API keys live in the Windows Credential Manager, never on disk and never in
// the front end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "fr.louisraille.piko";

/// Every key Piko may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "opencode-url",
    "opencode-username",
    "opencode-password",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

/// The keys that unlock an integration, as opposed to the ones that point Piko at
/// OpenCode.
///
/// Counted separately on purpose: "3 API keys stored" that include the OpenCode
/// username and password would be a claim the badge cannot support, and the badge's
/// whole job is to be believed. None of these is required - an integration with no
/// key is simply not set up, which is why the badge is grey rather than red.
pub const INTEGRATION_KEYS: &[&str] = &[
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

/// How many of them are stored.
///
/// A count and not the keys: the island is told what exists, never what it is. One
/// round trip instead of one per key, and nothing that could be logged.
pub fn stored_count() -> usize {
    INTEGRATION_KEYS.iter().filter(|k| present(k)).count()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}
