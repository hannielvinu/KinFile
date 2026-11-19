// Minimal typed client for the TrueForge HTTP API (/api/v1).
// Kinfile never talks to a model provider: every model call goes through a TrueForge session.

export interface TfEvent {
  type: string;
  id?: string;
  thread_id?: string | null;
  [k: string]: any;
}

export interface AgentSpec {
  model: { name: string; params?: Record<string, unknown> };
  instructions?: string;
  mcp_servers?: Array<Record<string, unknown>>;
  skills?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
}

export class TrueForgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class TrueForgeClient {
  constructor(private baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get url(): string {
    return this.baseUrl;
  }

  private async req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e: any) {
      throw new TrueForgeError(`Cannot reach TrueForge at ${this.baseUrl} (${e?.cause?.code ?? e?.message ?? e}). Start it with: npx @truefoundry/trueforge@latest`);
    }
    const text = await res.text();
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
    if (!res.ok) {
      throw new TrueForgeError(json?.error?.message ?? `${method} ${path} failed (${res.status})`, res.status);
    }
    return json as T;
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try { await this.req('GET', '/capabilities', undefined, signal); return true; } catch { return false; }
  }

  async listModels(): Promise<string[]> {
    const r = await this.req<{ data: Array<{ name: string }> }>('GET', '/models');
    return r.data.map(m => m.name);
  }

  async upsertMcpServer(name: string, url: string, description: string): Promise<void> {
    await this.req('PUT', '/settings/mcp-servers', { manifest: { type: 'remote', name, url, description } });
  }

  async upsertAgent(name: string, description: string, manifest: AgentSpec): Promise<void> {
    const list = await this.req<{ data: Array<{ id: string; name: string }> }>('GET', '/agents');
    const existing = list.data.find(a => a.name === name);
    if (existing) await this.req('PUT', `/agents/${existing.id}`, { name, description, manifest });
    else await this.req('POST', '/agents', { name, description, manifest });
  }

  async createSession(spec: AgentSpec, metadata?: Record<string, string>): Promise<string> {
    const r = await this.req<{ data: { id: string } }>('POST', '/sessions', { agent: { spec }, ...(metadata ? { metadata } : {}) });
    return r.data.id;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.req('POST', `/sessions/${sessionId}/cancel`, {});
  }

  async sendApproval(sessionId: string, turnId: string, threadId: string, toolCallId: string, allow: boolean, reason?: string): Promise<void> {
    await this.req('POST', `/sessions/${sessionId}/turns/${turnId}/events`, {
      events: [{
        type: 'user.tool_approval',
        thread_id: threadId,
        tool_call_id: toolCallId,
        approval: allow ? { status: 'allow' } : { status: 'deny', ...(reason ? { reason } : {}) },
      }],
    });
  }

  /** POST a turn and yield its streamed events (SSE). */
  async *streamTurn(sessionId: string, message: string, signal?: AbortSignal): AsyncGenerator<TfEvent> {
    yield* this.sse(`/sessions/${sessionId}/turns`, 'POST', { input: [{ type: 'user.message', content: message }], stream: true }, signal);
  }

  /** Re-attach to a running turn (used after answering an approval). */
  async *subscribe(sessionId: string, turnId: string, afterEventId?: string, signal?: AbortSignal): AsyncGenerator<TfEvent> {
    const q = afterEventId ? `?after_event_id=${encodeURIComponent(afterEventId)}` : '';
    yield* this.sse(`/sessions/${sessionId}/turns/${turnId}/subscribe${q}`, 'GET', undefined, signal);
  }

  private async *sse(path: string, method: string, body: unknown, signal?: AbortSignal): AsyncGenerator<TfEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: { accept: 'text/event-stream', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e: any) {
      if (signal?.aborted) return;
      throw new TrueForgeError(`Cannot reach TrueForge at ${this.baseUrl} (${e?.cause?.code ?? e?.message ?? e}). Start it with: npx @truefoundry/trueforge@latest`);
    }
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      let msg = t;
      try { msg = JSON.parse(t)?.error?.message ?? t; } catch { /* keep text */ }
      throw new TrueForgeError(msg || `stream failed (${res.status})`, res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          try { yield JSON.parse(data) as TfEvent; } catch { /* ignore malformed keep-alive */ }
        }
      }
    } catch (e) {
      if (signal?.aborted) return;
      throw e;
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  }
}

/** True when a terminal turn error was caused by the model/provider (eligible for fallback). */
export function isModelFailure(message: string): boolean {
  return /model error|cannot connect|api key|unauthori[sz]ed|401|403|429|5\d\d|timed? ?out|ECONNREFUSED|ENOTFOUND|fetch failed|rate limit|overloaded|unavailable/i.test(message);
}
