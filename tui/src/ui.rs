use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::{render_assistant_lines, App};

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

    let suggestions = get_suggestions(&app.input, &app.model);
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
    if let Some(msg) = app.messages.first() {
        lines = render_assistant_lines(msg);
    }
    if app.is_processing && app.messages.is_empty() {
        let spinner = app.spinner();
        lines.push(Line::from(Span::styled(
            format!("  {} working...", spinner),
            Style::default().fg(Color::Yellow),
        )));
    }

    // Pre-wrap so we can compute exact line count and anchor to the bottom.
    let width = area.width as usize;
    let mut wrapped: Vec<Line> = Vec::new();
    for line in &lines {
        let full: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        let style = line.spans.first().map(|s| s.style).unwrap_or_default();
        if full.is_empty() {
            wrapped.push(Line::from(""));
        } else {
            for sub in full.split('\n') {
                if sub.is_empty() {
                    wrapped.push(Line::from(""));
                } else {
                    let chars: Vec<char> = sub.chars().collect();
                    for chunk in chars.chunks(width.max(1)) {
                        let s: String = chunk.iter().collect();
                        wrapped.push(Line::from(Span::styled(s, style)));
                    }
                }
            }
        }
    }

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
    let display = if app.input.is_empty() && !app.is_processing {
        "Type a message... (Enter to send)".to_string()
    } else if app.is_processing && app.input.is_empty() {
        "Processing...".to_string()
    } else {
        format!("{}_", app.input)
    };

    let bg = Color::Rgb(30, 30, 30);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color).bg(bg))
        .style(Style::default().bg(bg));
    let input = Paragraph::new(display)
        .wrap(Wrap { trim: false })
        .style(Style::default().bg(bg))
        .block(block);
    f.render_widget(input, area);
}

fn draw_model_indicator(f: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    let last_stats = app.messages.iter().rev().find_map(|m| m.stats.as_ref());
    let full_model = last_stats.and_then(|s| s.models.first()).cloned().unwrap_or_else(|| app.model.clone());
    let provider = last_stats.and_then(|s| s.provider.clone()).unwrap_or_default();

    let model = Paragraph::new(Span::styled(
        format!(" {}{} @{}", if provider.is_empty() { String::new() } else { format!("{} / ", provider) }, full_model, app.model),
        Style::default().fg(Color::DarkGray),
    ));
    f.render_widget(model, chunks[0]);

    let cost = Paragraph::new(Span::styled(
        format!("session: ${:.4} ", app.session_cost),
        Style::default().fg(Color::DarkGray),
    )).alignment(ratatui::layout::Alignment::Right);
    f.render_widget(cost, chunks[1]);
}

fn draw_permission_overlay(f: &mut Frame, p: &crate::app::PermissionDialog, anchor: Rect) {
    let h: u16 = 9;
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
            " [y] approve   [n] deny   [a] approve all (this session)",
            Style::default().fg(Color::Cyan),
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
    let title = match view { "tools" => "Tool Calls (current turn)", "stats" => "Stats (current turn)", _ => "Detail" };
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

    let hints = Paragraph::new(Span::styled("Esc:back ↑↓:scroll ^O:tools ^T:stats", Style::default().fg(Color::DarkGray)));
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
    ("/loop", "[mode] <task> — autonomous loop"),
    ("/mcp", "list MCP servers and tools"),
    ("/tasks", "list task cards"),
    ("/analytics", "usage & cost"),
    ("/tools", "list agent tools"),
    ("/help", "show all commands"),
    ("/quit", "exit"),
];

fn get_suggestions(input: &str, _model: &str) -> Vec<Suggestion> {
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
