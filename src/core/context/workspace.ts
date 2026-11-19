// Workspace file listing, cached reads and code search (ripgrep when available, JS fallback).
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.tox', '.mypy_cache', '.pytest_cache', '.idea', '.vscode-test']);
const TEXT_EXT = /\.(py|pyi|[cm]?[jt]sx?|json|md|rst|txt|toml|cfg|ini|ya?ml|html|css|scss|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|sh|sql|xml|jinja|j2)$|(^|\/)(Makefile|Dockerfile|LICENSE[^/]*)$/i;
const MAX_FILE_BYTES = 512 * 1024;

export interface SearchHit { file: string; line: number; text: string }

export class Workspace {
  files: string[] = [];
  private cache = new Map<string, string>();
  rgPath?: string;

  constructor(readonly root: string) {}

  async init(): Promise<void> {
    this.files = await this.listFiles();
  }

  private listFiles(): Promise<string[]> {
    return new Promise(resolve => {
      execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: this.root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (!err && stdout.trim()) return resolve(stdout.split('\n').filter(f => f && TEXT_EXT.test(f)));
        const out: string[] = [];
        const walk = (dir: string) => {
          let entries: fs.Dirent[] = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); }
            else if (TEXT_EXT.test(e.name)) out.push(path.relative(this.root, path.join(dir, e.name)).split(path.sep).join('/'));
            if (out.length > 50000) return;
          }
        };
        walk(this.root);
        resolve(out);
      });
    });
  }

  abs(rel: string): string {
    const p = path.resolve(this.root, rel);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error(`Path escapes the workspace: ${rel}`);
    return p;
  }

  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  exists(rel: string): boolean {
    try { return fs.statSync(this.abs(rel)).isFile(); } catch { return false; }
  }

  /** Disk read with an optional override (the editor's unsaved buffer). */
  read(rel: string): string {
    const cached = this.cache.get(rel);
    if (cached !== undefined) return cached;
    const abs = this.abs(rel);
    if (fs.statSync(abs).size > MAX_FILE_BYTES) throw new Error(`${rel} is larger than ${MAX_FILE_BYTES / 1024} KB; read a range with start_line/end_line`);
    const text = fs.readFileSync(abs, 'utf8');
    this.cache.set(rel, text);
    return text;
  }

  invalidate(rel?: string): void {
    if (rel) this.cache.delete(rel); else this.cache.clear();
  }

  async search(pattern: string, opts: { regex?: boolean; glob?: string; maxResults?: number } = {}): Promise<SearchHit[]> {
    const max = opts.maxResults ?? 60;
    if (this.rgPath) {
      try { return await this.rgSearch(pattern, opts, max); } catch { /* fall back */ }
    }
    let re: RegExp;
    try { re = new RegExp(opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const globRe = opts.glob ? globToRegex(opts.glob) : undefined;
    const hits: SearchHit[] = [];
    for (const f of this.files) {
      if (globRe && !globRe.test(f)) continue;
      let text: string;
      try { text = this.read(f); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({ file: f, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (hits.length >= max) return hits;
        }
      }
    }
    return hits;
  }

  private rgSearch(pattern: string, opts: { regex?: boolean; glob?: string }, max: number): Promise<SearchHit[]> {
    const args = ['--json', '-i', '--max-count', '20'];
    if (!opts.regex) args.push('-F');
    if (opts.glob) args.push('-g', opts.glob);
    args.push('-e', pattern, '.');
    return new Promise((resolve, reject) => {
      execFile(this.rgPath!, args, { cwd: this.root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err && (err as any).code !== 1) return reject(err);
        const hits: SearchHit[] = [];
        for (const line of stdout.split('\n')) {
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type !== 'match') continue;
          hits.push({ file: String(ev.data.path.text).replace(/^\.\//, ''), line: ev.data.line_number, text: String(ev.data.lines.text ?? '').trim().slice(0, 200) });
          if (hits.length >= max) break;
        }
        resolve(hits);
      });
    });
  }
}

export function globToRegex(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`(^|/)${re}$`);
}
