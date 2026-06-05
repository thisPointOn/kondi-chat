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
/// 22 rows lets the compose box grow to ~18 lines so long messages stay
/// visible while you type, with room left for status / model bar / preview.
const VIEWPORT_HEIGHT: u16 = 22;

/// Resolve how to launch the Node backend.
///
/// Prefers `node <local tsx CLI>`: `node` resolves to `node.exe` on
/// Windows, whereas a bare `npx` is a `.cmd` shim that Rust's `Command`
/// can't find ("program not found"). Falls back to a platform-correct
/// `npx tsx` if `tsx` can't be located.
fn backend_launcher(project_root: &std::path::Path) -> (String, Vec<String>) {
    if let Some(tsx_dir) = find_tsx_dir(project_root) {
        if let Ok(raw) = std::fs::read_to_string(tsx_dir.join("package.json")) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                let rel = json["bin"].as_str().map(String::from)
                    .or_else(|| json["bin"]["tsx"].as_str().map(String::from));
                if let Some(rel) = rel {
                    let cli = tsx_dir.join(&rel);
                    if cli.exists() {
                        return ("node".to_string(), vec![cli.to_string_lossy().into_owned()]);
                    }
                }
            }
        }
    }
    let npx = if cfg!(windows) { "npx.cmd" } else { "npx" };
    (npx.to_string(), vec!["tsx".to_string()])
}

/// Walk up from `project_root` looking for `node_modules/tsx`, mirroring
/// Node's module resolution so a hoisted `tsx` install is found too.
fn find_tsx_dir(project_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut dir = Some(project_root);
    while let Some(d) = dir {
        let candidate = d.join("node_modules").join("tsx");
        if candidate.join("package.json").exists() {
            return Some(candidate);
        }
        dir = d.parent();
    }
    None
}

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
        let (program, mut args) = backend_launcher(&project_root);
        args.push("src/cli/backend.ts".to_string());
        args.extend(forwarded);
        let status = TokioCommand::new(&program)
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
    // project_root so node/tsx resolve from the right place.
    let user_cwd = std::env::current_dir()?.to_string_lossy().to_string();
    let (program, mut backend_args) = backend_launcher(&project_root);
    backend_args.push("src/cli/backend.ts".to_string());
    backend_args.push("--cwd".to_string());
    backend_args.push(user_cwd);
    let mut child = TokioCommand::new(&program)
        .args(&backend_args)
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
        // Copy mode (Ctrl+P) pauses ALL viewport draws and insert_before
        // flushes so the terminal's native text selection survives. Events
        // and state updates still process — they just don't reach the
        // screen until the user toggles back. Resumption re-runs this
        // block, which drains pending_history + redraws in one pass.
        if needs_draw && !app.copy_mode {
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

            // Progressive streaming flush: push the LLM's TEXT content
            // into terminal scrollback as it streams. Header and tool
            // call lines stay in the compact preview area — only the
            // actual model output scrolls up naturally.
            //
            // Table lines (box-drawing chars) are NEVER flushed during
            // streaming because column widths change as new rows arrive.
            // Tables stay in the preview until the message completes.
            //
            // stream_lines_flushed counts CONTENT lines (from
            // render_content_lines), not the full render_assistant_lines.
            if app.is_processing {
                if let Some(msg) = app.messages.first() {
                    let content_lines = app::render_content_lines(&msg.content);
                    // Wrap to terminal width BEFORE counting — LLMs output
                    // long paragraphs with few \n chars, so unwrapped line
                    // count can be 4 for a visual 50-line response.
                    let wrapped_content = ui::wrap_lines_to_width(&content_lines, term_width);
                    let total = wrapped_content.len();
                    let keep_tail = 4usize;

                    // Find the safe flush boundary: only flush lines that
                    // won't change as more content arrives. Table lines
                    // (containing box-drawing chars) are unstable because
                    // new rows can widen columns.
                    let safe_end = {
                        let mut end = total.saturating_sub(keep_tail);
                        while end > app.stream_lines_flushed {
                            let line_text: String = wrapped_content[end - 1]
                                .spans.iter()
                                .map(|s| s.content.as_ref())
                                .collect();
                            if line_text.contains('│') || line_text.contains('┌')
                                || line_text.contains('├') || line_text.contains('└')
                                || line_text.contains('─')
                            {
                                end -= 1;
                            } else {
                                break;
                            }
                        }
                        end
                    };

                    if safe_end > app.stream_lines_flushed + 2 {
                        // On the very first content flush, push the header
                        // (● model) + activity lines to scrollback first.
                        if app.stream_lines_flushed == 0 {
                            let mut header_lines: Vec<ratatui::text::Line<'static>> = Vec::new();
                            for (kind, text) in &app.activity {
                                if kind == "tool" { continue; }
                                header_lines.push(ratatui::text::Line::from(
                                    ratatui::text::Span::styled(
                                        format!("  {}", text),
                                        ratatui::style::Style::default()
                                            .fg(ratatui::style::Color::Yellow)
                                            .add_modifier(ratatui::style::Modifier::DIM),
                                    ),
                                ));
                            }
                            let label = msg.model_label.clone().unwrap_or_else(|| "assistant".into());
                            header_lines.push(ratatui::text::Line::from(vec![
                                ratatui::text::Span::styled("● ", ratatui::style::Style::default()
                                    .fg(ratatui::style::Color::Green)
                                    .add_modifier(ratatui::style::Modifier::BOLD)),
                                ratatui::text::Span::styled(label, ratatui::style::Style::default()
                                    .fg(ratatui::style::Color::Green)
                                    .add_modifier(ratatui::style::Modifier::BOLD)),
                            ]));
                            if !header_lines.is_empty() {
                                let wrapped = ui::wrap_lines_to_width(&header_lines, term_width);
                                let h = wrapped.len() as u16;
                                terminal.insert_before(h, |buf| {
                                    for (i, line) in wrapped.iter().enumerate() {
                                        buf.set_line(0, i as u16, line, buf.area.width);
                                    }
                                })?;
                            }
                        }
                        let to_flush: Vec<ratatui::text::Line<'static>> = wrapped_content[app.stream_lines_flushed..safe_end]
                            .to_vec();
                        if !to_flush.is_empty() {
                            let h = to_flush.len() as u16;
                            terminal.insert_before(h, |buf| {
                                for (i, line) in to_flush.iter().enumerate() {
                                    buf.set_line(0, i as u16, line, buf.area.width);
                                }
                            })?;
                            app.stream_lines_flushed = safe_end;
                        }
                    }
                }
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
                // During the wizard's input step, a pasted value (e.g. an
                // API key) goes into the wizard buffer with newlines
                // stripped — not the main compose line.
                if let Some(w) = app.wizard.as_mut() {
                    if w.step == "input" {
                        for ch in text.chars() {
                            if ch != '\n' && ch != '\r' {
                                w.input.push(ch);
                            }
                        }
                    }
                } else {
                    for ch in text.chars() {
                        app.insert_char(ch);
                    }
                }
                // Don't fall through to key handling.
            }

            if let Event::Key(key) = evt {
                // Key-setup wizard modal — intercepts all input while open.
                let wizard_open = app.wizard.is_some();
                if wizard_open {
                    let wiz = app.wizard.clone().unwrap();
                    let is_select = wiz.step == "select";
                    match (key.code, key.modifiers) {
                        (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                            send_command(&mut writer, TuiCommand::Quit).await;
                            break;
                        }
                        (KeyCode::Esc, _) => {
                            send_command(&mut writer, TuiCommand::WizardResponse {
                                id: wiz.id.clone(),
                                value: String::new(),
                                cancelled: true,
                            }).await;
                            app.wizard = None; // dismiss immediately for responsiveness
                        }
                        (KeyCode::Char(c), _) if is_select && c.is_ascii_digit() && c != '0' => {
                            let idx = (c as usize) - ('1' as usize);
                            if idx < wiz.options.len() {
                                send_command(&mut writer, TuiCommand::WizardResponse {
                                    id: wiz.id.clone(),
                                    value: idx.to_string(),
                                    cancelled: false,
                                }).await;
                            }
                        }
                        (KeyCode::Enter, _) if !is_select => {
                            send_command(&mut writer, TuiCommand::WizardResponse {
                                id: wiz.id.clone(),
                                value: wiz.input.clone(),
                                cancelled: false,
                            }).await;
                        }
                        (KeyCode::Backspace, _) if !is_select => {
                            if let Some(w) = app.wizard.as_mut() { w.input.pop(); }
                        }
                        (KeyCode::Char(c), _) if !is_select => {
                            if let Some(w) = app.wizard.as_mut() { w.input.push(c); }
                        }
                        _ => {}
                    }
                }

                // Spec 01 — when a permission dialog is open, intercept y/n/a.
                let permission_open = !wizard_open && !app.pending_permissions.is_empty();
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
                // Copy mode swallows everything except its own toggle and
                // Ctrl+C so the user can freely select text without a stray
                // keypress accidentally typing into the input buffer.
                if !wizard_open && !permission_open && app.copy_mode {
                    match (key.code, key.modifiers) {
                        (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                            send_command(&mut writer, TuiCommand::Quit).await;
                            break;
                        }
                        (KeyCode::Char('p'), KeyModifiers::CONTROL) => {
                            // Exit copy mode — the next redraw will drain
                            // anything that queued up while paused, which
                            // is the user's visual signal it resumed.
                            app.copy_mode = false;
                            needs_draw = true;
                        }
                        _ => {}
                    }
                }
                if !wizard_open && !permission_open && !app.copy_mode { match (key.code, key.modifiers) {
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
                    (KeyCode::Char('p'), KeyModifiers::CONTROL) => {
                        // Enter copy mode: push a notice into scrollback
                        // RIGHT NOW (the redraw block won't run again until
                        // we toggle back), then go quiet so terminal text
                        // selection survives.
                        let notice = vec![ratatui::text::Line::from(
                            ratatui::text::Span::styled(
                                "── COPY MODE — viewport paused. Press Ctrl+P to resume. Ctrl+C to quit. ──",
                                ratatui::style::Style::default()
                                    .fg(ratatui::style::Color::Yellow)
                                    .add_modifier(ratatui::style::Modifier::BOLD),
                            ),
                        )];
                        let term_width = terminal.size()?.width as usize;
                        let wrapped = ui::wrap_lines_to_width(&notice, term_width);
                        let h = wrapped.len() as u16;
                        if h > 0 {
                            terminal.insert_before(h, |buf| {
                                for (i, line) in wrapped.iter().enumerate() {
                                    buf.set_line(0, i as u16, line, buf.area.width);
                                }
                            })?;
                        }
                        app.copy_mode = true;
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
        // When a turn completes (pending_history grows), break out so the
        // draw phase can flush the completed message to terminal scrollback
        // before processing more events. This ensures each turn's output
        // appears in real time rather than all at once at the end.
        loop {
            let had_pending = app.pending_history.len();
            match tokio::time::timeout(std::time::Duration::from_millis(0), reader.next_line()).await {
                Ok(Ok(Some(line))) => {
                    if let Ok(event) = serde_json::from_str::<BackendEvent>(&line) {
                        app.handle_backend_event(event);
                        needs_draw = true;
                        // A turn just completed — break so we flush to
                        // scrollback before the next turn's events arrive.
                        if app.pending_history.len() > had_pending {
                            break;
                        }
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
            // Watchdog: if is_processing has been true for >10 minutes with
            // no backend events clearing it, the backend probably dropped
            // the response (timeout, crash, silent error). Auto-clear so
            // the user isn't permanently locked out. Queued messages will
            // drain on the next loop iteration.
            // Skip the watchdog while a permission dialog is open — the
            // user may take as long as they need to review and respond.
            if app.pending_permissions.is_empty() && app.start_time.elapsed().as_secs() > 600 {
                app.is_processing = false;
                app.status = String::new();
                app.push_system_public("(turn timed out — no response from backend after 10 minutes)".into());
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
