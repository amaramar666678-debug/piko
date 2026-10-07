// Piko runs without a console window: Mochi is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `piko mcp` is OpenCode's MCP server, spoken over stdio. It is a different
    // program from the island: no window, no tray, just a bridge to the Piko
    // that is already running. Checked before anything else so the bridge never
    // touches the single-instance plugin or the island window.
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        std::process::exit(piko_lib::mcp_bridge());
    }
    piko_lib::run()
}
