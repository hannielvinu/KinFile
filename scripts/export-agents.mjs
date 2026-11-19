// Regenerate agent/*.json from src/core/agentSpec.ts so the repo holds exactly what the extension runs.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { agentSpec, inlineSpec } = require('../out/src/core/agentSpec.js');
const model = 'google-gemini/gemini-3-5-flash';
fs.writeFileSync('agent/kinfile.agent.json', JSON.stringify({ name: 'kinfile', description: 'Kinfile agent mode: multi-file changes with editor MCP tools, scout subagent, deferred tools, compaction and approval-driven hunk review.', manifest: agentSpec({ model }) }, null, 2) + '\n');
fs.writeFileSync('agent/kinfile-inline.agent.json', JSON.stringify({ name: 'kinfile-inline', description: 'Kinfile inline edit: rewrite the selected region; no tools.', manifest: inlineSpec(model) }, null, 2) + '\n');
console.log('wrote agent/kinfile.agent.json and agent/kinfile-inline.agent.json (model is replaced at runtime by kinfile.models)');
