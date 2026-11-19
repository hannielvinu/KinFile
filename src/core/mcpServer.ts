// The editor's capabilities, exposed to the TrueForge agent as MCP tools over local HTTP.
// The agent decides what to read and change; Kinfile only executes, and every write is reviewed.
import * as http from 'http';
import { createHash } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Workspace } from './context/workspace';
import { SymbolIndex } from './context/symbols';
import { CoChangeIndex } from './context/git';
import { numbered } from './context/retrieve';
import { applyReplace } from './stage';

export const MCP_SERVER_NAME = 'kinfile-editor';
export const WRITE_TOOLS = ['propose_edit', 'create_file'];
export const APPROVAL_TOOLS = ['propose_edit', 'create_file', 'run_command'];
export const PRELOADED_TOOLS = ['read_file', 'search_code', 'related_files', 'propose_edit'];

export interface Proposal {
  key: string;
  tool: string;
  path: string;
  before: string;
  proposed: string;
  isNew: boolean;
  explanation?: string;
}

export interface ReviewOutcome {
  accepted: number;
  rejected: number;
  finalText: string;
  note?: string;
}

export interface CommandResult { code: number | null; output: string; timedOut: boolean }

export interface EditorHost {
  /** Current text of a workspace file, including unsaved editor changes. */
  readText(rel: string): Promise<string>;
  /** Show a proposal for hunk-by-hunk review; resolves once every hunk is accepted or rejected. */
  review(p: Proposal): Promise<ReviewOutcome>;
  runCommand(command: string, timeoutMs: number): Promise<CommandResult>;
  log(line: string): void;
}

export function toolKey(tool: string, args: unknown): string {
  const canon = JSON.stringify(args, Object.keys((args ?? {}) as object).sort());
  return createHash('sha1').update(tool + '\u0000' + canon).digest('hex');
}

/** Build the staged proposal for a write tool call (used before approval and at execution). */
export async function buildProposal(host: EditorHost, ws: Workspace, tool: string, args: any): Promise<Proposal> {
  const rel = normalizeRel(String(args.path ?? ''));
  ws.abs(rel); // throws if outside the workspace
  const exists = ws.exists(rel);
  const before = exists ? await host.readText(rel) : '';
  let proposed: string;
  if (tool === 'create_file') {
    proposed = String(args.content ?? '');
  } else {
    if (!exists) throw new Error(`${rel} does not exist. Use create_file to add a new file.`);
    proposed = applyReplace(before, String(args.old_string ?? ''), String(args.new_string ?? ''), Boolean(args.replace_all));
  }
  if (proposed === before) throw new Error('The edit would not change the file.');
  return { key: toolKey(tool, args), tool, path: rel, before, proposed, isNew: !exists, explanation: args.explanation };
}

export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export class KinfileMcp {
  private server?: http.Server;
  port = 0;
  /** Review outcomes decided during TrueForge's approval step, keyed by tool call. */
  readonly outcomes = new Map<string, ReviewOutcome>();

  constructor(private host: EditorHost, private ws: Workspace, private symbols: SymbolIndex, private kin: CoChangeIndex) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  private build(): McpServer {
    const s = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' });
    const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

    s.registerTool('read_file', {
      description: 'Read a workspace file (with line numbers "N| "). Large files: pass start_line/end_line (max 600 lines per call).',
      inputSchema: { path: z.string().describe('Workspace-relative path'), start_line: z.number().int().optional(), end_line: z.number().int().optional() },
      annotations: ro,
    }, async ({ path, start_line, end_line }) => {
      try {
        const rel = normalizeRel(path);
        const t = await this.host.readText(rel);
        const lines = t.split('\n');
        const a = Math.max(1, start_line ?? 1);
        const b = Math.min(lines.length, end_line ?? Math.min(lines.length, a + 599));
        this.host.log(`read_file ${rel}:${a}-${b}`);
        const more = b < lines.length ? `\n... (${lines.length - b} more lines; call again with start_line=${b + 1})` : '';
        return text(`${rel} (${lines.length} lines)\n${numbered(lines.slice(a - 1, b).join('\n'), a)}${more}`);
      } catch (e: any) { return fail(String(e?.message ?? e)); }
    });

    s.registerTool('search_code', {
      description: 'Search file contents in the workspace (case-insensitive). Returns file:line: text.',
      inputSchema: { query: z.string(), regex: z.boolean().optional(), glob: z.string().optional().describe('e.g. "**/*.py" or "docs/**"') },
      annotations: ro,
    }, async ({ query, regex, glob }) => {
      const hits = await this.ws.search(query, { regex, glob, maxResults: 60 });
      this.host.log(`search_code "${query}" → ${hits.length} hits`);
      return text(hits.length ? hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n') : 'No matches.');
    });

    s.registerTool('related_files', {
      description: 'Files that usually change together with the given file (from git history), plus its test file. Use this before editing to find the tests, docs and changelog a change also needs.',
      inputSchema: { path: z.string() },
      annotations: ro,
    }, async ({ path }) => {
      const rel = normalizeRel(path);
      const kin = this.kin.related(rel, 10);
      const st = (rel.split('/').pop() ?? rel).replace(/\.[^.]+$/, '');
      const tests = this.ws.files.filter(f => f !== rel && /(^|\/)tests?\//.test(f) && new RegExp(`(^|/)test_${st}\\.|${st}[._]test\\.`).test(f));
      this.host.log(`related_files ${rel} → ${kin.length} kin`);
      const lines = kin.map(k => `${k.file}: changed together in ${k.together} of ${k.seedCommits} commits (${Math.round(k.confidence * 100)}%)`);
      if (tests.length) lines.push(...tests.map(t => `${t}: test file for ${rel}`));
      return text(lines.length ? lines.join('\n') : `No history-based relations for ${rel} (new file or no git history).`);
    });

    s.registerTool('find_symbol', {
      description: 'Find where a function/class/method is defined (name or partial name).',
      inputSchema: { name: z.string() },
      annotations: ro,
    }, async ({ name }) => {
      const defs = this.symbols.find(name).slice(0, 30);
      this.host.log(`find_symbol ${name} → ${defs.length}`);
      return text(defs.length ? defs.map(d => `${d.file}:${d.line} ${d.kind} ${d.container ? d.container + '.' : ''}${d.name}`).join('\n') : `No definition named "${name}". Do not invent it; search_code instead.`);
    });

    s.registerTool('list_files', {
      description: 'List workspace files, optionally filtered by a glob such as "src/**/*.py".',
      inputSchema: { glob: z.string().optional(), limit: z.number().int().optional() },
      annotations: ro,
    }, async ({ glob, limit }) => {
      const { globToRegex } = await import('./context/workspace');
      const re = glob ? globToRegex(glob) : undefined;
      const out = this.ws.files.filter(f => !re || re.test(f)).slice(0, limit ?? 300);
      return text(out.join('\n') || 'No files.');
    });

    const writeTool = async (tool: string, args: any) => {
      const key = toolKey(tool, args);
      let outcome = this.outcomes.get(key);
      this.outcomes.delete(key);
      try {
        if (!outcome) {
          // Not reviewed during approval (e.g. approved from another client): review now. Never write silently.
          const p = await buildProposal(this.host, this.ws, tool, args);
          outcome = await this.host.review(p);
        }
      } catch (e: any) { return fail(String(e?.message ?? e)); }
      this.ws.invalidate(normalizeRel(args.path));
      if (outcome.accepted === 0) return fail(`The user rejected every hunk of this edit to ${args.path}. ${outcome.note ?? ''} Do not repeat it; ask or try a different approach.`);
      const partial = outcome.rejected ? ` The user rejected ${outcome.rejected} hunk(s); the file now differs from your proposal, so re-read it before editing again.` : '';
      return text(`Applied ${outcome.accepted} hunk(s) to ${args.path}.${partial}`);
    };

    s.registerTool('propose_edit', {
      description: 'Propose a change to an existing file by replacing old_string (exact text, unique in the file, include 2-3 lines of context) with new_string. The user reviews it hunk by hunk before anything is written.',
      inputSchema: { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional(), explanation: z.string().optional().describe('One line: why this change') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, args => writeTool('propose_edit', args));

    s.registerTool('create_file', {
      description: 'Propose a new file with the given full content. The user reviews it before it is created.',
      inputSchema: { path: z.string(), content: z.string(), explanation: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, args => writeTool('create_file', args));

    s.registerTool('run_command', {
      description: 'Run a shell command in the workspace root (e.g. tests). The user approves it first. Output is truncated to the last 8 KB.',
      inputSchema: { command: z.string(), timeout_seconds: z.number().int().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async ({ command, timeout_seconds }) => {
      this.host.log(`run_command ${command}`);
      const r = await this.host.runCommand(command, Math.min(600, timeout_seconds ?? 120) * 1000);
      return text(`exit code: ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${r.output.slice(-8000)}`);
    });

    return s;
  }

  async start(preferredPort = 8791): Promise<number> {
    const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      const server = this.build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req as any, res, body);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      }
    };
    for (let port = preferredPort; port < preferredPort + 20; port++) {
      const ok = await new Promise<boolean>(resolve => {
        const srv = http.createServer((q, r) => { handler(q, r); });
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => { this.server = srv; resolve(true); });
      });
      if (ok) { this.port = port; return port; }
    }
    throw new Error('No free port for the Kinfile MCP server (tried 20 ports).');
  }

  stop(): void {
    this.server?.close();
  }
}
