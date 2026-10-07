// The `piko.exe mcp` bridge, driven exactly as an MCP client drives it: stdin
// in, pipe out, stdout back. The pipe is built here so the test needs no window
// and no desktop.
//
// This earns its keep. The bridge once ran a reader thread and a writer thread
// over one synchronous duplex handle, and a pending `ReadFile` stopped any
// concurrent `WriteFile` on that handle dead: the very first request never
// reached the app. A unit test inside the library cannot see it, because the
// in-process pipe test writes with nothing else touching the handle. Only a real
// second process shows the deadlock.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PeekNamedPipe, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE,
    PIPE_WAIT,
};

const TIMEOUT: Duration = Duration::from_secs(20);

/// The name the bridge resolves for itself: `\\.\pipe\piko-mcp-<sid>`.
fn bridge_pipe_name() -> Option<String> {
    let out = Command::new("whoami").arg("/user").output().ok()?;
    let sid = String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .last()?
        .to_string();
    Some(format!(r"\\.\pipe\piko-mcp-{sid}"))
}

fn make_pipe(name: &str) -> windows::Win32::Foundation::HANDLE {
    let wide = windows::core::HSTRING::from(name);
    let ptr = windows::core::PCWSTR(wide.as_ptr());
    // SAFETY: `wide` is live for this call and CreateNamedPipeW copies the name.
    // Same shape as the app's own pipe: duplex, message-type, generous buffers.
    unsafe {
        CreateNamedPipeW(
            ptr,
            windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
            255,
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            0,
            None,
        )
    }
}

/// The bytes waiting on a pipe, without taking the handle.
fn available(pipe: windows::Win32::Foundation::HANDLE) -> Option<u32> {
    let mut bytes = 0u32;
    // SAFETY: an open handle; peeking neither blocks nor consumes.
    let peeked = unsafe { PeekNamedPipe(pipe, None, 0, None, Some(&mut bytes), None) };
    peeked.is_ok().then_some(bytes)
}

/// Waits for one whole message, however many reads that takes.
fn await_message(pipe: windows::Win32::Foundation::HANDLE) -> Option<String> {
    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        if available(pipe).is_some_and(|bytes| bytes > 0) {
            let mut message = Vec::new();
            let mut buffer = vec![0u8; 256 * 1024];
            loop {
                let mut read = 0u32;
                // SAFETY: the buffer is live and `read` bounds what is kept.
                let result = unsafe {
                    windows::Win32::Storage::FileSystem::ReadFile(
                        pipe,
                        Some(buffer.as_mut_slice()),
                        Some(&mut read),
                        None,
                    )
                };
                let more = result.as_ref().err().is_some_and(|e| {
                    e.code() == windows::Win32::Foundation::ERROR_MORE_DATA.to_hresult()
                });
                if result.is_err() && !more {
                    return None;
                }
                message.extend_from_slice(&buffer[..read as usize]);
                let mut left = 0u32;
                // SAFETY: an open handle; reports the rest of this message.
                let peeked = unsafe { PeekNamedPipe(pipe, None, 0, None, None, Some(&mut left)) };
                if !more && (read as usize) < buffer.len() {
                    break;
                }
                if peeked.is_ok() && left == 0 {
                    break;
                }
            }
            return Some(String::from_utf8_lossy(&message).into_owned());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    None
}

fn send(pipe: windows::Win32::Foundation::HANDLE, payload: &str) {
    let mut written = 0u32;
    // SAFETY: `payload` outlives the call and the pipe is open for writing.
    let result = unsafe {
        windows::Win32::Storage::FileSystem::WriteFile(
            pipe,
            Some(payload.as_bytes()),
            Some(&mut written),
            None,
        )
    };
    assert!(result.is_ok(), "the reply could not be written");
    assert_eq!(written as usize, payload.len(), "the reply was cut short");
}

#[test]
fn the_bridge_carries_a_request_to_the_app_and_the_reply_back() {
    let Some(name) = bridge_pipe_name() else {
        eprintln!("no user SID, skipping");
        return;
    };
    let pipe = make_pipe(&name);
    assert!(!pipe.is_invalid(), "could not create the pipe");

    let mut child = Command::new(env!("CARGO_BIN_EXE_piko"))
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the bridge should start");

    // SAFETY: valid, unconnected instance; waits for the child to open it.
    unsafe { ConnectNamedPipe(pipe, None) }.ok();

    // Two requests back to back, the way a client really behaves. They have to both
    // arrive: a buffered reader takes every byte the handle offers in one go, so
    // asking the handle what is left comes back empty while the second request sits
    // unread in the buffer.
    let requests = [
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n",
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"screen_info\"}}\n",
];
    {
        let stdin = child.stdin.as_mut().expect("piped stdin");
        for request in requests {
            stdin.write_all(request.as_bytes()).expect("request");
        }
        stdin.flush().expect("flush");
    }

    for (request, id) in requests.iter().zip([1, 2]) {
        let arrived = await_message(pipe);
        assert_eq!(
            arrived.as_deref(),
            Some(*request),
            "request {id} never reached the app"
        );
        // â€¦and each reply has to come back out on stdout, newline-terminated.
        send(
            pipe,
            &format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"ok\":{id}}}}}\n"),
        );
    }
    // Closing stdin is how a client says "that is all", and it is what lets the
    // bridge finish and exit so that reading stdout runs out of bytes instead of
    // waiting forever.
    drop(child.stdin.take());
    let mut stdout = String::new();
    child
        .stdout
        .as_mut()
        .expect("piped stdout")
        .read_to_string(&mut stdout)
        .expect("stdout should be readable");

    let _ = child.kill();
    let _ = child.wait();
    // SAFETY: this test created the handle and closes it once.
    unsafe { windows::Win32::Foundation::CloseHandle(pipe) }.ok();

    for id in [1, 2] {
        assert!(
            stdout.contains(&format!("\"ok\":{id}")),
            "reply {id} never reached stdout, stdout was {stdout:?}"
        );
    }
}
