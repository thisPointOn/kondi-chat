use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::{App, ChatMessage};

pub fn draw(f: &mut Frame, app: &App) {
    // Detail view — full screen
    if let Some(ref view) = app.detail_view {
        draw_detail(f, app, view);
        return;
    }

    // Calculate input box height based on content (min 3, max 8)
    let input_lines = if app.input.is_empty() {
        1
    } else {
        let width = f.area().width.saturating_sub(4) as usize; // subtract borders + padding
        let content_lines: usize = app.input.lines().map(|l| {
            if l.is_empty() { 1 } else { (l.len() + width - 1) / width }
        }).sum();
        content_lines.max(1)
    };
    let input_height = (input_lines as u16 + 2).min(8).max(3); // +2 for borders

    // Check if we need to show suggestions
    let suggestions = get_suggestions(&app.input, &app.model);
    let suggestion_height = if suggestions.is_empty() { 0 } else { (suggestions.len() as u16).min(10) };

    // Main layout: chat area + suggestions + status + input + model indicator
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),                  // Chat area (grows)
            Constraint::Length(suggestion_height), // Suggestions (0 when empty)
            Constraint::Length(1),                // Status bar
            Constraint::Length(input_height),     // Input box (dynamic)
            Constraint::Length(1),                // Model indicator
        ])
        .split(f.area());

    draw_chat(f, app, chunks[0]);
    if !suggestions.is_empty() {
        draw_suggestions(f, &suggestions, chunks[1]);
    }
    draw_status(f, app, chunks[2]);
    draw_input(f, app, chunks[3]);
    draw_model_indicator(f, app, chunks[4]);
}

fn draw_chat(f: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = vec![];

    for msg in &app.messages {
        lines.push(Line::from("")); // Spacing between messages

        match msg.role.as_str() {
            "user" => {
                lines.push(Line::from(vec![
                    Span::styled("❯ ", Style::default().fg(Color::Blue).add_modifier(Modifier::BOLD)),
                    Span::styled(&msg.content, Style::default().fg(Color::Blue).add_modifier(Modifier::BOLD)),
                ]));
            }
            "system" => {
                for line in msg.content.lines() {
                    lines.push(Line::from(Span::styled(line, Style::default().fg(Color::Yellow))));
                }
            }
            "assistant" | _ => {
                // Model label
                let label = msg.model_label.as_deref().unwrap_or("...");
                lines.push(Line::from(vec![
                    Span::styled("● ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
                    Span::styled(label, Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
                ]));

                // Tool calls (last 7)
                let tc_start = if msg.tool_calls.len() > 7 { msg.tool_calls.len() - 7 } else { 0 };
                for tc in &msg.tool_calls[tc_start..] {
                    let color = if tc.is_error { Color::Red } else { Color::Cyan };
                    lines.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(format!("⎿ {}", tc.name), Style::default().fg(color)),
                        Span::styled(format!("({})", tc.args), Style::default().fg(Color::DarkGray)),
                    ]));
                }
                if msg.tool_calls.len() > 7 {
                    lines.push(Line::from(Span::styled(
                        format!("  ... {} more (^O)", msg.tool_calls.len() - 7),
                        Style::default().fg(Color::DarkGray),
                    )));
                }

                // Response content
                if !msg.content.is_empty() && msg.content != "(max tool iterations reached)" {
                    for line in msg.content.lines() {
                        lines.push(Line::from(Span::styled(
                            format!("  {line}"),
                            Style::default().fg(Color::White),
                        )));
                    }
                } else if !msg.tool_calls.is_empty() && msg.stats.is_some() {
                    lines.push(Line::from(Span::styled(
                        format!("  Done ({} tool calls)", msg.tool_calls.len()),
                        Style::default().fg(Color::DarkGray),
                    )));
                }

                // Stats line
                if let Some(ref stats) = msg.stats {
                    let models = stats.models.join(", ");
                    let mut parts = format!(
                        "  ▸ {}in / {}out · ${:.4} · {}",
                        stats.input_tokens, stats.output_tokens, stats.cost_usd, models
                    );
                    if stats.iterations > 1 {
                        parts.push_str(&format!(" · {} steps", stats.iterations));
                    }
                    if let Some(ref reason) = stats.route_reason {
                        parts.push_str(&format!(" · route: {}", reason));
                    }
                    lines.push(Line::from(Span::styled(parts, Style::default().fg(Color::DarkGray))));
                }
            }
        }
    }

    // Spinner at the very end when processing
    if app.is_processing {
        let spinner = app.spinner();
        lines.push(Line::from(Span::styled(
            format!("  {spinner} working..."),
            Style::default().fg(Color::Yellow),
        )));
    }

    // Pre-wrap all lines ourselves so we know the exact rendered line count.
    // This avoids the mismatch between our estimate and Ratatui's internal wrap.
    let width = area.width as usize;
    let mut wrapped_lines: Vec<Line> = Vec::new();
    for line in &lines {
        let full_text: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        let style = line.spans.first().map(|s| s.style).unwrap_or_default();
        if full_text.is_empty() {
            wrapped_lines.push(Line::from(""));
        } else {
            // Split by actual newlines first, then wrap each by width
            for sub in full_text.split('\n') {
                if sub.is_empty() {
                    wrapped_lines.push(Line::from(""));
                } else {
                    let chars: Vec<char> = sub.chars().collect();
                    for chunk in chars.chunks(width.max(1)) {
                        let s: String = chunk.iter().collect();
                        wrapped_lines.push(Line::from(Span::styled(s, style)));
                    }
                }
            }
        }
    }

    let total = wrapped_lines.len() as u16;
    let visible = area.height;
    let max_scroll = total.saturating_sub(visible);
    let user_scroll = if app.is_processing { 0 } else { (app.chat_scroll as u16).min(max_scroll) };
    let scroll_y = max_scroll.saturating_sub(user_scroll);

    let para = Paragraph::new(Text::from(wrapped_lines))
        .scroll((scroll_y, 0));

    f.render_widget(para, area);
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    // Left: status text
    let status_style = if app.is_processing {
        Style::default().fg(Color::Yellow)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    let status = Paragraph::new(Span::styled(&app.status, status_style));
    f.render_widget(status, chunks[0]);

    // Right: keyboard hints
    let hints = Paragraph::new(Span::styled(
        "Enter:send ^N:newline ^O:tools ^T:stats ^A:activity ↑↓:scroll ^C:exit",
        Style::default().fg(Color::DarkGray),
    ));
    f.render_widget(hints, chunks[1]);
}

fn draw_input(f: &mut Frame, app: &App, area: Rect) {
    let border_color = if app.is_processing { Color::DarkGray } else { Color::Blue };
    let display = if app.input.is_empty() && !app.is_processing {
        "Type a message... (Enter to send)".to_string()
    } else if app.is_processing && app.input.is_empty() {
        "Processing...".to_string()
    } else {
        format!("{}_", app.input)
    };

    let input = Paragraph::new(display)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(border_color)));
    f.render_widget(input, area);
}

fn draw_model_indicator(f: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    // Show provider + full model ID from the last response
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

fn draw_detail(f: &mut Frame, app: &App, view: &str) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(1)])
        .split(f.area());

    let mut lines: Vec<Line> = vec![];
    let title = match view {
        "tools" => "Tool Calls",
        "stats" => "Token Stats",
        _ => "Detail",
    };

    lines.push(Line::from(Span::styled(
        format!("═══ {title} ═══"),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));

    for msg in &app.messages {
        if msg.role == "user" {
            lines.push(Line::from(Span::styled(
                &msg.content,
                Style::default().fg(Color::Blue).add_modifier(Modifier::BOLD),
            )));
            lines.push(Line::from(""));
            continue;
        }
        if msg.role == "system" { continue; }

        let label = msg.model_label.as_deref().unwrap_or("assistant");
        lines.push(Line::from(Span::styled(
            format!("[{label}]"),
            Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
        )));

        if view == "tools" {
            if msg.tool_calls.is_empty() {
                lines.push(Line::from(Span::styled("  (no tools)", Style::default().fg(Color::DarkGray))));
            }
            for tc in &msg.tool_calls {
                let color = if tc.is_error { Color::Red } else { Color::Cyan };
                lines.push(Line::from(vec![
                    Span::styled(format!("  ⎿ {}", tc.name), Style::default().fg(color)),
                    Span::styled(format!("({})", tc.args), Style::default().fg(Color::DarkGray)),
                ]));
                if let Some(ref result) = tc.result {
                    for rline in result.lines().take(5) {
                        lines.push(Line::from(Span::styled(
                            format!("    {rline}"),
                            Style::default().fg(Color::DarkGray),
                        )));
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
                if stats.iterations > 1 {
                    lines.push(Line::from(format!("  Iterations: {}", stats.iterations)));
                }
            } else {
                lines.push(Line::from(Span::styled("  (no stats)", Style::default().fg(Color::DarkGray))));
            }
        }

        lines.push(Line::from(""));
    }

    // Session totals for stats view
    if view == "stats" {
        let (total_in, total_out, total_cost) = app.messages.iter()
            .filter_map(|m| m.stats.as_ref())
            .fold((0u64, 0u64, 0.0f64), |(i, o, c), s| {
                (i + s.input_tokens, o + s.output_tokens, c + s.cost_usd)
            });
        if total_cost > 0.0 {
            lines.push(Line::from(Span::styled("═══ Session Totals ═══", Style::default().add_modifier(Modifier::BOLD))));
            lines.push(Line::from(format!("  Input:  {} tokens", total_in)));
            lines.push(Line::from(format!("  Output: {} tokens", total_out)));
            lines.push(Line::from(format!("  Cost:   ${:.4}", total_cost)));
        }
    }

    let total_lines = lines.len() as u16;
    let visible = chunks[0].height;
    let max_scroll = total_lines.saturating_sub(visible) as usize;
    let scroll = app.detail_scroll.min(max_scroll);

    let para = Paragraph::new(Text::from(lines))
        .wrap(Wrap { trim: false })
        .scroll(((total_lines.saturating_sub(visible)).saturating_sub(scroll as u16), 0));
    f.render_widget(para, chunks[0]);

    let hints = Paragraph::new(Span::styled(
        "Esc:back ↑↓:scroll ^O:tools ^T:stats",
        Style::default().fg(Color::DarkGray),
    ));
    f.render_widget(hints, chunks[1]);
}

// ── Suggestions ─────────────────────────────────────────────────────

struct Suggestion {
    value: String,
    desc: String,
}

const COMMANDS: &[(&str, &str)] = &[
    ("/mode", "show/set cost mode (quality, balanced, cheap)"),
    ("/mode quality", "frontier models, thorough review"),
    ("/mode balanced", "good cost/quality tradeoff"),
    ("/mode cheap", "cheapest models, tight limits"),
    ("/use", "<alias> — force a model"),
    ("/use auto", "let the router choose"),
    ("/models", "list models and aliases"),
    ("/health", "check model availability"),
    ("/routing", "routing stats and training data"),
    ("/status", "session stats and cost"),
    ("/cost", "cost breakdown by phase and model"),
    ("/council", "list council profiles"),
    ("/council run", "<profile> <brief> — run deliberation"),
    ("/loop", "[mode] <task> — autonomous loop"),
    ("/mcp", "list MCP servers and tools"),
    ("/tasks", "list task cards"),
    ("/ledger", "[phase] — audit ledger"),
    ("/export", "export session to JSON"),
    ("/analytics", "usage & cost by model/provider (last 30 days)"),
    ("/analytics 7", "last 7 days"),
    ("/analytics export", "export all data as JSON"),
    ("/analytics rebuild", "rebuild from all ledger files"),
    ("/tools", "list agent tools"),
    ("/help", "show all commands"),
    ("/quit", "exit"),
];

const AGENT_TOOLS: &[(&str, &str)] = &[
    ("read_file", "read a file from the project"),
    ("write_file", "create or overwrite a file"),
    ("edit_file", "search/replace edit in a file"),
    ("list_files", "list directory contents"),
    ("search_code", "grep for patterns in code"),
    ("run_command", "run a shell command"),
    ("create_task", "dispatch coding task (execute → verify → reflect)"),
    ("update_plan", "update session goal, plan, decisions"),
    ("run_council", "run multi-model deliberation (expensive)"),
];

fn get_suggestions(input: &str, _model: &str) -> Vec<Suggestion> {
    let first_line = input.split('\n').next().unwrap_or("");
    if first_line.is_empty() { return vec![]; }

    // /tools — show agent tools
    if first_line.to_lowercase() == "/tools" {
        return AGENT_TOOLS.iter().map(|(name, desc)| Suggestion {
            value: name.to_string(), desc: desc.to_string(),
        }).collect();
    }

    // / commands
    if first_line.starts_with('/') {
        let typed = first_line.to_lowercase();
        return COMMANDS.iter()
            .filter(|(cmd, _)| cmd.to_lowercase().starts_with(&typed))
            .take(10)
            .map(|(cmd, desc)| Suggestion {
                value: cmd.to_string(), desc: desc.to_string(),
            })
            .collect();
    }

    // @ mentions
    if first_line.starts_with('@') && !first_line.contains(' ') {
        // Would need aliases from backend — for now show hint
        return vec![Suggestion {
            value: "@<alias>".to_string(),
            desc: "send to a specific model".to_string(),
        }];
    }

    vec![]
}

fn draw_suggestions(f: &mut Frame, suggestions: &[Suggestion], area: Rect) {
    let lines: Vec<Line> = suggestions.iter().map(|s| {
        Line::from(vec![
            Span::styled(format!("  {} ", s.value), Style::default().fg(Color::Cyan)),
            Span::styled(&s.desc, Style::default().fg(Color::DarkGray)),
        ])
    }).collect();

    let para = Paragraph::new(Text::from(lines));
    f.render_widget(para, area);
}
