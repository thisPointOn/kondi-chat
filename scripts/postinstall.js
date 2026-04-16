#!/usr/bin/env node

/**
 * postinstall — downloads the prebuilt Rust TUI binary for the current
 * platform from the matching GitHub release.
 *
 * Runs automatically on `npm install -g kondi-chat`. If the download
 * fails (no internet, unsupported platform, no matching release), the
 * package still works — bin/kondi-chat.js falls back to running the
 * Node backend directly (no TUI, just stdio). The binary is optional
 * for functionality; it's required for the terminal UI.
 *
 * Platform → artifact name mapping matches the release workflow matrix
 * in .github/workflows/release.yml.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REPO = 'thisPointOn/kondi-chat';

// Map Node's os.platform()+os.arch() to the GitHub release artifact name.
const PLATFORM_MAP = {
  'linux-x64':    'kondi-tui-linux-x64',
  'linux-arm64':  'kondi-tui-linux-arm64',
  'darwin-x64':   'kondi-tui-darwin-x64',
  'darwin-arm64': 'kondi-tui-darwin-arm64',
  'win32-x64':    'kondi-tui-win32-x64.exe',
};

function getPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  return pkg.version;
}

function download(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers: { 'User-Agent': 'kondi-chat-postinstall' } }, (res) => {
      // Follow redirects (GitHub sends 302 to CDN).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const key = getPlatformKey();
  const artifact = PLATFORM_MAP[key];

  if (!artifact) {
    console.log(`[kondi-chat] No prebuilt TUI binary for ${key}. The Node backend will run without the TUI.`);
    console.log(`[kondi-chat] To build from source: cd tui && cargo build --release`);
    return;
  }

  const version = getVersion();
  const tag = `v${version}`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${artifact}`;
  const destDir = path.join(__dirname, '..', 'tui', 'target', 'release');
  const isWindows = process.platform === 'win32';
  const destFile = path.join(destDir, isWindows ? 'kondi-tui.exe' : 'kondi-tui');

  // Skip if the binary already exists (source build or prior install).
  if (fs.existsSync(destFile)) {
    console.log(`[kondi-chat] TUI binary already exists at ${destFile}, skipping download.`);
    return;
  }

  console.log(`[kondi-chat] Downloading TUI binary for ${key}...`);
  console.log(`[kondi-chat] ${url}`);

  try {
    const data = await download(url);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(destFile, data);
    if (!isWindows) {
      fs.chmodSync(destFile, 0o755);
    }
    console.log(`[kondi-chat] TUI binary installed (${(data.length / 1024 / 1024).toFixed(1)} MB).`);
  } catch (err) {
    console.log(`[kondi-chat] Could not download TUI binary: ${err.message}`);
    console.log(`[kondi-chat] The Node backend will run without the TUI.`);
    console.log(`[kondi-chat] To build from source: cd tui && cargo build --release`);
  }
}

main();
