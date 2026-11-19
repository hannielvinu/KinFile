// Stagebay: pure functions for hunk-level review between the file on disk and a staged proposal.
// Nothing here touches disk; the VS Code layer applies an accepted hunk as one undoable edit.
import { diffLines } from 'diff';

export interface Hunk {
  index: number;
  /** 0-based line range in the current (disk/buffer) text that the hunk replaces. */
  oldStart: number;
  oldLines: number;
  /** 0-based line range in the proposed text. */
  newStart: number;
  newLines: number;
  removed: string[];
  added: string[];
}

function splitLines(text: string): string[] {
  // Keep line terminators so joins are exact.
  const out = text.match(/[^\n]*\n|[^\n]+$/g);
  return out ?? [];
}

export function computeHunks(current: string, proposed: string): Hunk[] {
  const parts = diffLines(current, proposed);
  const hunks: Hunk[] = [];
  let o = 0, n = 0;
  let open: Hunk | undefined;
  const close = () => { if (open) { hunks.push(open); open = undefined; } };
  for (const p of parts) {
    const lines = splitLines(p.value);
    if (!p.added && !p.removed) { close(); o += lines.length; n += lines.length; continue; }
    if (!open) open = { index: hunks.length, oldStart: o, oldLines: 0, newStart: n, newLines: 0, removed: [], added: [] };
    if (p.removed) { open.removed.push(...lines); open.oldLines += lines.length; o += lines.length; }
    else { open.added.push(...lines); open.newLines += lines.length; n += lines.length; }
  }
  close();
  return hunks;
}

/** New text of the *current* file after accepting one hunk (current side takes the proposal). */
export function acceptHunk(current: string, hunk: Hunk): string {
  const lines = splitLines(current);
  lines.splice(hunk.oldStart, hunk.oldLines, ...hunk.added);
  return lines.join('');
}

/** New text of the *proposal* after rejecting one hunk (proposal takes the current lines back). */
export function rejectHunk(proposed: string, hunk: Hunk): string {
  const lines = splitLines(proposed);
  lines.splice(hunk.newStart, hunk.newLines, ...hunk.removed);
  return lines.join('');
}

/** Apply an exact-or-tolerant search/replace edit. Throws with a model-friendly message on failure. */
export function applyReplace(text: string, oldStr: string, newStr: string, replaceAll = false): string {
  if (oldStr === '') {
    if (text.length === 0) return newStr;
    throw new Error('old_string is empty but the file is not; use create_file for new files or give the exact text to replace.');
  }
  const count = text.split(oldStr).length - 1;
  if (count === 1 || (replaceAll && count > 1)) return replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
  if (count > 1) throw new Error(`old_string occurs ${count} times; include more surrounding lines so it is unique, or set replace_all.`);
  // Tolerant match: ignore trailing whitespace differences and CRLF.
  const norm = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
  const tLines = text.replace(/\r\n/g, '\n').split('\n');
  const oLines = norm(oldStr).split('\n');
  const matches: number[] = [];
  for (let i = 0; i + oLines.length <= tLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oLines.length && ok; j++) ok = tLines[i + j].replace(/\s+$/, '') === oLines[j];
    if (ok) matches.push(i);
  }
  if (matches.length === 1) {
    const i = matches[0];
    tLines.splice(i, oLines.length, ...newStr.replace(/\r\n/g, '\n').split('\n'));
    return tLines.join('\n');
  }
  if (matches.length > 1) throw new Error(`old_string occurs ${matches.length} times (ignoring trailing spaces); include more context.`);
  throw new Error('old_string was not found in the file. Call read_file to see the current content, then retry with the exact text.');
}

/** Pull the replacement code out of a model answer for inline edit (model-agnostic). */
export function extractReplacement(answer: string): string {
  const fences = [...answer.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  if (fences.length) {
    // Prefer the longest fenced block (some models add a short usage example).
    return fences.map(m => m[1]).sort((a, b) => b.length - a.length)[0];
  }
  return answer.replace(/^\s*\n/, '');
}

/** Re-indent a replacement so its first line matches the selection's indentation. */
export function matchIndent(selection: string, replacement: string): string {
  const selIndent = (selection.match(/^[ \t]*/)?.[0]) ?? '';
  const firstNonEmpty = replacement.split('\n').find(l => l.trim()) ?? '';
  const repIndent = firstNonEmpty.match(/^[ \t]*/)?.[0] ?? '';
  if (selIndent === repIndent) return replacement;
  return replacement.split('\n').map(l => (l.startsWith(repIndent) ? selIndent + l.slice(repIndent.length) : l)).join('\n');
}
