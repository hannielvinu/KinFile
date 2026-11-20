// Agent panel (webview view). One request drives a TrueForge agent through the tool loop.
import * as vscode from 'vscode';
import * as path from 'path';
import { KinfileService, cfg } from './service';
import { KinfileRun, UiEvent } from '../core/run';
import { agentSpec } from '../core/agentSpec';

export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'kinfile.agent';
  private view?: vscode.WebviewView;
  private run?: KinfileRun;
  private pendingCommands = new Map<string, (ok: boolean) => void>();
  private queue: unknown[] = [];

  constructor(private ctx: vscode.ExtensionContext, private svc: () => KinfileService | undefined) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
    view.onDidDispose(() => { this.view = undefined; });
    for (const m of this.queue.splice(0)) view.webview.postMessage(m);
    const s = this.svc();
    if (s) s.reviewer.onJournalChange.event(label => this.post({ type: 'journal', label }));
    this.refreshModels();
  }

  post(m: unknown): void {
    if (process.env.KINFILE_TRACE) require('fs').appendFileSync(process.env.KINFILE_TRACE, JSON.stringify(m) + '\n');
    if (this.view) this.view.webview.postMessage(m);
    else this.queue.push(m);
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand('kinfile.agent.focus');
  }

  get running(): boolean { return !!this.run; }

  async refreshModels(): Promise<void> {
    const s = this.svc();
    if (!s) return;
    try {
      const models = await s.models();
      this.post({ type: 'models', models, url: s.tf.url });
    } catch (e: any) {
      this.post({ type: 'models', models: [], url: s.tf.url, error: String(e?.message ?? e) });
    }
  }

  private async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'send': return this.startRun(String(m.text ?? ''));
      case 'stop': return this.stop();
      case 'mention': return this.pickMention();
      case 'open': {
        const s = this.svc();
        if (s) vscode.window.showTextDocument(vscode.Uri.file(path.join(s.root, m.file)), { preview: true });
        return;
      }
      case 'openUrl': return void vscode.env.openExternal(vscode.Uri.parse(m.url));
      case 'command': {
        const r = this.pendingCommands.get(m.id);
        this.pendingCommands.delete(m.id);
        r?.(Boolean(m.ok));
        return;
      }
      case 'undo': return void vscode.commands.executeCommand('kinfile.undoLast');
      case 'refresh': return this.refreshModels();
    }
  }

  async stop(): Promise<void> {
    if (!this.run) return;
    const r = this.run;
    this.post({ type: 'status', text: 'Cancelling…' });
    await r.cancel();
    this.svc()?.reviewer.dropAll('Run cancelled');
    for (const [, res] of this.pendingCommands) res(false);
    this.pendingCommands.clear();
  }

  private async pickMention(): Promise<void> {
    const s = this.svc();
    if (!s) return;
    await s.index();
    const items: vscode.QuickPickItem[] = s.ws.files.map(f => ({ label: f, description: 'file' }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Mention a file (type a symbol name to search symbols instead)', matchOnDescription: true });
    if (pick) { this.post({ type: 'insert', text: `@${pick.label} ` }); return; }
    const name = await vscode.window.showInputBox({ prompt: 'Mention a symbol (function or class name)' });
    if (name) this.post({ type: 'insert', text: `@${name} ` });
  }

  /** Parse @path and @Symbol mentions out of the request. */
  private parseMentions(s: KinfileService, text: string): { files: string[]; symbols: string[] } {
    const files: string[] = [], symbols: string[] = [];
    for (const m of text.matchAll(/@([\w./\\-]+)/g)) {
      const t = m[1].replace(/\\/g, '/').replace(/[.,;:]+$/, '');
      if (s.ws.files.includes(t)) files.push(t);
      else if (s.symbols.find(t).length) symbols.push(t);
    }
    return { files, symbols };
  }

  async startRun(text: string): Promise<void> {
    text = text.trim();
    if (!text || this.run) return;
    const s = this.svc();
    if (!s) { vscode.window.showErrorMessage('Kinfile: open a folder first.'); return; }
    this.post({ type: 'user', text });
    let models: string[];
    try {
      await s.ensureReady();
      models = await s.models();
    } catch (e: any) {
      this.post({ type: 'event', e: { kind: 'done', status: 'error', text: String(e?.message ?? e) } });
      return;
    }
    const mentions = this.parseMentions(s, text);
    const active = vscode.window.activeTextEditor?.document;
    const activeRel = active?.uri.scheme === 'file' && active.uri.fsPath.startsWith(s.root) ? s.ws.rel(active.uri.fsPath) : undefined;
    const pack = s.engine.assemble(text, { budgetTokens: cfg('contextBudgetTokens', 32000), mentionedFiles: mentions.files, mentionedSymbols: mentions.symbols, activeFile: activeRel });
    this.post({ type: 'receipt', receipt: pack.receipt });
    s.log(`Context: ${pack.receipt.used}/${pack.receipt.budget} tokens, ${pack.receipt.entries.map(e => e.file).join(', ')}`);

    const message = `${text}\n\n---\n${pack.text}`;
    const run = new KinfileRun(s.tf, model => agentSpec({ model, compactionTokens: cfg('compactionTokens', 60000) }), {
      models,
      retryBackoffMs: 1500,
      firstEventTimeoutMs: cfg('firstResponseTimeoutSeconds', 120) * 1000,
    }, {
      emit: (e: UiEvent) => this.post({ type: 'event', e }),
      review: p => s.review(p),
      approveCommand: command => new Promise<boolean>(resolve => {
        const id = String(Date.now() + Math.random());
        this.pendingCommands.set(id, resolve);
        this.post({ type: 'askCommand', id, command });
      }),
    }, { host: s, ws: s.ws, mcp: s.mcp });
    this.run = run;
    this.post({ type: 'running', running: true });
    try {
      await run.start(message);
    } finally {
      this.run = undefined;
      this.post({ type: 'running', running: false });
      s.ws.invalidate();
    }
  }

  private html(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'panel.js'));
    const nonce = String(Math.random()).slice(2);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<header id="hdr"><span class="brand">Kinfile</span><span id="models" class="models">connecting…</span></header>
<main id="log"><div class="empty">Ask for a change in plain words. Kinfile picks the files (and shows why), the agent runs on TrueForge, and every edit waits for your review.</div></main>
<footer>
  <textarea id="input" rows="3" placeholder="Describe the change… (@ to mention a file or symbol, Enter to send)"></textarea>
  <div class="row"><button id="at" title="Mention a file or symbol">@</button><span class="spacer"></span><button id="stop" class="danger" hidden>■ Stop</button><button id="send" class="primary">Send</button></div>
</footer>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
