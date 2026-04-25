/**
 * Symbol Index — regex-based function/class/export extraction.
 *
 * Scans the working directory at startup and after edits, caches
 * results to .kondi-chat/index/symbols.json. Provides find_symbol
 * and related_files tools so the agent can navigate the codebase
 * structurally instead of grep-and-hope.
 *
 * Uses simple regex, not tree-sitter — fast, zero native deps,
 * good enough for 90% of cases. Can upgrade to tree-sitter later
 * if the regex falls short.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'export' | 'method';
  file: string;
  line: number;
}

export interface FileSymbols {
  file: string;
  symbols: SymbolEntry[];
  imports: string[];  // files this file imports from
  mtime: number;
}

export interface SymbolIndex {
  files: Record<string, FileSymbols>;
  buildTime: string;
}

// ---------------------------------------------------------------------------
// Extraction regexes (covers TS, JS, Python, Rust, Go)
// ---------------------------------------------------------------------------

const EXTRACTORS: Array<{ ext: string[]; patterns: Array<{ re: RegExp; kind: SymbolEntry['kind'] }> }> = [
  {
    ext: ['.ts', '.tsx', '.js', '.jsx'],
    patterns: [
      { re: /^export\s+(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
      { re: /^export\s+(?:default\s+)?class\s+(\w+)/gm, kind: 'class' },
      { re: /^export\s+interface\s+(\w+)/gm, kind: 'interface' },
      { re: /^export\s+type\s+(\w+)/gm, kind: 'type' },
      { re: /^export\s+const\s+(\w+)/gm, kind: 'const' },
      { re: /^(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
      { re: /^class\s+(\w+)/gm, kind: 'class' },
      { re: /^interface\s+(\w+)/gm, kind: 'interface' },
    ],
  },
  {
    ext: ['.py'],
    patterns: [
      { re: /^def\s+(\w+)/gm, kind: 'function' },
      { re: /^class\s+(\w+)/gm, kind: 'class' },
      { re: /^(\w+)\s*=\s*/gm, kind: 'const' },
    ],
  },
  {
    ext: ['.rs'],
    patterns: [
      { re: /^pub\s+(?:async\s+)?fn\s+(\w+)/gm, kind: 'function' },
      { re: /^pub\s+struct\s+(\w+)/gm, kind: 'class' },
      { re: /^pub\s+enum\s+(\w+)/gm, kind: 'type' },
      { re: /^pub\s+trait\s+(\w+)/gm, kind: 'interface' },
      { re: /^fn\s+(\w+)/gm, kind: 'function' },
      { re: /^struct\s+(\w+)/gm, kind: 'class' },
    ],
  },
  {
    ext: ['.go'],
    patterns: [
      { re: /^func\s+(?:\([^)]+\)\s+)?(\w+)/gm, kind: 'function' },
      { re: /^type\s+(\w+)\s+struct/gm, kind: 'class' },
      { re: /^type\s+(\w+)\s+interface/gm, kind: 'interface' },
    ],
  },
];

const IMPORT_RE_TS = /(?:import|from)\s+['"]([^'"]+)['"]/g;
const IMPORT_RE_PY = /^(?:from|import)\s+(\S+)/gm;

const SKIP_DIRS = new Set(['node_modules', '.git', '.kondi-chat', 'dist', 'target', '__pycache__', '.next', 'build']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go']);
const MAX_FILE_SIZE = 200_000;

// ---------------------------------------------------------------------------
// Index builder
// ---------------------------------------------------------------------------

export class SymbolIndexer {
  private workingDir: string;
  private cachePath: string;
  private index: SymbolIndex = { files: {}, buildTime: '' };

  constructor(workingDir: string) {
    this.workingDir = workingDir;
    const indexDir = join(workingDir, '.kondi-chat', 'index');
    mkdirSync(indexDir, { recursive: true });
    this.cachePath = join(indexDir, 'symbols.json');
    this.load();
  }

  /** Build or refresh the index. Only re-scans files whose mtime changed. */
  build(): number {
    let scanned = 0;
    const currentFiles = new Set<string>();

    const scan = (dir: string, depth: number) => {
      if (depth > 4) return;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (SKIP_DIRS.has(entry.name)) continue;
          const abs = join(dir, entry.name);
          const rel = relative(this.workingDir, abs);
          if (entry.isDirectory()) {
            scan(abs, depth + 1);
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            if (!CODE_EXTENSIONS.has(ext)) continue;
            currentFiles.add(rel);
            const stat = statSync(abs);
            if (stat.size > MAX_FILE_SIZE) continue;
            const cached = this.index.files[rel];
            if (cached && cached.mtime === stat.mtimeMs) continue;
            // Re-scan this file
            const content = readFileSync(abs, 'utf-8');
            this.index.files[rel] = this.extractFileSymbols(rel, content, ext, stat.mtimeMs);
            scanned++;
          }
        }
      } catch { /* permission error */ }
    };

    scan(this.workingDir, 0);

    // Remove entries for deleted files
    for (const file of Object.keys(this.index.files)) {
      if (!currentFiles.has(file)) delete this.index.files[file];
    }

    this.index.buildTime = new Date().toISOString();
    this.save();
    return scanned;
  }

  /** Find symbols by name (prefix match). */
  findSymbol(query: string): SymbolEntry[] {
    const lower = query.toLowerCase();
    const results: SymbolEntry[] = [];
    for (const fs of Object.values(this.index.files)) {
      for (const sym of fs.symbols) {
        if (sym.name.toLowerCase().includes(lower)) {
          results.push(sym);
        }
      }
    }
    return results.slice(0, 20);
  }

  /** Find files that import or are imported by a given file. */
  relatedFiles(filePath: string): string[] {
    const rel = filePath.replace(/^\.\//, '');
    const related = new Set<string>();

    // Files that this file imports
    const entry = this.index.files[rel];
    if (entry) {
      for (const imp of entry.imports) related.add(imp);
    }

    // Files that import this file
    for (const [file, fs] of Object.entries(this.index.files)) {
      if (fs.imports.some(i => i.includes(rel) || rel.includes(i))) {
        related.add(file);
      }
    }

    related.delete(rel);
    return [...related].slice(0, 15);
  }

  /** Format for display. */
  format(): string {
    const totalSymbols = Object.values(this.index.files).reduce((s, f) => s + f.symbols.length, 0);
    return `Symbol index: ${Object.keys(this.index.files).length} files, ${totalSymbols} symbols (${this.index.buildTime || 'not built'})`;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private extractFileSymbols(file: string, content: string, ext: string, mtime: number): FileSymbols {
    const symbols: SymbolEntry[] = [];
    const imports: string[] = [];

    // Find matching extractor
    const extractor = EXTRACTORS.find(e => e.ext.includes(ext));
    if (extractor) {
      const lines = content.split('\n');
      for (const { re, kind } of extractor.patterns) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(content)) !== null) {
          const line = content.slice(0, match.index).split('\n').length;
          symbols.push({ name: match[1], kind, file, line });
        }
      }
    }

    // Extract imports
    const importRe = ext === '.py' ? IMPORT_RE_PY : IMPORT_RE_TS;
    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const imp = m[1].replace(/^\.\//, '').replace(/\.\w+$/, '');
      if (!imp.startsWith('.') || imp.includes('/')) {
        imports.push(imp);
      }
    }

    return { file, symbols, imports, mtime };
  }

  private load(): void {
    if (!existsSync(this.cachePath)) return;
    try {
      this.index = JSON.parse(readFileSync(this.cachePath, 'utf-8'));
    } catch { /* start fresh */ }
  }

  private save(): void {
    writeFileSync(this.cachePath, JSON.stringify(this.index, null, 2));
  }
}
