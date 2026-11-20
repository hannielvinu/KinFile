// Local model relay for OpenAI-compatible providers.
//
// Why: Gemini 3 models require the "thought signature" returned with each tool call to be sent back on
// the next request. TrueForge's OpenAI-compatible provider does not keep that field, so a multi-step
// tool loop fails with "Function call is missing a thought_signature". This relay remembers the
// signatures from streamed responses (by tool-call id) and adds them back to the conversation it
// forwards. Everything else passes through unchanged, including the Authorization header TrueForge sends.
//
//   node scripts/model-relay.mjs            (listens on 127.0.0.1:8792)
//   TrueForge provider base_url: http://127.0.0.1:8792/gemini/v1beta/openai   (Gemini)
//                                http://127.0.0.1:8792/groq/openai/v1         (Groq, optional)
//
// Start TrueForge with `npm run trueforge` so it may call 127.0.0.1.
import http from 'node:http';

const PORT = Number(process.env.KINFILE_RELAY_PORT ?? 8792);
const UPSTREAMS = {
  gemini: 'https://generativelanguage.googleapis.com',
  groq: 'https://api.groq.com',
  openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai',
  nvidia: 'https://integrate.api.nvidia.com',
};
const signatures = new Map(); // tool_call id -> thought_signature
let requestCount = 0;
const usageTotals = { input: 0, output: 0 };
const FALLBACK_SIGNATURE = 'skip_thought_signature_validator'; // documented by Google for calls without a stored signature

function restoreSignatures(body) {
  if (!Array.isArray(body?.messages)) return body;
  for (const m of body.messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    m.tool_calls.forEach((tc, i) => {
      if (tc.extra_content?.google?.thought_signature) return;
      const sig = signatures.get(tc.id) ?? (i === 0 ? FALLBACK_SIGNATURE : undefined);
      if (sig) tc.extra_content = { ...(tc.extra_content ?? {}), google: { ...(tc.extra_content?.google ?? {}), thought_signature: sig } };
    });
  }
  return body;
}

function countUsage(obj) {
  const u = obj?.usage;
  if (!u) return;
  usageTotals.input += u.prompt_tokens ?? 0;
  usageTotals.output += u.completion_tokens ?? 0;
  console.log(`  usage: +${u.prompt_tokens ?? 0} in / +${u.completion_tokens ?? 0} out (total ${usageTotals.input} in / ${usageTotals.output} out)`);
}

function remember(obj) {
  for (const ch of obj?.choices ?? []) {
    const calls = [...(ch.delta?.tool_calls ?? []), ...(ch.message?.tool_calls ?? [])];
    for (const tc of calls) {
      const sig = tc?.extra_content?.google?.thought_signature;
      if (tc?.id && sig) signatures.set(tc.id, sig);
    }
  }
  if (signatures.size > 5000) signatures.delete(signatures.keys().next().value);
}

http.createServer(async (req, res) => {
  const [, name, ...rest] = (req.url ?? '').split('/');
  const base = UPSTREAMS[name];
  if (!base) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"unknown upstream"}}'); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = chunks.length ? Buffer.concat(chunks) : undefined;
  if (body && name === 'gemini' && (req.headers['content-type'] ?? '').includes('json')) {
    try { body = Buffer.from(JSON.stringify(restoreSignatures(JSON.parse(body.toString('utf8'))))); } catch { /* forward as is */ }
  }
  let modelName = '';
  try { modelName = body ? JSON.parse(body.toString('utf8')).model ?? '' : ''; } catch { /* not JSON */ }
  if (modelName) console.log(`request #${++requestCount} ${name} ${modelName}`);
  const headers = {};
  for (const h of ['authorization', 'content-type', 'accept', 'x-goog-api-key']) if (req.headers[h]) headers[h] = req.headers[h];
  try {
    // Free tiers throttle hard: wait and retry 429/503 a few times instead of failing the agent turn.
    let up;
    for (let attempt = 0; ; attempt++) {
      up = await fetch(`${base}/${rest.join('/')}`, { method: req.method, headers, body });
      if (![429, 503].includes(up.status) || attempt >= 2) break;
      const text = await up.text();
      const m = text.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
      const waitS = Math.min(60, m ? Number(m[1]) + 1 : 8 * (attempt + 1));
      if (/per ?day|PerDay/i.test(text)) { res.writeHead(up.status, { 'content-type': 'application/json' }).end(text); return; }
      console.log(`${name}: ${up.status}, retrying in ${waitS}s`);
      await new Promise(r => setTimeout(r, waitS * 1000));
    }
    if (up.status >= 400) {
      const text = await up.text();
      console.log(`  -> ${up.status} ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' }).end(text);
      return;
    }
    console.log(`  -> ${up.status}`);
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
    if (!up.body) { res.end(); return; }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const c of up.body) {
      res.write(c);
      buf += decoder.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const data = line.startsWith('data:') ? line.slice(5).trim() : line.startsWith('{') ? line : '';
        if (data && data !== '[DONE]') { try { const o = JSON.parse(data); countUsage(o); if (name === 'gemini') remember(o); } catch { /* partial JSON body */ } }
      }
    }
    if (buf.trim().startsWith('{')) { try { const o = JSON.parse(buf); countUsage(o); if (name === 'gemini') remember(o); } catch { /* ignore */ } }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `relay: ${e?.message ?? e}` } }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Kinfile model relay on http://127.0.0.1:${PORT} (${Object.keys(UPSTREAMS).join(', ')})`));
