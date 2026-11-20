// Hunk-by-hunk review rendered in the editor.
// A read-only "kinfile-review:" document shows the file with each proposed hunk inline
// (removed lines red, added lines green) and CodeLens "Accept / Reject" above each hunk.
// Disk changes only when a hunk is accepted: that hunk is applied to the real document as one
// undoable edit and saved. "Kinfile: Undo Last Applied Change" (or Ctrl+Z in the file) reverts it.
import * as vscode from 'vscode';
import * as path from 'path';
import { Hunk, acceptHunk, computeHunks, rejectHunk } from '../core/stage';
import { Proposal, ReviewOutcome } from '../core/mcpServer';

export const REVIEW_SCHEME = 'kinfile-review';

interface Item {
  p: Proposal;
  realUri: vscode.Uri;
  reviewUri: vscode.Uri;
  proposed: string;
  accepted: number;
  rejected: number;
  total: number;
  resolve: (o: ReviewOutcome) => void;
  /** line -> kind for decorations, rebuilt on every render */
  marks: { removed: number[]; added: number[]; header: number[] };
  hunkLines: Array<{ hunk: Hunk; line: number }>;
  rendered: string;
}

interface JournalEntry { uri: vscode.Uri; before: string; after: string; label: string; created: boolean }

export class ReviewController implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private items = new Map<string, Item>(); // key: review uri string
  private journal: JournalEntry[] = [];
  private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private removedDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    isWholeLine: true, textDecoration: 'line-through',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    before: { contentText: '−', color: new vscode.ThemeColor('editorError.foreground'), margin: '0 6px 0 0' },
  });
  private addedDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    before: { contentText: '+', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), margin: '0 6px 0 0' },
  });
  private disposables: vscode.Disposable[] = [];
  private rerender?: ReturnType<typeof setTimeout>;
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  readonly onJournalChange = new vscode.EventEmitter<string | undefined>();

  constructor(private root: string) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
      // Keep an open review in sync if the real file changes underneath it (e.g. Undo, or the user types).
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme !== 'file') return;
        for (const item of this.items.values()) {
          if (item.realUri.fsPath !== e.document.uri.fsPath) continue;
          clearTimeout(this.rerender);
          this.rerender = setTimeout(async () => { if ((await this.render(item)).length === 0) this.finish(item); this.updateStatus(); }, 150);
        }
      }),
      vscode.commands.registerCommand('kinfile.acceptHunk', (k: string, line: number) => this.decide(k, line, true)),
      vscode.commands.registerCommand('kinfile.rejectHunk', (k: string, line: number) => this.decide(k, line, false)),
      vscode.commands.registerCommand('kinfile.acceptAll', (k?: string) => this.decideAll(k, true)),
      vscode.commands.registerCommand('kinfile.rejectAll', (k?: string) => this.decideAll(k, false)),
      vscode.commands.registerCommand('kinfile.undoLast', () => this.undoLast()),
      vscode.commands.registerCommand('kinfile.acceptNextHunk', () => this.decideNext(true)),
      vscode.commands.registerCommand('kinfile.rejectNextHunk', () => this.decideNext(false)),
      this.status,
    );
  }

  dispose(): void {
    this.dropAll('Review closed');
    this.disposables.forEach(d => d.dispose());
  }

  get pendingCount(): number { return this.items.size; }
  get lastApplied(): string | undefined { return this.journal[this.journal.length - 1]?.label; }

  review(p: Proposal): Promise<ReviewOutcome> {
    const realUri = vscode.Uri.file(path.join(this.root, p.path));
    const reviewUri = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${p.path} (Kinfile proposal)`, query: `t=${Date.now()}` });
    return new Promise<ReviewOutcome>(async resolve => {
      const total = computeHunks(p.before, p.proposed).length;
      const item: Item = { p, realUri, reviewUri, proposed: p.proposed, accepted: 0, rejected: 0, total, resolve, marks: { removed: [], added: [], header: [] }, hunkLines: [], rendered: '' };
      this.items.set(reviewUri.toString(), item);
      await this.render(item);
      const doc = await vscode.workspace.openTextDocument(reviewUri);
      const lang = languageFor(p.path);
      if (lang) await vscode.languages.setTextDocumentLanguage(doc, lang).then(undefined, () => undefined);
      const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.One });
      const first = item.hunkLines[0]?.line ?? 0;
      editor.revealRange(new vscode.Range(first, 0, first, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.decorateAll();
      this.updateStatus();
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.items.get(uri.toString())?.rendered ?? '(review finished)';
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const item = this.items.get(doc.uri.toString());
    if (!item) return [];
    const k = doc.uri.toString();
    const top = new vscode.Range(0, 0, 0, 0);
    const n = item.hunkLines.length;
    const lenses = [
      new vscode.CodeLens(top, { title: `Kinfile proposal · ${item.p.isNew ? 'new file ' : ''}${item.p.path} · ${n} hunk${n === 1 ? '' : 's'} left`, command: '' }),
      new vscode.CodeLens(top, { title: '$(check-all) Accept all', command: 'kinfile.acceptAll', arguments: [k] }),
      new vscode.CodeLens(top, { title: '$(close-all) Reject all', command: 'kinfile.rejectAll', arguments: [k] }),
    ];
    item.hunkLines.forEach(({ line }, i) => {
      const r = new vscode.Range(line, 0, line, 0);
      lenses.push(new vscode.CodeLens(r, { title: `$(check) Accept hunk ${i + 1}/${n}${i === 0 ? ' (Ctrl+Alt+Y)' : ''}`, command: 'kinfile.acceptHunk', arguments: [k, line] }));
      lenses.push(new vscode.CodeLens(r, { title: i === 0 ? '$(x) Reject (Ctrl+Alt+N)' : '$(x) Reject', command: 'kinfile.rejectHunk', arguments: [k, line] }));
    });
    return lenses;
  }

  private async currentText(item: Item): Promise<string> {
    if (item.p.isNew) {
      try { await vscode.workspace.fs.stat(item.realUri); } catch { return ''; }
    }
    const doc = await vscode.workspace.openTextDocument(item.realUri);
    return doc.getText();
  }

  private async render(item: Item): Promise<Hunk[]> {
    const current = await this.currentText(item);
    const hunks = computeHunks(current, item.proposed);
    const lines = current.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const out: string[] = [];
    const marks = { removed: [] as number[], added: [] as number[], header: [] as number[] };
    const hunkLines: Item['hunkLines'] = [];
    let i = 0;
    const push = (l: string, kind?: 'removed' | 'added') => {
      if (kind) marks[kind].push(out.length);
      out.push(l.endsWith('\n') ? l : l + '\n');
    };
    for (const h of hunks) {
      while (i < h.oldStart) push(lines[i++]);
      hunkLines.push({ hunk: h, line: out.length });
      for (const l of h.removed) push(l, 'removed');
      for (const l of h.added) push(l, 'added');
      i += h.oldLines;
    }
    while (i < lines.length) push(lines[i++]);
    item.rendered = out.join('');
    item.marks = marks;
    item.hunkLines = hunkLines;
    this.changeEmitter.fire(item.reviewUri);
    this.lensEmitter.fire();
    setTimeout(() => this.decorateAll(), 30);
    return hunks;
  }

  private decorateAll(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      const item = this.items.get(ed.document.uri.toString());
      if (!item) continue;
      const rng = (ls: number[]) => ls.filter(l => l < ed.document.lineCount).map(l => new vscode.Range(l, 0, l, 0));
      ed.setDecorations(this.removedDeco, rng(item.marks.removed));
      ed.setDecorations(this.addedDeco, rng(item.marks.added));
    }
  }

  private async decide(key: string, line: number, accept: boolean): Promise<void> {
    const item = this.items.get(key);
    if (!item) return;
    const h = item.hunkLines.find(x => x.line === line)?.hunk;
    if (!h) return;
    if (accept) {
      const current = await this.currentText(item);
      const next = acceptHunk(current, h);
      await this.writeReal(item, current, next, `${item.p.path} (hunk ${h.index + 1})`);
      item.accepted++;
    } else {
      item.proposed = rejectHunk(item.proposed, h);
      item.rejected++;
    }
    const left = await this.render(item);
    if (left.length === 0) this.finish(item);
    this.updateStatus();
  }

  /** Keyboard review: act on the first remaining hunk of the focused (or oldest) proposal. */
  private async decideNext(accept: boolean): Promise<void> {
    const activeKey = vscode.window.activeTextEditor?.document.uri.toString();
    const item = (activeKey && this.items.get(activeKey)) || [...this.items.values()][0];
    const first = item?.hunkLines[0];
    if (!item || !first) { vscode.window.setStatusBarMessage('Kinfile: no hunk to review', 2000); return; }
    await this.decide(item.reviewUri.toString(), first.line, accept);
  }

  private async decideAll(key: string | undefined, accept: boolean): Promise<void> {
    const targets = key ? [this.items.get(key)].filter(Boolean) as Item[] : [...this.items.values()];
    for (const item of targets) {
      const current = await this.currentText(item);
      const hunks = computeHunks(current, item.proposed);
      if (accept) {
        await this.writeReal(item, current, item.proposed, `${item.p.path} (${hunks.length} hunks)`);
        item.accepted += hunks.length;
      } else {
        item.proposed = current;
        item.rejected += hunks.length;
      }
      await this.render(item);
      this.finish(item);
    }
    this.updateStatus();
  }

  /** Apply text to the real file as one undoable editor edit, then save (the only disk write). */
  private async writeReal(item: Item, before: string, after: string, label: string): Promise<void> {
    const created = item.p.isNew && before === '' && !(await exists(item.realUri));
    await applyText(item.realUri, after, created);
    this.journal.push({ uri: item.realUri, before, after, label, created });
    if (this.journal.length > 50) this.journal.shift();
    this.onJournalChange.fire(label);
  }

  private finish(item: Item): void {
    const key = item.reviewUri.toString();
    if (!this.items.has(key)) return;
    this.items.delete(key);
    item.resolve({ accepted: item.accepted, rejected: item.rejected, finalText: '' });
    // Close the review tab and show the real file.
    for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) vscode.window.tabGroups.close(tab).then(undefined, () => undefined);
    }
    if (item.accepted > 0) vscode.window.showTextDocument(item.realUri, { preview: true, preserveFocus: true }).then(undefined, () => undefined);
    this.lensEmitter.fire();
  }

  /** Cancel: unreviewed hunks are dropped (never written). Accepted hunks stay; they were the user's choice. */
  dropAll(note = 'Run cancelled'): void {
    for (const item of [...this.items.values()]) {
      item.rejected += Math.max(0, item.hunkLines.length);
      const key = item.reviewUri.toString();
      this.items.delete(key);
      item.resolve({ accepted: item.accepted, rejected: item.rejected, finalText: '', note });
      for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) vscode.window.tabGroups.close(tab).then(undefined, () => undefined);
      }
    }
    this.lensEmitter.fire();
    this.updateStatus();
  }

  async undoLast(): Promise<void> {
    const e = this.journal.pop();
    if (!e) { vscode.window.showInformationMessage('Kinfile: nothing to undo.'); return; }
    const now = (await exists(e.uri)) ? (await vscode.workspace.openTextDocument(e.uri)).getText() : '';
    if (now !== e.after) {
      const pick = await vscode.window.showWarningMessage(`${path.basename(e.uri.fsPath)} changed after Kinfile applied ${e.label}. Undo anyway?`, 'Undo anyway', 'Cancel');
      if (pick !== 'Undo anyway') { this.journal.push(e); return; }
    }
    if (e.created && e.before === '') {
      await vscode.workspace.fs.delete(e.uri).then(undefined, () => undefined);
    } else {
      await applyText(e.uri, e.before, false);
    }
    vscode.window.showInformationMessage(`Kinfile: undid ${e.label}.`);
    this.onJournalChange.fire(this.lastApplied);
  }

  private updateStatus(): void {
    const n = [...this.items.values()].reduce((a, i) => a + i.hunkLines.length, 0);
    vscode.commands.executeCommand('setContext', 'kinfile.reviewing', n > 0);
    if (n > 0) {
      this.status.text = `$(diff) Kinfile: ${n} hunk${n === 1 ? '' : 's'} to review`;
      this.status.command = undefined;
      this.status.show();
    } else this.status.hide();
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

async function applyText(uri: vscode.Uri, text: string, create: boolean): Promise<void> {
  const we = new vscode.WorkspaceEdit();
  if (create) {
    we.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(text) });
    await vscode.workspace.applyEdit(we);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  we.replace(uri, full, text);
  await vscode.workspace.applyEdit(we);
  await doc.save();
}

function languageFor(p: string): string | undefined {
  const ext = path.extname(p).toLowerCase();
  return ({ '.py': 'python', '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.json': 'json', '.md': 'markdown', '.rst': 'restructuredtext', '.go': 'go', '.rs': 'rust', '.java': 'java', '.html': 'html', '.css': 'css', '.toml': 'toml', '.yaml': 'yaml', '.yml': 'yaml' } as Record<string, string>)[ext];
}
