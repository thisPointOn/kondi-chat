mod protocol;
mod app;
mod ui;

use std::io;
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
    terminal::{disable_raw_mode, enable_raw_mode},
};
use ratatui::{backend::CrosstermBackend, Terminal, TerminalOptions, Viewport};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use std::process::Stdio;

use app::App;
use protocol::{BackendEvent, TuiCommand};

/// Height of the live inline viewport (status + in-progress + input + model).
/// 18 rows is enough for a roomy compose area + 8 lines of streaming preview.
const VIEWPORT_HEIGHT: u16 = 18;

#[tokio::main]
async fn main() -> io::Result<()> {
    // Start the Node.js backend as a child process
    // Find project root — walk up from current dir until we find package.json
    let project_root = {
        let mut dir = std::env::current_dir()?;
        loop {
            if dir.join("package.json").exists() { break dir; }
            if dir.join("tui").join("Cargo.toml").exists() { break dir; }
            if !dir.pop() {
                // Fallback: assume parent of tui/
                dir = std::env::current_dir()?.parent().unwrap_or(&std::env::current_dir()?).to_path_buf();
                break dir;
            }
        }
    };

    // Spec 10 — non-interactive mode bypasses the TUI entirely.
    let forwarded: Vec<String> = std::env::args().skip(1).collect();
    let is_non_interactive = forwarded.iter().any(|a|
        a == "--prompt" || a == "--pipe" || a == "--json" || a == "--sessions"
    );
    if is_non_interactive {
        let mut args = vec!["tsx".to_string(), "src/cli/backend.ts".to_string()];
        args.extend(forwarded);
        let status = TokioCommand::new("npx")
            .args(&args)
            .current_dir(&project_root)
            .status()
            .await
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("Failed to start backend: {e}")))?;
        std::process::exit(status.code().unwrap_or(1));
    }

    // Ratatui renders to stderr (see below), so the backend's stderr MUST NOT
    // be inherited — a single retry/warning write would corrupt the frame.
    // Pipe it to an append-only log file under the project's .kondi-chat dir.
    let log_dir = project_root.join(".kondi-chat");
    std::fs::create_dir_all(&log_dir).ok();
    let backend_log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("backend.log"))
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("Failed to open backend log: {e}")))?;
    let mut child = TokioCommand::new("npx")
        .args(["tsx", "src/cli/backend.ts"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(backend_log))
        .current_dir(&project_root)
        .spawn()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("Failed to start backend: {e}")))?;

    let stdin = child.stdin.take().expect("backend stdin");
    let stdout = child.stdout.take().expect("backend stdout");
    let mut reader = BufReader::new(stdout).lines();
    let mut writer = stdin;

    // Setup terminal — codex pattern.
    //
    // We do NOT enter the alternate screen and do NOT capture mouse events.
    // Instead we use Ratatui's inline viewport: a fixed-height region
    // anchored at the bottom of the terminal that holds the live UI
    // (status, in-progress message, input box, model indicator). Completed
    // chat messages are pushed into the *normal* terminal scrollback via
    // `terminal.insert_before`. The user's terminal then handles wheel
    // scroll, drag-to-select, and copy natively, exactly like cat or less.
    enable_raw_mode()?;
    let backend = CrosstermBackend::new(io::stderr());
    let mut terminal = Terminal::with_options(
        backend,
        TerminalOptions { viewport: Viewport::Inline(VIEWPORT_HEIGHT) },
    )?;

    let mut app = App::new();
    let mut needs_draw = true;

    loop {
        if needs_draw {
            // Drain completed messages into normal terminal scrollback.
            // insert_before's `set_line` does not wrap, so we must pre-wrap
            // every line to the terminal width or long content gets clipped
            // at the right edge instead of flowing onto the next row.
            let term_width = terminal.size()?.width as usize;
            let pending = std::mem::take(&mut app.pending_history);
            for item in pending {
                let wrapped = ui::wrap_lines_to_width(&item, term_width);
                let height = wrapped.len() as u16;
                if height == 0 { continue; }
                terminal.insert_before(height, |buf| {
                    for (i, line) in wrapped.iter().enumerate() {
                        buf.set_line(0, i as u16, line, buf.area.width);
                    }
                })?;
            }
            terminal.draw(|f| ui::draw(f, &mut app))?;
            needs_draw = false;
        }

        // When idle (not processing): poll with a long timeout so the
        // terminal stays quiet and the user can highlight / copy text
        // without escape-sequence interference.
        // When processing: shorter timeout so the spinner animates.
        let poll_ms = if app.is_processing { 100 } else { 500 };
        if crossterm::event::poll(std::time::Duration::from_millis(poll_ms))? {
            let evt = event::read()?;
            needs_draw = true; // any event → redraw
            if let Event::Key(key) = evt {
                // Spec 01 — when a permission dialog is open, intercept y/n/a.
                let permission_open = !app.pending_permissions.is_empty();
                if permission_open {
                    let pending_id = app.pending_permissions[0].id.clone();
                    let decision: Option<&str> = match (key.code, key.modifiers) {
                        (KeyCode::Char('y'), _) | (KeyCode::Char('Y'), _) | (KeyCode::Enter, _) => Some("approved"),
                        (KeyCode::Char('n'), _) | (KeyCode::Char('N'), _) | (KeyCode::Esc, _) => Some("denied"),
                        (KeyCode::Char('a'), _) | (KeyCode::Char('A'), _) => Some("approved-session"),
                        (KeyCode::Char('t'), _) | (KeyCode::Char('T'), _) => Some("approved-turn"),
                        (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                            send_command(&mut writer, TuiCommand::Quit).await;
                            break;
                        }
                        _ => None,
                    };
                    if let Some(d) = decision {
                        send_command(&mut writer, TuiCommand::PermissionResponse {
                            id: pending_id,
                            decision: d.to_string(),
                        }).await;
                        app.pending_permissions.remove(0);
                    }
                }
                if !permission_open { match (key.code, key.modifiers) {
                    (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                        send_command(&mut writer, TuiCommand::Quit).await;
                        break;
                    }
                    (KeyCode::Esc, _) => {
                        if app.detail_view.is_some() {
                            app.detail_view = None;
                        } else {
                            app.input.clear();
                        }
                    }
                    (KeyCode::Enter, _) => {
                        if !app.input.is_empty() {
                            let text = app.input.drain(..).collect::<String>();
                            if text.starts_with('/') {
                                send_command(&mut writer, TuiCommand::Command { text: text.clone() }).await;
                                app.add_user_message(&text);
                            } else {
                                send_command(&mut writer, TuiCommand::Submit { text: text.clone() }).await;
                                app.add_user_message(&text);
                            }
                        }
                    }
                    (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                        app.input.push('\n');
                    }
                    (KeyCode::Char('o'), KeyModifiers::CONTROL) => {
                        app.toggle_detail("tools");
                    }
                    (KeyCode::Char('t'), KeyModifiers::CONTROL) => {
                        app.toggle_detail("stats");
                    }
                    (KeyCode::Char('r'), KeyModifiers::CONTROL) => {
                        app.toggle_detail("reasoning");
                    }
                    (KeyCode::Char('y'), KeyModifiers::CONTROL) => {
                        app.copy_last_response();
                    }
                    (KeyCode::Char('a'), KeyModifiers::CONTROL) => {
                        app.show_activity = !app.show_activity;
                    }
                    (KeyCode::Backspace, _) => { app.input.pop(); }
                    // Bash-style input history. Wheel scroll, drag-select,
                    // and copy are all owned by the terminal now, so the
                    // arrow keys are free to recall history again.
                    (KeyCode::Up, _) => { app.history_prev(); }
                    (KeyCode::Down, _) => { app.history_next(); }
                    (KeyCode::Char(c), _) => { app.input.push(c); }
                    _ => {}
                } }
            }
        }

        // Drain whatever backend messages are immediately available.
        loop {
            match tokio::time::timeout(std::time::Duration::from_millis(0), reader.next_line()).await {
                Ok(Ok(Some(line))) => {
                    if let Ok(event) = serde_json::from_str::<BackendEvent>(&line) {
                        app.handle_backend_event(event);
                        needs_draw = true;
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(_)) => break,
                Err(_) => break,
            }
        }

        // Spinner tick: if processing and poll timed out, still redraw.
        if app.is_processing { needs_draw = true; }
    }

    // Inline viewport: just clear our viewport area and leave the
    // scrollback intact so the chat history is still visible after exit.
    terminal.clear()?;
    disable_raw_mode()?;
    terminal.show_cursor()?;
    Ok(())
}

async fn send_command(writer: &mut tokio::process::ChildStdin, cmd: TuiCommand) {
    let json = serde_json::to_string(&cmd).unwrap();
    let _ = writer.write_all(format!("{json}\n").as_bytes()).await;
    let _ = writer.flush().await;
}
