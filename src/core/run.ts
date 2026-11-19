// One Kinfile run = one user request driven through TrueForge, with:
//  - streaming events forwarded to the UI,
//  - TrueForge tool approvals turned into hunk reviews / command approvals,
//  - Relay: retry with backoff, then automatic fallback to the next configured model,
//  - cancellation that leaves the workspace consistent (staged hunks are simply dropped).
import { AgentSpec, TfEvent, TrueForgeClient, isModelFailure } from './trueforge';
import { EditorHost, KinfileMcp, Proposal, ReviewOutcome, WRITE_TOOLS, buildProposal } from './mcpServer';
import { Workspace } from './context/workspace';

export type UiEvent =
  | { kind: 'status'; text: string }
  | { kind: 'model'; model: string; attempt: number }
  | { kind: 'session'; sessionId: string; url: string; model: string }
  | { kind: 'delta'; thread: string; text: string }
  | { kind: 'tool'; thread: string; id: string; name: string; args: string }
  | { kind: 'toolResult'; thread: string; id: string; text: string; isError?: boolean }
  | { kind: 'subagent'; thread: string; title: string; input: string; done?: boolean; state?: string }
  | { kind: 'compaction'; done: boolean }
  | { kind: 'relay'; text: string; level: 'info' | 'warn' | 'error' }
  | { kind: 'approval'; id: string; tool: string; summary: string; state: 'pending' | 'accepted' | 'rejected' | 'partial' }
  | { kind: 'done'; status: 'done' | 'cancelled' | 'error'; text?: string; model?: string };

export interface RunHooks {
  emit(e: UiEvent): void;
  review(p: Proposal): Promise<ReviewOutcome>;
  approveCommand(command: string): Promise<boolean>;
}

export interface RelayOptions {
  models: string[];
  retryBackoffMs?: number;
  firstEventTimeoutMs?: number;
  cooldownMs?: number;
}

const cooling = new Map<string, number>(); // model -> time it may be tried first again

export interface RunResult { status: 'done' | 'cancelled' | 'error'; text: string; model?: string; error?: string }

export class KinfileRun {
  private abort = new AbortController();
  private sessionId?: string;
  private cancelled = false;
  private sideEffects = false;
  private pendingReviews = new Set<string>();

  constructor(
    private tf: TrueForgeClient,
    private specFor: (model: string) => AgentSpec,
    private relay: RelayOptions,
    private hooks: RunHooks,
    private ctx?: { host: EditorHost; ws: Workspace; mcp: KinfileMcp },
  ) {}

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.abort.abort();
    if (this.sessionId) await this.tf.cancel(this.sessionId).catch(() => {});
  }

  private orderedModels(): string[] {
    const now = Date.now();
    const healthy = this.relay.models.filter(m => (cooling.get(m) ?? 0) <= now);
    const cold = this.relay.models.filter(m => (cooling.get(m) ?? 0) > now);
    return [...healthy, ...cold];
  }

  async start(message: string): Promise<RunResult> {
    const models = this.orderedModels();
    if (!models.length) {
      const r: RunResult = { status: 'error', text: '', error: 'No model configured. Add a model provider in TrueForge (http://localhost:8790) and set kinfile.models.' };
      this.hooks.emit({ kind: 'done', status: 'error', text: r.error });
      return r;
    }
    if (models[0] !== this.relay.models[0]) this.hooks.emit({ kind: 'relay', level: 'info', text: `${this.relay.models[0]} failed recently; starting on ${models[0]}.` });
    const errors: string[] = [];
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (this.cancelled) return this.finish({ status: 'cancelled', text: '' });
        this.hooks.emit({ kind: 'model', model, attempt });
        const r = await this.attempt(model, message);
        if (r.status !== 'error') return this.finish({ ...r, model });
        const failure = isModelFailure(r.error ?? '');
        if (!failure || this.sideEffects) {
          return this.finish({ ...r, model, error: r.error + (this.sideEffects ? ' (not retried: some changes were already applied)' : '') });
        }
        errors.push(`${model}: ${r.error}`);
        cooling.set(model, Date.now() + (this.relay.cooldownMs ?? 5 * 60_000));
        if (attempt === 1) {
          const wait = this.relay.retryBackoffMs ?? 1500;
          this.hooks.emit({ kind: 'relay', level: 'warn', text: `${model} failed: ${short(r.error)}. Retrying in ${(wait / 1000).toFixed(1)} s…` });
          await sleep(wait, this.abort.signal);
        }
      }
      const next = models[i + 1];
      if (next) this.hooks.emit({ kind: 'relay', level: 'warn', text: `${model} is unavailable. Switching automatically to ${next}. No files were changed.` });
    }
    return this.finish({ status: 'error', text: '', error: `All configured models failed. Workspace unchanged.\n${errors.map(short).join('\n')}` });
  }

  private finish(r: RunResult): RunResult {
    this.hooks.emit({ kind: 'done', status: r.status, text: r.status === 'error' ? r.error : undefined, model: r.model });
    return r;
  }

  private async attempt(model: string, message: string): Promise<{ status: 'done' | 'cancelled' | 'error'; text: string; error?: string }> {
    let sessionId: string;
    try {
      sessionId = await this.tf.createSession(this.specFor(model), { client: 'kinfile', model });
    } catch (e: any) {
      return { status: 'error', text: '', error: String(e?.message ?? e) };
    }
    this.sessionId = sessionId;
    this.hooks.emit({ kind: 'session', sessionId, url: `${this.tf.url}/sessions/${sessionId}`, model });

    const toolCalls = new Map<string, { name: string; args: string; thread: string }>();
    const partial = new Map<string, { id?: string; name: string; args: string }>(); // msgId:index -> call
    let mainText = '';
    let turnId: string | undefined;
    let lastId: string | undefined;
    let terminal: { status: 'done' | 'cancelled' | 'error'; message?: string } | undefined;
    let sawProgress = false;

    // Watchdog: a provider that hangs is treated like a failed one.
    const timeoutMs = this.relay.firstEventTimeoutMs ?? 45_000;
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      if (!sawProgress && !this.cancelled) { watchdogFired = true; this.tf.cancel(sessionId).catch(() => {}); }
    }, timeoutMs);

    const handle = async (e: TfEvent) => {
      if (e.id) lastId = e.id;
      const thread = (e.thread_id as string) ?? 'main';
      switch (e.type) {
        case 'turn.created': turnId = e.turn_id; break;
        case 'model.message.delta': {
          sawProgress = true;
          if (e.content) { if (thread === 'main') mainText += e.content; this.hooks.emit({ kind: 'delta', thread, text: e.content }); }
          for (const tc of (e.tool_calls ?? []) as any[]) {
            const k = `${e.id}:${tc.index ?? 0}`;
            const cur = partial.get(k) ?? { name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            partial.set(k, cur);
          }
          break;
        }
        case 'model.message': {
          for (const tc of (e.tool_calls ?? []) as any[]) {
            sawProgress = true;
            toolCalls.set(tc.id, { name: tc.tool_info?.name ?? tc.function?.name, args: tc.function?.arguments ?? '{}', thread });
          }
          if (Array.isArray(e.tool_calls) && e.tool_calls.length) {
            for (const tc of e.tool_calls) {
              const un = unwrapCall({ name: tc.function?.name ?? tc.tool_info?.name ?? '', args: tc.function?.arguments ?? '{}' });
              this.hooks.emit({ kind: 'tool', thread, id: tc.id, name: un.name, args: JSON.stringify(un.args) });
            }
          }
          break;
        }
        case 'tool.response': {
          const tc = toolCalls.get(e.tool_call_id);
          const un = unwrapCall(tc);
          if (tc && (WRITE_TOOLS.includes(un.name) || un.name === 'run_command') && !/^\s*(error|the user rejected)/i.test(e.content ?? '')) this.sideEffects = true;
          this.hooks.emit({ kind: 'toolResult', thread, id: e.tool_call_id, text: String(e.content ?? '').slice(0, 1500) });
          break;
        }
        case 'thread.created':
          this.hooks.emit({ kind: 'subagent', thread: String(e.thread_id), title: e.title ?? e.agent_info?.name ?? 'subagent', input: e.agent_info?.input ?? '' });
          break;
        case 'thread.done':
          this.hooks.emit({ kind: 'subagent', thread: String(e.thread_id), title: e.title ?? 'subagent', input: '', done: true, state: e.state?.status });
          break;
        case 'thread.context_compaction.started': this.hooks.emit({ kind: 'compaction', done: false }); break;
        case 'thread.context_compaction.finished': this.hooks.emit({ kind: 'compaction', done: true }); break;
        case 'tool.approval_required': {
          sawProgress = true;
          for (const [, c] of partial) if (c.id && !toolCalls.has(c.id)) toolCalls.set(c.id, { name: c.name, args: c.args, thread });
          for (const ref of e.tool_calls as Array<{ id: string }>) {
            if (this.cancelled) return;
            await this.answerApproval(sessionId, turnId!, thread, ref.id, toolCalls.get(ref.id));
          }
          break;
        }
        case 'turn.done':
          terminal = { status: e.state?.status, message: e.state?.message };
          if (e.state?.status === 'done' && !mainText && typeof e.state?.output?.content === 'string') mainText = e.state.output.content;
          break;
        default:
          if (String(e.type).includes('compaction')) this.hooks.emit({ kind: 'compaction', done: String(e.type).includes('finish') });
      }
    };

    try {
      for await (const e of this.tf.streamTurn(sessionId, message, this.abort.signal)) {
        await handle(e);
        if (terminal) break;
      }
      // After a pause for approval the stream may close; re-attach until the turn is terminal.
      let reattach = 0;
      while (!terminal && !this.cancelled && turnId && reattach < 200) {
        reattach++;
        let got = false;
        for await (const e of this.tf.subscribe(sessionId, turnId, lastId, this.abort.signal)) {
          got = true;
          await handle(e);
          if (terminal) break;
        }
        if (!got) await sleep(300, this.abort.signal);
      }
    } catch (e: any) {
      clearTimeout(watchdog);
      if (this.cancelled) return { status: 'cancelled', text: mainText };
      return { status: 'error', text: mainText, error: String(e?.message ?? e) };
    }
    clearTimeout(watchdog);
    if (this.cancelled) return { status: 'cancelled', text: mainText };
    if (watchdogFired) return { status: 'error', text: '', error: `Model timed out: no response within ${Math.round(timeoutMs / 1000)} s` };
    if (!terminal) return { status: 'error', text: mainText, error: 'Stream ended without a result' };
    if (terminal.status === 'error') return { status: 'error', text: mainText, error: terminal.message ?? 'Unknown model error' };
    return { status: terminal.status, text: mainText };
  }

  private async answerApproval(sessionId: string, turnId: string, thread: string, toolCallId: string, call?: { name: string; args: string }) {
    let { name, args } = unwrapCall(call);
    const send = (allow: boolean, reason?: string) => this.tf.sendApproval(sessionId, turnId, thread, toolCallId, allow, reason).catch(e => this.hooks.emit({ kind: 'relay', level: 'error', text: `Approval failed: ${e?.message ?? e}` }));

    if (WRITE_TOOLS.includes(name) && this.ctx) {
      let p: Proposal;
      try {
        p = await buildProposal(this.ctx.host, this.ctx.ws, name, args);
      } catch (err: any) {
        // Invalid edit (e.g. old_string not found): deny with the reason so the model can correct itself.
        this.hooks.emit({ kind: 'approval', id: toolCallId, tool: name, summary: `${args.path ?? ''}: ${err?.message ?? err}`, state: 'rejected' });
        await send(false, String(err?.message ?? err));
        return;
      }
      this.hooks.emit({ kind: 'approval', id: toolCallId, tool: name, summary: `${p.isNew ? 'Create' : 'Edit'} ${p.path}${p.explanation ? ': ' + p.explanation : ''}`, state: 'pending' });
      this.pendingReviews.add(toolCallId);
      const outcome = await this.hooks.review(p);
      this.pendingReviews.delete(toolCallId);
      if (this.cancelled) return;
      this.ctx.mcp.outcomes.set(p.key, outcome);
      if (outcome.accepted > 0) this.sideEffects = true;
      const state = outcome.accepted === 0 ? 'rejected' : outcome.rejected ? 'partial' : 'accepted';
      this.hooks.emit({ kind: 'approval', id: toolCallId, tool: name, summary: `${p.path}: ${outcome.accepted} hunk(s) accepted, ${outcome.rejected} rejected`, state });
      // Allow even when every hunk was rejected so the tool can report the rejection to the agent.
      await send(true);
      return;
    }
    if (name === 'run_command') {
      this.hooks.emit({ kind: 'approval', id: toolCallId, tool: name, summary: String(args.command ?? ''), state: 'pending' });
      const ok = await this.hooks.approveCommand(String(args.command ?? ''));
      if (this.cancelled) return;
      this.hooks.emit({ kind: 'approval', id: toolCallId, tool: name, summary: String(args.command ?? ''), state: ok ? 'accepted' : 'rejected' });
      await send(ok, ok ? undefined : 'The user declined to run this command.');
      return;
    }
    await send(true);
  }
}

/** Deferred MCP tools are invoked through TrueForge's call_tool({mcp_server, tool_name, input}). */
export function unwrapCall(call?: { name: string; args: string }): { name: string; args: any } {
  let args: any = {};
  try { args = JSON.parse(call?.args || '{}'); } catch { /* keep empty */ }
  const name = baseName(call?.name ?? '');
  if (name === 'call_tool' && args && typeof args.tool_name === 'string') {
    return { name: baseName(args.tool_name), args: args.input ?? {} };
  }
  return { name, args };
}

export function baseName(toolName: string): string {
  // TrueForge may namespace MCP tools (e.g. "kinfile-editor__read_file").
  const m = toolName.match(/([a-z_]+)$/);
  return m ? m[1] : toolName;
}

function short(s?: string): string {
  return (s ?? '').replace(/\s+/g, ' ').slice(0, 160);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
