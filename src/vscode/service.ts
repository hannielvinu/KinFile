// Per-workspace Kinfile service: indexes, the MCP server, the TrueForge client and run orchestration.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { TrueForgeClient } from '../core/trueforge';
import { CommandResult, EditorHost, KinfileMcp, MCP_SERVER_NAME, Proposal, ReviewOutcome } from '../core/mcpServer';
import { Workspace } from '../core/context/workspace';
import { SymbolIndex } from '../core/context/symbols';
import { CoChangeIndex } from '../core/context/git';
import { ContextEngine } from '../core/context/retrieve';
import { ReviewController } from './review';

export function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('kinfile').get<T>(key, fallback);
}

export class KinfileService implements EditorHost, vscode.Disposable {
  readonly ws: Workspace;
  readonly symbols: SymbolIndex;
  readonly kin: CoChangeIndex;
  readonly engine: ContextEngine;
  readonly mcp: KinfileMcp;
  readonly reviewer: ReviewController;
  private indexing?: Promise<void>;
  private registeredUrl?: string;
  commandApprover?: (command: string) => Promise<boolean>;

  constructor(readonly root: string, private out: vscode.OutputChannel) {
    this.ws = new Workspace(root);
    this.symbols = new SymbolIndex(root);
    this.kin = new CoChangeIndex(root);
    this.engine = new ContextEngine(this.ws, this.symbols, this.kin);
    this.mcp = new KinfileMcp(this, this.ws, this.symbols, this.kin);
    this.reviewer = new ReviewController(root);
    const rg = path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    const rgAlt = rg.replace('node_modules', 'node_modules.asar.unpacked');
    this.ws.rgPath = fs.existsSync(rg) ? rg : fs.existsSync(rgAlt) ? rgAlt : undefined;
  }

  get tf(): TrueForgeClient {
    return new TrueForgeClient(cfg('trueforgeUrl', 'http://localhost:8790'));
  }

  dispose(): void {
    this.mcp.stop();
    this.reviewer.dispose();
  }

  log(line: string): void {
    this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  index(): Promise<void> {
    if (!this.indexing) {
      this.indexing = (async () => {
        const t0 = Date.now();
        await this.ws.init();
        await Promise.all([this.symbols.build(this.ws.files), this.kin.build()]);
        this.log(`Indexed ${this.ws.files.length} files and ${this.kin.commitCount} commits in ${Date.now() - t0} ms`);
      })();
    }
    return this.indexing;
  }

  /** Make sure the MCP server is listening and registered in TrueForge. */
  async ensureReady(): Promise<void> {
    await this.index();
    if (!this.mcp.port) {
      const port = await this.mcp.start(cfg('mcpPort', 8791));
      this.log(`MCP server ${MCP_SERVER_NAME} listening on ${this.mcp.url}`);
      void port;
    }
    const tf = this.tf;
    const key = `${tf.url}|${this.mcp.url}`;
    if (this.registeredUrl !== key) {
      await tf.upsertMcpServer(MCP_SERVER_NAME, this.mcp.url, 'Kinfile: editor tools for the open VS Code workspace (read, search, related files, propose edits, run commands).');
      this.registeredUrl = key;
      this.log(`Registered ${MCP_SERVER_NAME} in TrueForge at ${tf.url}`);
    }
  }

  async models(): Promise<string[]> {
    const configured = cfg<string[]>('models', []).filter(Boolean);
    if (configured.length) return configured;
    return this.tf.listModels();
  }

  // ---- EditorHost -------------------------------------------------------------------------
  async readText(rel: string): Promise<string> {
    const abs = this.ws.abs(rel);
    const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === abs);
    if (open) return open.getText();
    this.ws.invalidate(rel);
    return this.ws.read(rel);
  }

  review(p: Proposal): Promise<ReviewOutcome> {
    return this.reviewer.review(p);
  }

  async runCommand(command: string, timeoutMs: number): Promise<CommandResult> {
    return new Promise(resolve => {
      const child = spawn(command, { cwd: this.root, shell: true, env: process.env });
      let output = '';
      let timedOut = false;
      const onData = (d: Buffer) => { output += d.toString(); if (output.length > 200_000) output = output.slice(-100_000); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const t = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.on('close', code => { clearTimeout(t); this.log(`$ ${command} → exit ${code}`); resolve({ code, output, timedOut }); });
      child.on('error', e => { clearTimeout(t); resolve({ code: -1, output: String(e), timedOut }); });
    });
  }
}

