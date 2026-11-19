import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { Workspace } from '../src/core/context/workspace';
import { SymbolIndex } from '../src/core/context/symbols';
import { CoChangeIndex } from '../src/core/context/git';
import { ContextEngine, extractTerms } from '../src/core/context/retrieve';

test('extractTerms drops stop words and splits identifiers', () => {
  const t = extractTerms('Add a new CLI command get_debug_flag to the app');
  assert.ok(t.includes('cli') && t.includes('command') && t.includes('debug'));
  assert.ok(!t.includes('the') && !t.includes('add'));
});

test('co-change pulls in the test and docs that historically change with the anchor file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinfile-'));
  const sh = (c: string) => execSync(c, { cwd: dir, stdio: 'pipe' });
  sh('git init -q && git config user.email t@t && git config user.name t');
  const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  write('src/cli.py', 'def routes_command():\n    pass\n');
  write('tests/test_cli.py', 'def test_routes():\n    pass\n');
  write('docs/usage.rst', 'Usage\n=====\n');
  write('src/other.py', 'def unrelated():\n    pass\n');
  sh('git add -A && git commit -qm init');
  for (let i = 0; i < 4; i++) {
    fs.appendFileSync(path.join(dir, 'src/cli.py'), `# ${i}\n`);
    fs.appendFileSync(path.join(dir, 'tests/test_cli.py'), `# ${i}\n`);
    fs.appendFileSync(path.join(dir, 'docs/usage.rst'), `${i}\n`);
    sh(`git add -A && git commit -qm c${i}`);
  }
  const ws = new Workspace(dir); await ws.init();
  const sy = new SymbolIndex(dir); await sy.build(ws.files);
  const kin = new CoChangeIndex(dir); await kin.build();
  const pack = new ContextEngine(ws, sy, kin).assemble('add a new cli command next to routes', { budgetTokens: 4000 });
  const files = pack.receipt.entries.map(e => e.file);
  assert.equal(files[0], 'src/cli.py');
  assert.ok(files.includes('docs/usage.rst'), 'docs found through co-change: ' + files.join(','));
  const docs = pack.receipt.entries.find(e => e.file === 'docs/usage.rst')!;
  assert.ok(docs.reasons.some(r => /changed together with src\/cli.py/.test(r)));
  assert.ok(pack.receipt.used <= pack.receipt.budget);
});
