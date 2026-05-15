#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const version = "0.1.2";

const arg = process.argv[2];

if (arg === "--version" || arg === "-V") {
  console.log(`kondi-chat ${version}`);
  process.exit(0);
}

if (arg === "--help" || arg === "-h") {
  console.log(`kondi-chat ${version} — terminal coding agent that picks a different model per phase`);
  console.log("");
  console.log("Usage:");
  console.log("  kondi-chat                          Launch the TUI (default)");
  console.log("  kondi-chat --prompt \"…\"              Run a single turn non-interactively");
  console.log("  kondi-chat --resume                 Resume the latest session in this dir");
  console.log("  kondi-chat --sessions               List saved sessions for this dir");
  console.log("");
  console.log("Non-interactive flags:");
  console.log("  --prompt \"…\"                        Prompt text (required for non-interactive)");
  console.log("  --pipe                              Read additional context from stdin");
  console.log("  --json                              Emit structured JSON output instead of text");
  console.log("  --max-iterations N                  Cap agent-loop iterations (overrides profile)");
  console.log("  --max-cost N                        Cap per-turn USD (overrides profile)");
  console.log("  --auto-approve TOOL                 Auto-approve a specific tool (e.g. run_command)");
  console.log("                                      Can be repeated. Chained shell commands still");
  console.log("                                      drop to confirm; always-confirm patterns still");
  console.log("                                      block.");
  console.log("  --dangerously-skip-permissions      Bypass all permission gates. Be sure.");
  console.log("");
  console.log("Session:");
  console.log("  --resume [ID]                       Resume latest or specific session");
  console.log("  --sessions                          List sessions");
  console.log("  --cwd PATH                          Operate as if launched from PATH");
  console.log("");
  console.log("Inside the TUI: /help, /mode, /use, /cost, /routing, /undo, /loop, /council");
  console.log("Exit codes: 0 ok · 1 error · 2 max iterations · 3 max cost · 5 permission denied");
  console.log("");
  console.log("Docs: https://github.com/thisPointOn/kondi-chat#readme");
  process.exit(0);
}

const tuiBinary = join(projectRoot, "tui", "target", "release", "kondi-tui");

if (existsSync(tuiBinary)) {
  try {
    execFileSync(tuiBinary, process.argv.slice(2), { stdio: "inherit" });
  } catch (e) {
    process.exit(e.status ?? 1);
  }
} else {
  // Run the Node backend from the user's current working directory — NOT from
  // the install dir. Setting cwd: projectRoot here would make the agent operate
  // on the kondi-chat install instead of the user's project, which was the
  // common failure mode for any install where the TUI binary download failed.
  try {
    execSync(`npx tsx ${join(projectRoot, "src", "cli", "backend.ts")} ${process.argv.slice(2).join(" ")}`, {
      stdio: "inherit",
    });
  } catch (e) {
    process.exit(e.status ?? 1);
  }
}
