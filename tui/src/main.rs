mod protocol;
mod app;
mod ui;

use std::io;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyModifiers, MouseEvent, MouseEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    execute,
};
use ratatui::{backend::CrosstermBackend, Terminal};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use std::process::Stdio;

use app::App;
use protocol::{BackendEvent, TuiCommand};

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

    // Setup terminal
    enable_raw_mode()?;
    let mut stderr = io::stderr();
    execute!(stderr, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stderr);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new();

    loop {
        terminal.draw(|f| ui::draw(f, &mut app))?;

        if crossterm::event::poll(std::time::Duration::from_millis(50))? {
            let evt = event::read()?;
            if let Event::Mouse(MouseEvent { kind, column, row, .. }) = evt {
                use crossterm::event::MouseButton;
                match kind {
                    MouseEventKind::ScrollUp => {
                        if app.detail_view.is_some() {
                            app.detail_scroll = app.detail_scroll.saturating_add(3);
                        } else {
                            app.chat_scroll = app.chat_scroll.saturating_add(3);
                        }
                    }
                    MouseEventKind::ScrollDown => {
                        if app.detail_view.is_some() {
                            app.detail_scroll = app.detail_scroll.saturating_sub(3);
                        } else {
                            app.chat_scroll = app.chat_scroll.saturating_sub(3);
                        }
                    }
                    MouseEventKind::Down(MouseButton::Left) | MouseEventKind::Drag(MouseButton::Left) => {
                        // Click/drag on the scrollbar column (rightmost column
                        // of the chat area). Translate y → chat_scroll.
                        let term_w = terminal.size()?.width;
                        if app.detail_view.is_none() && column + 1 >= term_w {
                            let (chat_y, chat_h, max_scroll) = app.chat_scroll_meta;
                            if max_scroll > 0 && chat_h > 0 && row >= chat_y && row < chat_y + chat_h {
                                let rel = (row - chat_y) as usize;
                                let denom = chat_h.saturating_sub(1) as usize;
                                // Top of bar = oldest = max chat_scroll, bottom = newest = 0
                                let from_top_ratio = rel as f32 / denom.max(1) as f32;
                                let from_top = (from_top_ratio * max_scroll as f32).round() as usize;
                                app.chat_scroll = max_scroll.saturating_sub(from_top);
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let Event::Key(key) = evt {
                // Spec 01 — when a permission dialog is open, intercept y/n/a.
                let permission_open = !app.pending_permissions.is_empty();
                if permission_open {
                    let pending_id = app.pending_permissions[0].id.clone();
                    let decision: Option<&str> = match (key.code, key.modifiers) {
                        (KeyCode::Char('y'), _) | (KeyCode::Char('Y'), _) => Some("approved"),
                        (KeyCode::Char('n'), _) | (KeyCode::Char('N'), _) | (KeyCode::Esc, _) => Some("denied"),
                        (KeyCode::Char('a'), _) | (KeyCode::Char('A'), _) => Some("approved-session"),
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
                    (KeyCode::Char('a'), KeyModifiers::CONTROL) => {
                        app.show_activity = !app.show_activity;
                    }
                    (KeyCode::Backspace, _) => { app.input.pop(); }
                    (KeyCode::Up, _) => {
                        if app.detail_view.is_some() {
                            app.detail_scroll = app.detail_scroll.saturating_add(3);
                        } else {
                            app.chat_scroll = app.chat_scroll.saturating_add(1);
                        }
                    }
                    (KeyCode::Down, _) => {
                        if app.detail_view.is_some() {
                            app.detail_scroll = app.detail_scroll.saturating_sub(3);
                        } else {
                            app.chat_scroll = app.chat_scroll.saturating_sub(1);
                        }
                    }
                    (KeyCode::Char(c), _) => { app.input.push(c); }
                    _ => {}
                } }
            }
        }

        // Drain all available backend messages before next draw
        loop {
            match tokio::time::timeout(std::time::Duration::from_millis(10), reader.next_line()).await {
                Ok(Ok(Some(line))) => {
                    if let Ok(event) = serde_json::from_str::<BackendEvent>(&line) {
                        app.handle_backend_event(event);
                    }
                }
                Ok(Ok(None)) => { /* backend closed — will exit on next draw check */ break; }
                Ok(Err(_)) => break,
                Err(_) => break, // No more messages available right now
            }
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;
    Ok(())
}

async fn send_command(writer: &mut tokio::process::ChildStdin, cmd: TuiCommand) {
    let json = serde_json::to_string(&cmd).unwrap();
    let _ = writer.write_all(format!("{json}\n").as_bytes()).await;
    let _ = writer.flush().await;
}
