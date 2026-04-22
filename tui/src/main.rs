mod protocol;
mod app;
mod ui;

use std::io;
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers, EnableBracketedPaste, DisableBracketedPaste},
    terminal::{disable_raw_mode, enable_raw_mode},
    execute,
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
    // Start the Node.js backend as a child process.
    // Find project root from the binary's own path — NOT from cwd.
    // The binary lives at <project>/tui/target/release/kondi-tui, so
    // the project root is always 3 levels up. This works regardless of
    // which directory the user runs `kondi-chat` from.
    let project_root = {
        let exe = std::env::current_exe()
            .and_then(|p| std::fs::canonicalize(p))
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("Cannot locate binary: {e}")))?;
        // exe = .../tui/target/release/kondi-tui → parent³ = project root
        let from_exe = exe.parent()  // release/
            .and_then(|p| p.parent()) // target/
            .and_then(|p| p.parent()) // tui/
            .and_then(|p| p.parent()) // project root
            .map(|p| p.to_path_buf());
        match from_exe {
            Some(ref root) if root.join("package.json").exists() => root.clone(),
            _ => {
                // Fallback: walk up from cwd (legacy behavior for dev builds
                // where the binary might be in an unexpected location).
                let mut dir = std::env::current_dir()?;
                loop {
                    if dir.join("package.json").exists()
                        && dir.join("src").join("cli").join("backend.ts").exists() { break dir; }
                    if !dir.pop() {
                        return Err(io::Error::new(
                            io::ErrorKind::NotFound,
                            "Cannot find kondi-chat project root (no package.json with src/cli/backend.ts). \
                             Make sure you installed via `npm install -g @thispointon/kondi-chat` or `npm link`.",
                        ));
                    }
                }
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
    // Pass the user's actual working directory (where they ran `kondi-chat`)
    // to the backend via --cwd. The backend uses this as workingDir for file
    // tools, git context, .kondi-chat storage, etc. current_dir stays at
    // project_root so npx/tsx resolve from the right place.
    let user_cwd = std::env::current_dir()?.to_string_lossy().to_string();
    let mut child = TokioCommand::new("npx")
        .args(["tsx", "src/cli/backend.ts", "--cwd", &user_cwd])
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
    // Bracketed paste: the terminal wraps pasted text in escape sequences
    // so it arrives as a single Event::Paste(String) instead of a stream
    // of individual Key events. Without this, pasting "hello\nworld"
    // triggers Enter (which submits "hello") before "world" even starts.
    execute!(io::stderr(), EnableBracketedPaste)?;
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

            // Bracketed paste: entire pasted text arrives as one event.
            // Insert it into the input buffer at the cursor position.
            // Newlines in the paste become literal \n in the input — the
            // user can send it as a multi-line message or clean it up.
            // Critically: this does NOT trigger Enter/submit.
            if let Event::Paste(text) = &evt {
                for ch in text.chars() {
                    app.insert_char(ch);
                }
                // Don't fall through to key handling.
            }

            if let Event::Key(key) = evt {
                // Spec 01 — when a permission dialog is open, intercept y/n/a.
                let permission_open = !app.pending_permissions.is_empty();
                if permission_open {
                    let pending_id = app.pending_permissions[0].id.clone();
                    let decision: Option<&str> = match (key.code, key.modifiers) {
                        (KeyCode::Char('1'), _) | (KeyCode::Enter, _) => Some("approved"),
                        (KeyCode::Char('2'), _) | (KeyCode::Esc, _) => Some("denied"),
                        (KeyCode::Char('3'), _) => Some("approved-session"),
                        (KeyCode::Char('4'), _) => Some("approved-turn"),
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
                        } else if !app.input.is_empty() {
                            app.clear_input();
                        } else if !app.pending_submits.is_empty() {
                            // Empty input + non-empty queue: Esc clears the queue.
                            // Lets the user bail out of queued type-ahead without
                            // waiting for the current turn to process them.
                            app.clear_pending_submits();
                        }
                    }
                    (KeyCode::Enter, _) => {
                        if !app.input.is_empty() {
                            let text = std::mem::take(&mut app.input);
                            app.input_cursor = 0;
                            if text.starts_with('/') {
                                // Slash commands always fire immediately — they're
                                // fast, non-conflicting, and must work even when
                                // is_processing is stuck from a prior turn.
                                send_command(&mut writer, TuiCommand::Command { text: text.clone() }).await;
                                app.add_user_message(&text);
                            } else if app.is_processing {
                                // Current turn still running — queue submits only.
                                app.queue_submit(text);
                            } else {
                                send_command(&mut writer, TuiCommand::Submit { text: text.clone() }).await;
                                app.add_user_message(&text);
                            }
                        }
                    }
                    (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                        app.insert_char('\n');
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
                    (KeyCode::Backspace, _) => { app.backspace_at_cursor(); }
                    (KeyCode::Delete, _) => { app.delete_at_cursor(); }
                    // Up/Down: bash-style history recall. Left/Right: move
                    // the cursor inside the current line. Home/End (and
                    // ^A/^E): jump to line ends.
                    (KeyCode::Up, _) => { app.history_prev(); }
                    (KeyCode::Down, _) => { app.history_next(); }
                    (KeyCode::Left, _) => { app.cursor_left(); }
                    (KeyCode::Right, _) => { app.cursor_right(); }
                    (KeyCode::Home, _) => { app.cursor_home(); }
                    (KeyCode::End, _) => { app.cursor_end(); }
                    (KeyCode::Char(c), _) => { app.insert_char(c); }
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

        // If the last turn just finished and there's a queued submit waiting,
        // fire it now. `pop_pending_submit` records the user line in history
        // and flips is_processing back on so the spinner resumes immediately.
        if !app.is_processing && !app.pending_submits.is_empty() {
            if let Some(text) = app.pop_pending_submit() {
                if text.starts_with('/') {
                    send_command(&mut writer, TuiCommand::Command { text }).await;
                } else {
                    send_command(&mut writer, TuiCommand::Submit { text }).await;
                }
                needs_draw = true;
            }
        }

        // Spinner tick: if processing and poll timed out, still redraw.
        if app.is_processing {
            needs_draw = true;
            // Watchdog: if is_processing has been true for >5 minutes with
            // no backend events clearing it, the backend probably dropped
            // the response (timeout, crash, silent error). Auto-clear so
            // the user isn't permanently locked out. Queued messages will
            // drain on the next loop iteration.
            if app.start_time.elapsed().as_secs() > 300 {
                app.is_processing = false;
                app.status = String::new();
                app.push_system_public("(turn timed out — no response from backend after 5 minutes)".into());
            }
        }
    }

    // Inline viewport: just clear our viewport area and leave the
    // scrollback intact so the chat history is still visible after exit.
    terminal.clear()?;
    execute!(io::stderr(), DisableBracketedPaste)?;
    disable_raw_mode()?;
    terminal.show_cursor()?;
    Ok(())
}

async fn send_command(writer: &mut tokio::process::ChildStdin, cmd: TuiCommand) {
    let json = serde_json::to_string(&cmd).unwrap();
    let _ = writer.write_all(format!("{json}\n").as_bytes()).await;
    let _ = writer.flush().await;
}
