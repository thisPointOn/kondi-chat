#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const version = "0.1.0";

const arg = process.argv[2];

if (arg === "--version" || arg === "-V") {
  console.log(`kondi-chat ${version}`);
  process.exit(0);
}

if (arg === "--help" || arg === "-h") {
  console.log(`kondi-chat ${version}`);
  console.log("Multi-model AI coding CLI with intelligent routing and council deliberation.\n");
  console.log("Usage:");
  console.log("  kondi-chat [options]\n");
  console.log("Options:");
  console.log("  --help, -h       Show this help message");
  console.log("  --version, -V    Show version number");
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
  try {
    execSync(`npx tsx ${join(projectRoot, "src", "cli", "backend.ts")} ${process.argv.slice(2).join(" ")}`, {
      stdio: "inherit",
      cwd: projectRoot,
    });
  } catch (e) {
    process.exit(e.status ?? 1);
  }
}
