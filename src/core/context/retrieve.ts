// Kinfile context assembly: rank files with four repo-agnostic signals, pack them into a token
// budget, and explain every choice (the Context Receipt).
//   1. text   : BM25-style term match over file contents and paths
//   2. symbol : definitions whose names match the request (incl. the nearest "precedent")
//   3. kin    : git co-change with the top seed files ("changed together before")
//   4. test   : the test file that pairs with a seed file
import { CoChangeIndex } from './git';
import { SymbolIndex } from './symbols';
import { Workspace } from './workspace';

export interface ReceiptEntry {
  file: string;
  reasons: string[];
  score: number;
  tokens: number;
  mode: 'full' | 'excerpt' | 'dropped';
}

export interface ContextReceipt {
  budget: number;
  used: number;
  terms: string[];
  entries: ReceiptEntry[];
  dropped: ReceiptEntry[];
  ms: number;
  filesScanned: number;
  commitsIndexed: number;
}

export interface ContextPack { text: string; receipt: ContextReceipt }

export interface AssembleOptions {
  budgetTokens?: number;
  maxFiles?: number;
  mentionedFiles?: string[];
  mentionedSymbols?: string[];
  activeFile?: string;
}

const STOP = new Set(('a an the and or but if then else for to of in on at by with from into as is are was were be been being it its this that these those any all each every other others ' +
  'must should would could can will shall may might do does did done make makes made add adds added new also only just so such than too very not no yes ' +
  'please want need use using used via per about after before over under up down out their there here when where which who what how why ' +
  'file files code change changes changed update updates updated alongside appear appears covered cover include includes including').split(/\s+/));

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function extractTerms(request: string): string[] {
  const words = request.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    const parts = [w, ...w.split(/_|(?<=[a-z])(?=[A-Z])/)];
    for (const p of parts) {
      const l = p.toLowerCase();
      if (l.length >= 3 && !STOP.has(l)) out.add(l);
    }
  }
  return [...out].slice(0, 40);
}

function stem(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.[^.]+$/, '').replace(/^test_|_test$|\.test$|\.spec$/, '');
}

const isTest = (f: string) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /(^|\/)test_[^/]+$|_test\.\w+$|\.(test|spec)\.\w+$/.test(f);

export class ContextEngine {
  constructor(private ws: Workspace, private symbols: SymbolIndex, private kin: CoChangeIndex) {}

  assemble(request: string, opts: AssembleOptions = {}): ContextPack {
    const t0 = Date.now();
    const budget = opts.budgetTokens ?? 32000;
    const maxFiles = opts.maxFiles ?? 10;
    const terms = extractTerms(request);
    const files = this.ws.files;
    const N = files.length || 1;

    // --- signal 1: text (BM25-ish) + path ---------------------------------------------------
    const lowerText = new Map<string, string>();
    const df = new Map<string, number>();
    for (const f of files) {
      let t: string;
      try { t = this.ws.read(f).toLowerCase(); } catch { continue; }
      lowerText.set(f, t);
      for (const term of terms) if (t.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const idf = (term: string) => Math.log(1 + N / (1 + (df.get(term) ?? 0)));
    // Path idf is computed over paths, so a term in every path (e.g. the package name) is worth ~0.
    const segsOf = (f: string) => f.toLowerCase().split(/[\/._-]/);
    const pdf = new Map<string, number>();
    for (const f of files) { const segs = new Set(segsOf(f)); for (const term of terms) if (segs.has(term)) pdf.set(term, (pdf.get(term) ?? 0) + 1); }
    const pidf = (term: string) => Math.max(0, Math.log(N / (1 + (pdf.get(term) ?? 0))));
    const score = new Map<string, number>();
    const reasons = new Map<string, string[]>();
    const add = (f: string, s: number, why?: string) => {
      score.set(f, (score.get(f) ?? 0) + s);
      if (why) {
        const r = reasons.get(f) ?? [];
        if (!r.includes(why)) r.push(why);
        reasons.set(f, r);
      }
    };

    for (const [f, t] of lowerText) {
      const lines = t.split('\n').length;
      let s = 0;
      const matched: string[] = [];
      for (const term of terms) {
        let tf = 0, i = -1;
        while ((i = t.indexOf(term, i + 1)) >= 0 && tf < 30) tf++;
        if (tf) { s += idf(term) * Math.log(1 + tf); matched.push(term); }
      }
      s /= Math.log(2 + lines / 80);
      const segs = segsOf(f);
      const pathTerms = terms.filter(term => segs.includes(term) && pidf(term) > 2.3);
      s += pathTerms.reduce((a, term) => a + 2.5 * pidf(term), 0);
      if (s > 0) add(f, s);
      if (pathTerms.length) add(f, 0, `path matches "${pathTerms.join('", "')}"`);
      else if (matched.length >= 3) add(f, 0, `mentions ${matched.slice(0, 4).map(m => `"${m}"`).join(', ')}`);
    }

    // --- signal 2: symbols (definitions matching the request = the precedent to copy) --------
    const symHits = new Map<string, string[]>();
    const symTerms = terms.filter(t => t.length >= 4 && idf(t) > 1.2);
    for (const d of this.symbols.matchTerms(symTerms)) {
      const arr = symHits.get(d.file) ?? [];
      if (arr.length < 6 && !arr.includes(d.name)) arr.push(d.name);
      symHits.set(d.file, arr);
    }
    for (const [f, names] of symHits) add(f, 1.2 * Math.min(names.length, 5), `defines ${names.slice(0, 3).join(', ')}`);

    // --- explicit mentions + editor focus ----------------------------------------------------
    for (const f of opts.mentionedFiles ?? []) add(f, 1000, '@-mentioned by you');
    for (const s of opts.mentionedSymbols ?? []) for (const d of this.symbols.find(s).slice(0, 3)) add(d.file, 500, `@${s} is defined here (line ${d.line})`);
    if (opts.activeFile && score.has(opts.activeFile)) add(opts.activeFile, 2, 'open in your editor');

    // --- signal 3 + 4: kin (git co-change) and test pairing, seeded by the top source files --
    const ranked0 = [...score.entries()].sort((a, b) => b[1] - a[1]);
    if (process.env.KINFILE_DEBUG) console.log("ranked0", ranked0.slice(0, 12).map(([f, s]) => `${f}=${s.toFixed(1)}`).join(" "));
    const seeds = ranked0.filter(([f]) => !isTest(f) && !/\.(md|rst|txt)$/.test(f)).slice(0, 3);
    for (const [seed, seedScore] of seeds) {
      for (const k of this.kin.related(seed, 6)) {
        if (k.confidence < 0.08 && k.together < 8) continue;
        const rel = seedScore / (seeds[0][1] || 1);
        add(k.file, rel * rel * (0.35 * seedScore * Math.min(1, k.confidence * 2) + Math.log(1 + k.together)),
          `changed together with ${seed} in ${k.together} of its ${k.seedCommits} commits`);
      }
      const st = stem(seed);
      for (const f of files) {
        if (f !== seed && isTest(f) && stem(f) === st) add(f, (seedScore / (seeds[0][1] || 1)) * (0.3 * seedScore) + 2, `test file for ${seed}`);
      }
    }

    // --- pack into the budget ---------------------------------------------------------------
    // The strongest source file is the anchor of the change: pack it first so it is never squeezed out.
    if (seeds.length) add(seeds[0][0], 0, 'strongest match for your request (anchor file)');
    const ranked = [...score.entries()].filter(([f]) => (reasons.get(f)?.length ?? 0) > 0).sort((a, b) => b[1] - a[1]);
    if (seeds.length) {
      const i = ranked.findIndex(([f]) => f === seeds[0][0]);
      if (i > 0) ranked.unshift(...ranked.splice(i, 1));
    }
    const perFileCap = Math.max(1500, Math.floor(budget * 0.25));
    const entries: ReceiptEntry[] = [];
    const dropped: ReceiptEntry[] = [];
    const blocks: string[] = [];
    let used = 0;
    for (const [f, s] of ranked) {
      const why = reasons.get(f) ?? [];
      if (entries.length >= maxFiles) { if (dropped.length < 5) dropped.push({ file: f, reasons: why, score: s, tokens: 0, mode: 'dropped' }); continue; }
      let full: string;
      try { full = this.ws.read(f); } catch { continue; }
      const remaining = budget - used;
      if (remaining < 400) { if (dropped.length < 5) dropped.push({ file: f, reasons: [...why, 'over budget'], score: s, tokens: estimateTokens(full), mode: 'dropped' }); continue; }
      const fullTok = estimateTokens(full);
      let body: string, mode: ReceiptEntry['mode'];
      const isProse = /\.(md|rst|txt)$/i.test(f);
      const cap = Math.min(remaining, isProse ? Math.floor(perFileCap / 2) : perFileCap);
      if (fullTok <= cap) { body = numbered(full, 1); mode = 'full'; }
      else { body = this.excerpt(f, full, terms, symHits.get(f) ?? [], cap); mode = 'excerpt'; }
      const tok = estimateTokens(body);
      if (tok > remaining) { if (dropped.length < 5) dropped.push({ file: f, reasons: [...why, 'over budget'], score: s, tokens: tok, mode: 'dropped' }); continue; }
      used += tok;
      entries.push({ file: f, reasons: why, score: Math.round(s * 10) / 10, tokens: tok, mode });
      blocks.push(`### ${f}  (${mode === 'full' ? 'full file' : 'excerpt'}; why: ${why.join('; ')})\n\`\`\`\n${body}\n\`\`\``);
    }

    const receipt: ContextReceipt = { budget, used, terms, entries, dropped, ms: Date.now() - t0, filesScanned: lowerText.size, commitsIndexed: this.kin.commitCount };
    const header = `## Context selected by Kinfile (budget ${budget} tokens, used ${used}; ${entries.length} files chosen from ${lowerText.size})\n` +
      `Line numbers are prefixed as "N| ". Use read_file for anything not shown, and related_files to find files that usually change with the one you edit.\n`;
    return { text: header + '\n' + blocks.join('\n\n'), receipt };
  }

  /** Outline + windows around the most relevant lines, within maxTokens. */
  private excerpt(file: string, text: string, terms: string[], symbolNames: string[], maxTokens: number): string {
    const lines = text.split('\n');
    const weight = new Array<number>(lines.length).fill(0);
    const lowerTerms = terms;
    lines.forEach((l, i) => {
      const ll = l.toLowerCase();
      for (const t of lowerTerms) if (ll.includes(t)) weight[i] += 1;
    });
    for (const name of symbolNames) for (const d of this.symbols.inFile(file)) if (d.name === name) weight[d.line - 1] += 4;
    const order = weight.map((w, i) => [w, i] as const).filter(([w]) => w > 0).sort((a, b) => b[0] - a[0]);
    const keep = new Set<number>();
    let outline = this.symbols.outline(file);
    if (estimateTokens(outline) > maxTokens / 4) outline = outline.slice(0, maxTokens) + '\n...';
    let tokens = estimateTokens(outline) + 50;
    for (const [, i] of order) {
      const lo = Math.max(0, i - 6), hi = Math.min(lines.length - 1, i + 18);
      let add = 0;
      for (let j = lo; j <= hi; j++) if (!keep.has(j)) add += estimateTokens(lines[j]) + 2;
      if (tokens + add > maxTokens) continue;
      for (let j = lo; j <= hi; j++) keep.add(j);
      tokens += add;
    }
    const out: string[] = [];
    if (outline) out.push(`# outline of ${file} (${lines.length} lines)\n${outline}\n# relevant excerpts`);
    let prev = -2;
    [...keep].sort((a, b) => a - b).forEach(i => {
      if (i !== prev + 1) out.push('   ...');
      out.push(`${i + 1}| ${lines[i]}`);
      prev = i;
    });
    return out.join('\n');
  }
}

export function numbered(text: string, start: number): string {
  return text.split('\n').map((l, i) => `${start + i}| ${l}`).join('\n');
}

export function receiptMarkdown(r: ContextReceipt): string {
  const rows = r.entries.map(e => `- ${e.file} (${e.tokens} tok, ${e.mode}): ${e.reasons.join('; ')}`);
  return `Context Receipt: ${r.used}/${r.budget} tokens, ${r.entries.length} files from ${r.filesScanned} scanned, ${r.commitsIndexed} commits indexed, ${r.ms} ms\n${rows.join('\n')}`;
}
