// Lightweight symbol index (definitions only) for Python, TypeScript/JavaScript, Go, Rust, Java.
// Regex-based on purpose: zero native dependencies, works on any machine, fast on 10k+ files.
import * as fs from 'fs';
import * as path from 'path';

export interface SymbolDef {
  name: string;
  kind: string;
  file: string; // workspace-relative, forward slashes
  line: number; // 1-based
  container?: string;
}

const PATTERNS: Array<{ ext: RegExp; re: RegExp; kind: (m: RegExpMatchArray) => string }> = [
  { ext: /\.py$/, re: /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/, kind: m => (m[2] === 'class' ? 'class' : m[1].length ? 'method' : 'function') },
  { ext: /\.[cm]?[jt]sx?$/, re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: m => m[2] },
  { ext: /\.[cm]?[jt]sx?$/, re: /^(\s*)(?:export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: () => 'function' },
  { ext: /\.go$/, re: /^()(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: m => m[2] },
  { ext: /\.rs$/, re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait)\s+([A-Za-z_]\w*)/, kind: m => m[2] },
  { ext: /\.java$/, re: /^(\s*)(?:public|private|protected)?\s*(?:static\s+)?(class|interface|enum)\s+([A-Za-z_]\w*)/, kind: m => m[2] },
];

export class SymbolIndex {
  private byName = new Map<string, SymbolDef[]>();
  private byFile = new Map<string, SymbolDef[]>();

  constructor(private root: string) {}

  async build(files: string[]): Promise<void> {
    for (const rel of files) {
      const pats = PATTERNS.filter(p => p.ext.test(rel));
      if (!pats.length) continue;
      let text: string;
      try {
        const abs = path.join(this.root, rel);
        if (fs.statSync(abs).size > 1_000_000) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch { continue; }
      this.indexText(rel, text, pats);
    }
  }

  private indexText(rel: string, text: string, pats: typeof PATTERNS) {
    const defs: SymbolDef[] = [];
    let currentClass: { name: string; indent: number } | undefined;
    text.split('\n').forEach((line, i) => {
      for (const p of pats) {
        const m = line.match(p.re);
        if (!m) continue;
        const indent = m[1]?.length ?? 0;
        if (currentClass && indent <= currentClass.indent) currentClass = undefined;
        const kind = p.kind(m);
        const def: SymbolDef = { name: m[3], kind, file: rel, line: i + 1, container: indent > 0 ? currentClass?.name : undefined };
        defs.push(def);
        if (kind === 'class') currentClass = { name: m[3], indent };
        break;
      }
    });
    this.byFile.set(rel, defs);
    for (const d of defs) {
      const arr = this.byName.get(d.name) ?? [];
      arr.push(d);
      this.byName.set(d.name, arr);
    }
  }

  find(name: string): SymbolDef[] {
    const exact = this.byName.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    const out: SymbolDef[] = [];
    for (const [n, defs] of this.byName) if (n.toLowerCase().includes(lower)) out.push(...defs);
    return out.slice(0, 50);
  }

  inFile(file: string): SymbolDef[] {
    return this.byFile.get(file) ?? [];
  }

  /** Symbols whose name contains any of the given terms (for retrieval). */
  matchTerms(terms: string[]): SymbolDef[] {
    const out: SymbolDef[] = [];
    for (const [n, defs] of this.byName) {
      const ln = n.toLowerCase();
      if (terms.some(t => t.length >= 3 && ln.includes(t))) out.push(...defs);
    }
    return out;
  }

  outline(file: string): string {
    return this.inFile(file).map(d => `${d.line}: ${d.container ? '  ' : ''}${d.kind} ${d.name}`).join('\n');
  }
}
