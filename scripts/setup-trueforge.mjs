// Load model providers and the Kinfile agent definition into a running TrueForge.
//   cp config/trueforge.example.json config/trueforge.local.json   # add your keys (git-ignored)
//   npm run setup
// Task C helpers:  npm run setup -- --break-primary   (puts an invalid key on the primary provider)
//                  npm run setup                      (restores the real keys)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfgPath = path.join(root, 'config', fs.existsSync(path.join(root, 'config', 'trueforge.local.json')) ? 'trueforge.local.json' : 'trueforge.example.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const base = (process.env.TRUEFORGE_URL ?? cfg.trueforgeUrl ?? 'http://localhost:8790').replace(/\/+$/, '');
const breakPrimary = process.argv.includes('--break-primary');

async function call(method, p, body) {
  const r = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : {};
}

try { await call('GET', '/capabilities'); }
catch { console.error(`TrueForge is not reachable at ${base}. Start it first: npm run trueforge`); process.exit(1); }

if (cfgPath.endsWith('example.json')) console.warn('Using config/trueforge.example.json (no real keys). Copy it to config/trueforge.local.json and add your keys.');

for (const [i, manifest] of cfg.providers.entries()) {
  const m = structuredClone(manifest);
  if (m.auth?.api_key?.startsWith('$')) m.auth.api_key = process.env[m.auth.api_key.slice(1)] ?? '';
  if (breakPrimary && i === 0) m.auth = { api_key: 'invalid-key-for-task-c' };
  if (!m.auth?.api_key) delete m.auth;
  await call('PUT', '/settings/model-providers', { manifest: m });
  console.log(`provider ${m.name ?? m.type}: ${m.models.map(x => x.name).join(', ')}${breakPrimary && i === 0 ? '  <-- key deliberately invalid (Task C)' : ''}`);
}

const models = (await call('GET', '/models')).data.map(m => m.name);
console.log('TrueForge models:', models.join(', '));

const agent = JSON.parse(fs.readFileSync(path.join(root, 'agent', 'kinfile.agent.json'), 'utf8'));
agent.manifest.model.name = cfg.models?.[0] ?? models[0] ?? agent.manifest.model.name;
const list = (await call('GET', '/agents')).data;
const existing = list.find(a => a.name === agent.name);
if (existing) await call('PUT', `/agents/${existing.id}`, agent); else await call('POST', '/agents', agent);
console.log(`agent "${agent.name}" loaded (model ${agent.manifest.model.name}).`);
console.log(`\nIn VS Code settings set:  "kinfile.models": ${JSON.stringify(cfg.models ?? models)}`);
