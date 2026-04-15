use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::{render_assistant_lines, App};

/// Wrap a list of styled `Line`s to a fixed display width.
///
/// Each input line is split on `\n`, then each segment is broken into
/// fixed-width chunks. Per-span styling is collapsed to the first span's
/// style so the wrap is fast and lossless for single-span body content
/// (the common case for assistant message text). Multi-span lines like
/// the assistant header (`● label`) are short and shouldn't trigger wrap
/// in practice.
/// Render the input buffer with a visible cursor block at `cursor` (a
/// *character* index, not a byte index). The cursor is an inverted-color
/// cell covering the char at the cursor position, or a trailing block if
/// the cursor is at the end. Newlines split into separate Lines so the
/// Paragraph widget wraps as you'd expect for a multi-line compose box.
fn build_input_text(
    input: &str,
    cursor: usize,
    base: Style,
    cursor_style: Style,
) -> Text<'static> {
    // Walk chars and emit spans, toggling style at the cursor position.
    // A span's style is fixed, so we break the stream into "before",
    // "cursor cell" (one char), and "after" segments.
    let total: usize = input.chars().count();
    let cursor = cursor.min(total);

    let mut lines_out: Vec<Line<'static>> = Vec::new();
    let mut current: Vec<Span<'static>> = Vec::new();

    // Helper: flush current into lines_out, optionally starting a new line.
    let push_str = |buf: &mut Vec<Span<'static>>, lines: &mut Vec<Line<'static>>, s: &str, style: Style| {
        let mut first = true;
        for seg in s.split('\n') {
            if !first {
                lines.push(Line::from(std::mem::take(buf)));
            }
            if !seg.is_empty() {
                buf.push(Span::styled(seg.to_string(), style));
            }
            first = false;
        }
    };

    // before cursor
    let before: String = input.chars().take(cursor).collect();
    push_str(&mut current, &mut lines_out, &before, base);

    // cursor cell
    if cursor < total {
        let ch_at = input.chars().nth(cursor).unwrap_or(' ');
        if ch_at == '\n' {
            // Cursor sits on a newline — show a block at end of line,
            // then start a new line.
            current.push(Span::styled(" ".to_string(), cursor_style));
            lines_out.push(Line::from(std::mem::take(&mut current)));
        } else {
            current.push(Span::styled(ch_at.to_string(), cursor_style));
        }
        let after: String = input.chars().skip(cursor + 1).collect();
        push_str(&mut current, &mut lines_out, &after, base);
    } else {
        // Cursor at end — trailing block.
        current.push(Span::styled(" ".to_string(), cursor_style));
    }

    lines_out.push(Line::from(current));
    Text::from(lines_out)
}

pub fn wrap_lines_to_width(lines: &[Line<'_>], width: usize) -> Vec<Line<'static>> {
    let w = width.max(1);
    let mut out: Vec<Line<'static>> = Vec::new();
    for line in lines {
        // Fast path: if the line already fits, clone it through untouched so
        // multi-span styling (splash colors, tool-call coloring, table
        // borders) is preserved exactly. Only lines that actually need to
        // wrap fall through to the lossy chunking path below.
        let total_chars: usize = line.spans.iter().map(|s| s.content.chars().count()).sum();
        let has_newline = line.spans.iter().any(|s| s.content.contains('\n'));
        if !has_newline && total_chars <= w {
            let cloned: Vec<Span<'static>> = line.spans.iter().map(|s| {
                Span::styled(s.content.clone().into_owned(), s.style)
            }).collect();
            out.push(Line::from(cloned));
            continue;
        }

        let full: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        let style = line.spans.first().map(|s| s.style).unwrap_or_default();
        if full.is_empty() {
            out.push(Line::from(""));
            continue;
        }
        for sub in full.split('\n') {
            if sub.is_empty() {
                out.push(Line::from(""));
                continue;
            }
            let chars: Vec<char> = sub.chars().collect();
            for chunk in chars.chunks(w) {
                let s: String = chunk.iter().collect();
                out.push(Line::from(Span::styled(s, style)));
            }
        }
    }
    out
}

pub fn draw(f: &mut Frame, app: &mut App) {
    if let Some(view) = app.detail_view.clone() {
        draw_detail(f, app, &view);
        if let Some(p) = app.pending_permissions.first().cloned() { draw_permission_overlay(f, &p, f.area()); }
        return;
    }

    // Inline viewport: status (1) + in-progress preview (variable, max ~8)
    // + input (4-9) + model indicator (1) + suggestions (variable, max 6).
    let area = f.area();

    // Compute input box height — same logic as before, capped to fit viewport.
    let input_lines = if app.input.is_empty() {
        1
    } else {
        let width = area.width.saturating_sub(4) as usize;
        let content_lines: usize = app.input.lines().map(|l| {
            if l.is_empty() { 1 } else { (l.len() + width - 1) / width }
        }).sum();
        content_lines.max(1)
    };
    let input_height = (input_lines as u16 + 2).min(9).max(4);

    let suggestions = get_suggestions(&app.input, &app.model, &app.available_models);
    let suggestion_height = if suggestions.is_empty() { 0 } else { (suggestions.len() as u16).min(6) };

    // Reserve fixed slots for status (1) + input + model (1) + suggestions.
    // Anything left becomes the in-progress preview area.
    let fixed = 1 + input_height + 1 + suggestion_height;
    let preview_height = area.height.saturating_sub(fixed);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(preview_height),
            Constraint::Length(suggestion_height),
            Constraint::Length(1),
            Constraint::Length(input_height),
            Constraint::Length(1),
        ])
        .split(area);

    draw_preview(f, app, chunks[0]);
    if !suggestions.is_empty() { draw_suggestions(f, &suggestions, chunks[1]); }
    draw_status(f, app, chunks[2]);
    draw_input(f, app, chunks[3]);
    draw_model_indicator(f, app, chunks[4]);

    if let Some(p) = app.pending_permissions.first().cloned() {
        draw_permission_overlay(f, &p, area);
    }
}

/// Render the currently-streaming assistant message in the inline viewport.
/// Anchored to the bottom — when the message is taller than the area, the
/// most recent lines are visible.
fn draw_preview(f: &mut Frame, app: &App, area: Rect) {
    if area.height == 0 { return; }
    let mut lines: Vec<Line> = Vec::new();

    // Activity stream (router decisions, step announcements). Render these
    // inline above the message so the user can see "router: phase=execute"
    // and "→ gpt-5.4 (rules: balanced: coding)" land in real time. Tool
    // activity lines are skipped because tool_calls already shows them on
    // the message itself.
    for (kind, text) in &app.activity {
        if kind == "tool" { continue; }
        lines.push(Line::from(Span::styled(
            format!("  {}", text),
            Style::default().fg(Color::Yellow).add_modifier(Modifier::DIM),
        )));
    }

    if let Some(msg) = app.messages.first() {
        lines.extend(render_assistant_lines(msg));
    }
    if app.is_processing && app.messages.is_empty() && app.activity.is_empty() {
        let spinner = app.spinner();
        lines.push(Line::from(Span::styled(
            format!("  {} working...", spinner),
            Style::default().fg(Color::Yellow),
        )));
    }

    // Pre-wrap so we can compute exact line count and anchor to the bottom.
    let wrapped = wrap_lines_to_width(&lines, area.width as usize);

    let total = wrapped.len() as u16;
    let scroll_y = total.saturating_sub(area.height);
    let para = Paragraph::new(Text::from(wrapped)).scroll((scroll_y, 0));
    f.render_widget(para, area);
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(40), Constraint::Percentage(60)])
        .split(area);

    let status_style = if app.is_processing {
        Style::default().fg(Color::Yellow)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    let mut left_spans: Vec<Span> = Vec::new();
    if app.is_processing {
        left_spans.push(Span::styled(
            format!("{} ", app.spinner()),
            Style::default().fg(Color::Yellow),
        ));
    }
    left_spans.push(Span::styled(app.status.clone(), status_style));
    if !app.pending_submits.is_empty() {
        left_spans.push(Span::raw(" "));
        left_spans.push(Span::styled(
            format!("⧗ queued: {} (Esc to clear)", app.pending_submits.len()),
            Style::default().fg(Color::Rgb(180, 140, 200)).add_modifier(Modifier::DIM),
        ));
    }
    if let Some(ref g) = app.git_info {
        let suffix = if g.dirty_count == 0 { "clean".to_string() } else { format!("{} modified", g.dirty_count) };
        let branch_color = if g.dirty_count == 0 { Color::Green } else { Color::Yellow };
        left_spans.push(Span::raw(" "));
        left_spans.push(Span::styled(format!(" {} [{}] ", g.branch, suffix), Style::default().fg(branch_color)));
    }
    f.render_widget(Paragraph::new(Line::from(left_spans)), chunks[0]);

    let hints = Paragraph::new(Span::styled(
        "Enter:send ^N:newline ^O:tools ^T:stats ↑↓:hist ^C:exit",
        Style::default().fg(Color::DarkGray),
    ));
    f.render_widget(hints, chunks[1]);
}

fn draw_input(f: &mut Frame, app: &App, area: Rect) {
    let border_color = if app.is_processing { Color::DarkGray } else { Color::Rgb(255, 20, 147) };
    let bg = Color::Rgb(30, 30, 30);
    let base = Style::default().bg(bg);
    let cursor_style = Style::default().bg(Color::Rgb(255, 20, 147)).fg(Color::Black);

    let text: Text = if app.input.is_empty() && !app.is_processing {
        // Idle placeholder with a highlighted block where the cursor sits.
        Line::from(vec![
            Span::styled(" ", cursor_style),
            Span::styled("Type a message... (Enter to send)", Style::default().fg(Color::DarkGray).bg(bg)),
        ]).into()
    } else if app.is_processing && app.input.is_empty() {
        Line::from(Span::styled("Processing...", Style::default().fg(Color::DarkGray).bg(bg))).into()
    } else {
        build_input_text(&app.input, app.input_cursor, base, cursor_style)
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color).bg(bg))
        .style(base);
    let input = Paragraph::new(text)
        .wrap(Wrap { trim: false })
        .style(base)
        .block(block);
    f.render_widget(input, area);
}

fn draw_model_indicator(f: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    // Bottom indicator: tell the user at a glance whether the router is
    // making model decisions (and which profile) or whether /use has
    // pinned one specific model (in which case routing is effectively
    // disabled for the duration of the override).
    let spans: Vec<Span> = if app.routing_pinned {
        vec![
            Span::styled(" routing disabled → @", Style::default().fg(Color::Yellow)),
            Span::styled(app.model.clone(), Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
        ]
    } else {
        vec![
            Span::styled(" routing: ", Style::default().fg(Color::Green)),
            Span::styled(app.model.clone(), Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        ]
    };
    f.render_widget(Paragraph::new(Line::from(spans)), chunks[0]);

    let cost = Paragraph::new(Span::styled(
        format!("session: ${:.4} ", app.session_cost),
        Style::default().fg(Color::DarkGray),
    )).alignment(ratatui::layout::Alignment::Right);
    f.render_widget(cost, chunks[1]);
}

fn draw_permission_overlay(f: &mut Frame, p: &crate::app::PermissionDialog, anchor: Rect) {
    let h: u16 = 10;
    let w = anchor.width.saturating_sub(4).min(100);
    let x = anchor.x + (anchor.width.saturating_sub(w)) / 2;
    let y = anchor.y + anchor.height.saturating_sub(h);
    let dialog_area = Rect { x, y, width: w, height: h };

    f.render_widget(ratatui::widgets::Clear, dialog_area);

    let title_color = if p.tier == "always-confirm" { Color::Red } else { Color::Yellow };
    let lines = vec![
        Line::from(Span::styled(
            format!(" Permission required [{}]", p.tier),
            Style::default().fg(title_color).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(Span::raw(format!(" Tool: {}", p.tool))),
        Line::from(Span::raw(format!(" {}", truncate(&p.summary, (w as usize).saturating_sub(2))))),
        Line::from(""),
        Line::from(Span::styled(
            " [y/⏎] approve   [n] deny   [a] same cmd (session)",
            Style::default().fg(Color::Cyan),
        )),
        Line::from(Span::styled(
            " [t] yolo — approve everything for the rest of this turn",
            Style::default().fg(Color::Magenta),
        )),
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(title_color))
        .title(" permission ");
    let para = Paragraph::new(Text::from(lines)).block(block).wrap(Wrap { trim: false });
    f.render_widget(para, dialog_area);
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else {
        let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
        out.push('…'); out
    }
}

// ── Detail view (^O / ^T) ───────────────────────────────────────────

fn draw_detail(f: &mut Frame, app: &App, view: &str) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(1)])
        .split(f.area());

    let mut lines: Vec<Line> = vec![];
    let title = match view {
        "tools" => "Tool Calls (current turn)",
        "stats" => "Stats (current turn)",
        "reasoning" => "Model Reasoning (current turn)",
        _ => "Detail",
    };
    lines.push(Line::from(Span::styled(format!("═══ {title} ═══"), Style::default().add_modifier(Modifier::BOLD))));
    lines.push(Line::from(""));

    if let Some(msg) = app.messages.first() {
        let label = msg.model_label.as_deref().unwrap_or("assistant");
        lines.push(Line::from(Span::styled(format!("[{label}]"), Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))));

        if view == "tools" {
            if msg.tool_calls.is_empty() {
                lines.push(Line::from(Span::styled("  (no tools yet)", Style::default().fg(Color::DarkGray))));
            }
            for tc in &msg.tool_calls {
                let color = if tc.is_error { Color::Red } else { Color::Cyan };
                lines.push(Line::from(vec![
                    Span::styled(format!("  ⎿ {}", tc.name), Style::default().fg(color)),
                    Span::styled(format!("({})", tc.args), Style::default().fg(Color::DarkGray)),
                ]));
                if let Some(ref result) = tc.result {
                    for rline in result.lines().take(5) {
                        lines.push(Line::from(Span::styled(format!("    {rline}"), Style::default().fg(Color::DarkGray))));
                    }
                }
            }
        }

        if view == "stats" {
            if let Some(ref stats) = msg.stats {
                lines.push(Line::from(format!("  Models:     {}", stats.models.join(", "))));
                lines.push(Line::from(format!("  Input:      {} tokens", stats.input_tokens)));
                lines.push(Line::from(format!("  Output:     {} tokens", stats.output_tokens)));
                lines.push(Line::from(format!("  Cost:       ${:.4}", stats.cost_usd)));
                if stats.iterations > 1 { lines.push(Line::from(format!("  Iterations: {}", stats.iterations))); }
            } else {
                lines.push(Line::from(Span::styled("  (no stats yet)", Style::default().fg(Color::DarkGray))));
            }
        }

        if view == "reasoning" {
            match msg.reasoning_content.as_deref() {
                Some(r) if !r.is_empty() => {
                    for rline in r.lines() {
                        lines.push(Line::from(Span::styled(
                            format!("  {rline}"),
                            Style::default().fg(Color::Rgb(180, 160, 200)),
                        )));
                    }
                }
                _ => {
                    lines.push(Line::from(Span::styled(
                        "  (no reasoning — this model didn't return chain-of-thought)",
                        Style::default().fg(Color::DarkGray),
                    )));
                }
            }
        }
    } else {
        lines.push(Line::from(Span::styled("  (no in-progress turn)", Style::default().fg(Color::DarkGray))));
    }

    let total_lines = lines.len() as u16;
    let visible = chunks[0].height;
    let max_scroll = total_lines.saturating_sub(visible) as usize;
    let scroll = app.detail_scroll.min(max_scroll);

    let para = Paragraph::new(Text::from(lines))
        .wrap(Wrap { trim: false })
        .scroll(((total_lines.saturating_sub(visible)).saturating_sub(scroll as u16), 0));
    f.render_widget(para, chunks[0]);

    let hints = Paragraph::new(Span::styled("Esc:back ↑↓:scroll ^O:tools ^T:stats ^R:reasoning", Style::default().fg(Color::DarkGray)));
    f.render_widget(hints, chunks[1]);
}

// ── Suggestions ─────────────────────────────────────────────────────

struct Suggestion { value: String, desc: String }

const COMMANDS: &[(&str, &str)] = &[
    ("/mode", "show/set cost mode"),
    ("/use", "<alias> — force a model"),
    ("/models", "list models and aliases"),
    ("/health", "check model availability"),
    ("/routing", "routing stats and training data"),
    ("/status", "session stats and cost"),
    ("/cost", "cost breakdown by phase and model"),
    ("/council", "list council profiles"),
    ("/loop", "<goal> — autonomous loop until DONE or caps hit"),
    ("/consultants", "list domain-expert consultants the agent can call"),
    ("/mcp", "list MCP servers and tools"),
    ("/tasks", "list task cards"),
    ("/analytics", "usage & cost"),
    ("/tools", "list agent tools"),
    ("/help", "show all commands"),
    ("/quit", "exit"),
];

fn get_suggestions(input: &str, _model: &str, models: &[String]) -> Vec<Suggestion> {
    let first_line = input.split('\n').next().unwrap_or("");
    if first_line.is_empty() { return vec![]; }

    if first_line.starts_with('/') {
        let typed = first_line.to_lowercase();
        return COMMANDS.iter()
            .filter(|(cmd, _)| cmd.to_lowercase().starts_with(&typed))
            .take(6)
            .map(|(cmd, desc)| Suggestion { value: cmd.to_string(), desc: desc.to_string() })
            .collect();
    }

    // @mention autocomplete. Triggers on a leading `@` with no whitespace
    // yet (once the user hits space we stop showing suggestions and let
    // them type the message body).
    if first_line.starts_with('@') && !first_line.contains(' ') {
        let prefix = first_line[1..].to_lowercase();
        return models.iter()
            .filter(|alias| alias.to_lowercase().starts_with(&prefix))
            .take(8)
            .map(|alias| Suggestion {
                value: format!("@{alias}"),
                desc: "force this model for one turn".to_string(),
            })
            .collect();
    }

    vec![]
}

fn draw_suggestions(f: &mut Frame, suggestions: &[Suggestion], area: Rect) {
    let lines: Vec<Line> = suggestions.iter().map(|s| {
        Line::from(vec![
            Span::styled(format!("  {} ", s.value), Style::default().fg(Color::Cyan)),
            Span::styled(s.desc.clone(), Style::default().fg(Color::DarkGray)),
        ])
    }).collect();
    f.render_widget(Paragraph::new(Text::from(lines)), area);
}
