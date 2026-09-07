// Panda desktop shell — the process plane (issue #125).
//
// The product is the webview (repo root's Vite build, hash-routed, zero
// server); this executable exists only to host it plus the one capability a
// browser cannot have: spawning stdio agents and streaming their pipes.
// Why not tauri-plugin-shell: its scope model whitelists specific binaries,
// while Panda's product shape is "the user configures any local command" —
// an explicit process plane owned by this app is both simpler and honest
// about the trust boundary.
//
// Protocol with the webview (src/desktop/boot.ts):
//   stdio_spawn { program, args, cwd, onEvent: Channel } -> id
//   stdio_write { id, data }        (data = one complete NDJSON line)
//   stdio_kill { id }               (graceful: SIGTERM -> 3s -> SIGKILL)
// Channel events: stdout { data: base64 } | stderr { data: base64 } | exit { code }

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::engine::Engine as _;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Notify;

/// One live agent child. The `Child` itself is owned exclusively by the exit
/// watcher task (wait + terminate cannot share it); the table keeps only the
/// handles the commands need.
struct ProcEntry {
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    kill: Arc<Notify>,
}

#[derive(Default)]
struct ProcTable {
    next_id: AtomicU32,
    procs: Mutex<HashMap<u32, ProcEntry>>,
}

/// Events streamed to the webview. stdout/stderr carry base64 so a chunk
/// boundary inside a multi-byte UTF-8 sequence survives the hop (the JS side
/// decodes with a streaming TextDecoder).
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StdioEvent {
    Stdout { data: String },
    Stderr { data: String },
    Exit { code: Option<i32> },
}

/// Graceful teardown: SIGTERM, 3s grace, then SIGKILL — the same contract
/// test-agent's serve bridge implements. Returns the exit code when known.
async fn terminate_child(child: &mut Child) -> Option<i32> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            // SAFETY: sending a signal to our own child pid.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        }
        if let Ok(status) = tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
            return status.ok().and_then(|s| s.code());
        }
        // Grace elapsed — fall through to the hard kill.
    }
    let _ = child.start_kill();
    child.wait().await.ok().and_then(|s| s.code())
}

#[tauri::command]
async fn stdio_spawn(
    app: tauri::AppHandle,
    table: tauri::State<'_, ProcTable>,
    program: String,
    args: Vec<String>,
    cwd: String,
    on_event: Channel<StdioEvent>,
) -> Result<u32, String> {
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Orphan guard: dropping the Child (watcher task cancelled at app
        // exit) hard-kills the agent rather than leaking it.
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|err| format!("spawn {program:?} failed: {err}"))?;
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let id = table.next_id.fetch_add(1, Ordering::Relaxed);
    let kill = std::sync::Arc::new(Notify::new());
    table.procs.lock().unwrap().insert(
        id,
        ProcEntry {
            stdin: Arc::new(tokio::sync::Mutex::new(stdin.take())),
            kill: kill.clone(),
        },
    );

    // stdout: raw bytes -> base64 chunks. Read errors end the pump; the exit
    // watcher reports the reason the process is gone.
    if let Some(mut stdout) = stdout.take() {
        let event_tx = on_event.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if event_tx.send(StdioEvent::Stdout { data: BASE64.encode(&buf[..n]) }).is_err() {
                            break; // webview gone
                        }
                    }
                }
            }
        });
    }
    // stderr: same shape, surfaced separately — agent logs stay visible in
    // the devtools console instead of vanishing with the GUI's stdio.
    if let Some(mut stderr) = stderr.take() {
        let event_tx = on_event.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if event_tx.send(StdioEvent::Stderr { data: BASE64.encode(&buf[..n]) }).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }

    // Exit watcher: owns the Child. Natural exit and kill both funnel here;
    // the entry leaves the table exactly once, after the Exit event.
    let exit_tx = on_event.clone();
    tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = kill.notified() => terminate_child(&mut child).await,
        };
        let _ = exit_tx.send(StdioEvent::Exit { code: status });
        app.state::<ProcTable>().procs.lock().unwrap().remove(&id);
    });

    Ok(id)
}

#[tauri::command]
async fn stdio_write(
    table: tauri::State<'_, ProcTable>,
    id: u32,
    data: String,
) -> Result<(), String> {
    // Clone the Arc handles out synchronously; nothing holds the table lock
    // across an await.
    let stdin = table
        .procs
        .lock()
        .unwrap()
        .get(&id)
        .map(|entry| entry.stdin.clone())
        .ok_or_else(|| format!("stdio_write: no process {id}"))?;

    let mut stdin = stdin.lock().await;
    if let Some(stdin) = stdin.as_mut() {
        // Pipe stdio has no userspace buffer to flush — write_all is the
        // complete delivery.
        stdin
            .write_all(data.as_bytes())
            .await
            .map_err(|err| format!("stdio_write {id} failed: {err}"))
    } else {
        Err(format!("stdio_write: process {id} stdin already closed"))
    }
}

#[tauri::command]
async fn stdio_kill(table: tauri::State<'_, ProcTable>, id: u32) -> Result<(), String> {
    let kill = table
        .procs
        .lock()
        .unwrap()
        .get(&id)
        .map(|entry| entry.kill.clone());
    match kill {
        // Unknown id = already exited — kill is idempotent per the transport
        // contract, so success is the honest answer.
        Some(kill) => {
            kill.notify_one();
            Ok(())
        }
        None => {
            println!("[panda-desktop] stdio_kill for unknown process {id} (already exited)");
            Ok(())
        }
    }
}

/// Sweeps every tracked child (#7): drops the stdin handle (EOF — a
/// well-behaved stdio agent exits itself on a closed stdin) and arms the
/// graceful kill (SIGTERM -> 3s -> SIGKILL via the exit watcher). Used on app
/// exit and on webview (re)load; returns how many children were swept.
fn sweep_orphans(table: &ProcTable) -> usize {
    let procs = table.procs.lock().unwrap();
    let count = procs.len();
    for entry in procs.values() {
        // try_lock: the only writer competition is a stdio_write already in
        // flight — losing the race just means this child gets no EOF, the
        // kill below still terminates it.
        if let Ok(mut stdin) = entry.stdin.try_lock() {
            *stdin = None;
        }
        entry.kill.notify_one();
    }
    count
}

fn main() {
    tauri::Builder::default()
        .manage(ProcTable::default())
        .invoke_handler(tauri::generate_handler![stdio_spawn, stdio_write, stdio_kill])
        // Webview (re)load sweep (#7): a reload destroys the JS state that
        // owned these children — nobody will ever read their stdout again,
        // and without this they linger forever (a reconnect then races a
        // second agent over the same workspace). First boot hits an empty
        // table — a no-op.
        .on_page_load(|webview, payload| {
            if let tauri::webview::PageLoadEvent::Started = payload.event() {
                let swept = sweep_orphans(&webview.state::<ProcTable>());
                if swept > 0 {
                    println!("[panda-desktop] page (re)load: sweeping {swept} orphaned agent process(es)");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("panda desktop shell failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // #7: tao ends its event loop with std::process::exit —
                // destructors and the async runtime never run, so
                // kill_on_drop is dead code here. Terminating the agents at
                // Exit, synchronously waiting for the watchers, is the whole
                // of docs/user-guide.md's「退出 Panda 时所有 agent 子进程
                // 一并清理」promise.
                let table = app.state::<ProcTable>();
                let swept = sweep_orphans(&table);
                if swept > 0 {
                    println!("[panda-desktop] exiting: terminating {swept} agent process(es)");
                    // 3s SIGTERM grace + margin; past the deadline the
                    // watcher's SIGKILL is already armed — leaving beats
                    // hanging the quit forever.
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while !table.procs.lock().unwrap().is_empty() {
                        if Instant::now() >= deadline {
                            println!("[panda-desktop] exit sweep timed out with agent(s) still dying (SIGKILL armed)");
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
            }
        });
}
