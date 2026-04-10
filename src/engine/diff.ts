/**
 * Unified diff computation for file edits.
 *
 * Self-contained line-level LCS. Used by write_file / edit_file tools
 * (Spec 03) and git_diff tool (Spec 02) — the latter imports from here.
 */

const CONTEXT_LINES = 3;
const MAX_LINES = 200;
const MAX_BYTES = 200 * 1024;
const MAX_SOURCE_LINES = 5000;

export interface DiffResult {
  /** Unified diff string with ---/+++ headers, or '' if empty/binary/too-large. */
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  /** True if output was capped at MAX_LINES. */
  truncated: boolean;
  /** True if input was skipped (too large or binary). */
  skipped?: 'file-too-large' | 'binary' | 'empty';
}

function isBinary(s: string): boolean {
  // Fast heuristic: NUL byte in first 8KiB
  const limit = Math.min(s.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (s.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** Compute LCS-based line diff and emit unified-diff hunks. */
export function computeUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): DiffResult {
  if (oldContent === newContent) {
    return { diff: '', linesAdded: 0, linesRemoved: 0, truncated: false, skipped: 'empty' };
  }
  if (
    oldContent.length > MAX_BYTES ||
    newContent.length > MAX_BYTES ||
    isBinary(oldContent) ||
    isBinary(newContent)
  ) {
    const skipped = isBinary(oldContent) || isBinary(newContent) ? 'binary' : 'file-too-large';
    return { diff: '', linesAdded: 0, linesRemoved: 0, truncated: true, skipped };
  }

  const a = oldContent === '' ? [] : oldContent.split('\n');
  const b = newContent === '' ? [] : newContent.split('\n');
  if (a.length > MAX_SOURCE_LINES || b.length > MAX_SOURCE_LINES) {
    return { diff: '', linesAdded: 0, linesRemoved: 0, truncated: true, skipped: 'file-too-large' };
  }

  const ops = diffLines(a, b);
  const hunks = buildHunks(a, b, ops, CONTEXT_LINES);

  let linesAdded = 0;
  let linesRemoved = 0;
  const out: string[] = [];
  out.push(`--- ${oldContent === '' ? '/dev/null' : `a/${filePath}`}`);
  out.push(`+++ ${newContent === '' ? '/dev/null' : `b/${filePath}`}`);

  let truncated = false;
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`);
    for (const line of h.lines) {
      if (line[0] === '+') linesAdded++;
      else if (line[0] === '-') linesRemoved++;
      if (out.length >= MAX_LINES + 2) { truncated = true; break; }
      out.push(line);
    }
    if (truncated) break;
  }
  if (truncated) out.push(`... (diff truncated at ${MAX_LINES} lines)`);

  return { diff: out.join('\n'), linesAdded, linesRemoved, truncated };
}

// ── LCS line diff ─────────────────────────────────────────────────────

type Op = { kind: 'eq' | 'del' | 'add'; aIdx: number; bIdx: number };

function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  // DP table of LCS lengths
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'eq', aIdx: i, bIdx: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: 'del', aIdx: i, bIdx: j }); i++; }
    else { ops.push({ kind: 'add', aIdx: i, bIdx: j }); j++; }
  }
  while (i < n) { ops.push({ kind: 'del', aIdx: i, bIdx: j }); i++; }
  while (j < m) { ops.push({ kind: 'add', aIdx: i, bIdx: j }); j++; }
  return ops;
}

interface Hunk {
  oldStart: number; oldLen: number;
  newStart: number; newLen: number;
  lines: string[];
}

function buildHunks(a: string[], b: string[], ops: Op[], context: number): Hunk[] {
  // Find change regions and expand with context.
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === 'eq') { i++; continue; }
    // Start of a change — walk back for leading context.
    let start = i;
    let ctxBefore = 0;
    while (start > 0 && ops[start - 1].kind === 'eq' && ctxBefore < context) {
      start--; ctxBefore++;
    }
    // Walk forward through changes, allowing up to 2*context eq lines to merge adjacent hunks.
    let end = i;
    while (end < ops.length) {
      if (ops[end].kind !== 'eq') { end++; continue; }
      // Count eq run
      let runEnd = end;
      while (runEnd < ops.length && ops[runEnd].kind === 'eq') runEnd++;
      const runLen = runEnd - end;
      const isTail = runEnd === ops.length;
      if (isTail || runLen > 2 * context) {
        // Keep up to `context` trailing eq lines.
        end = Math.min(end + context, runEnd);
        break;
      }
      end = runEnd;
    }

    const lines: string[] = [];
    const firstOp = ops[start];
    const oldStartIdx = firstOp.aIdx;
    const newStartIdx = firstOp.bIdx;
    let oldLen = 0, newLen = 0;
    for (let k = start; k < end; k++) {
      const op = ops[k];
      if (op.kind === 'eq') {
        lines.push(' ' + a[op.aIdx]); oldLen++; newLen++;
      } else if (op.kind === 'del') {
        lines.push('-' + a[op.aIdx]); oldLen++;
      } else {
        lines.push('+' + b[op.bIdx]); newLen++;
      }
    }
    // Unified diff: 1-based line numbers; if len==0 the "start" is the line BEFORE which
    // content is added/removed, i.e. the 0-based index itself.
    hunks.push({
      oldStart: oldLen === 0 ? oldStartIdx : oldStartIdx + 1,
      oldLen,
      newStart: newLen === 0 ? newStartIdx : newStartIdx + 1,
      newLen,
      lines,
    });
    i = end;
  }
  return hunks;
}
