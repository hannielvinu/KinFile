import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { acceptHunk, applyReplace, computeHunks, extractReplacement, matchIndent, rejectHunk } from '../src/core/stage';

const base = 'a\nb\nc\nd\ne\n';
const prop = 'a\nB\nc\nd\nE\nf\n';

test('computeHunks finds separate hunks', () => {
  const h = computeHunks(base, prop);
  assert.equal(h.length, 2);
  assert.deepEqual(h[0].removed, ['b\n']);
  assert.deepEqual(h[0].added, ['B\n']);
});

test('accepting every hunk yields the proposal; rejecting every hunk yields the original', () => {
  let cur = base;
  for (const h of [...computeHunks(base, prop)].reverse()) cur = acceptHunk(cur, h);
  assert.equal(cur, prop);
  let p = prop;
  for (const h of [...computeHunks(base, prop)].reverse()) p = rejectHunk(p, h);
  assert.equal(p, base);
});

test('accept one hunk, reject the other', () => {
  const hs = computeHunks(base, prop);
  const cur = acceptHunk(base, hs[0]);
  const left = computeHunks(cur, prop);
  assert.equal(left.length, 1);
  const p2 = rejectHunk(prop, left[0]);
  assert.equal(computeHunks(cur, p2).length, 0);
  assert.equal(cur, 'a\nB\nc\nd\ne\n');
});

test('applyReplace: exact, ambiguous, tolerant, missing', () => {
  assert.equal(applyReplace('x = 1\ny = 2\n', 'y = 2', 'y = 3'), 'x = 1\ny = 3\n');
  assert.throws(() => applyReplace('a\na\n', 'a', 'b'), /occurs 2 times/);
  assert.equal(applyReplace('def f():   \n    return 1\n', 'def f():\n    return 1', 'def f():\n    return 2'), 'def f():\n    return 2\n');
  assert.throws(() => applyReplace('abc', 'zzz', 'y'), /not found/);
});

test('extractReplacement and matchIndent', () => {
  assert.equal(extractReplacement('Sure:\n```python\ndef f():\n    pass\n```\n'), 'def f():\n    pass\n');
  assert.equal(matchIndent('    x = 1', 'x = 2\ny = 3'), '    x = 2\n    y = 3');
});
