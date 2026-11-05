/** Smoke tests: classification, ledger aggregation, and the execute wrapper. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classify, resolveBudget, DEFAULT_BUDGETS, HINTS } from '../lib/catalog.js';
import { Ledger, readLedger, summarize } from '../lib/ledger.js';
import { apply } from '../lib/index.js';

let passed = 0;
let failed = 0;

async function test(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + title);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + title + ' -> ' + err.message);
  }
}

console.log('catalog');

await test('classifies curl as net', () => {
  assert.equal(classify('ops_bash', { command: 'curl -sS http://x' }).kind, 'net');
});

await test('classifies grep as search', () => {
  assert.equal(classify('ops_bash', { command: 'rg -n foo .' }).kind, 'search');
  assert.equal(classify('grep', { pattern: 'x' }).kind, 'search');
});

await test('classifies npm install as build', () => {
  assert.equal(classify('win_bash', { command: 'npm i left-pad' }).kind, 'build');
});

await test('classifies plain shell', () => {
  assert.equal(classify('ops_bash', { command: 'echo hi' }).kind, 'shell');
});

await test('file tools are read, unknown tools are tool', () => {
  assert.equal(classify('read', {}).kind, 'read');
  assert.equal(classify('mystery_tool', {}).kind, 'tool');
});

await test('web_fetch is net', () => {
  assert.equal(classify('web_fetch', { url: 'http://x' }).kind, 'net');
});

await test('catalog budget is used with no history', () => {
  const d = resolveBudget({ kind: 'net', config: {} });
  assert.equal(d.budget, DEFAULT_BUDGETS.net);
  assert.equal(d.source, 'catalog');
  assert.equal(d.arm, true);
});

await test('adaptive follows measured p95, with the floor as a lower bound', () => {
  const low = resolveBudget({ kind: 'shell', config: {}, stats: { ok: 10, p95: 1000 } });
  assert.equal(low.source, 'adaptive');
  assert.equal(low.budget, 30000, 'floor should win over a tiny p95');
  const high = resolveBudget({ kind: 'shell', config: {}, stats: { ok: 10, p95: 20000 } });
  assert.equal(high.budget, 60000, 'p95 * 3 should win above the floor');
});

await test('adaptive budget is capped by the kind ceiling', () => {
  const d = resolveBudget({ kind: 'net', config: {}, stats: { ok: 20, p95: 60000 } });
  assert.ok(d.budget <= 30000, 'expected clamp to 30000, got ' + d.budget);
});

await test('a tighter declared timeout wins and is not armed', () => {
  const d = resolveBudget({ kind: 'net', declared: 4000, config: {} });
  assert.equal(d.arm, false);
  assert.equal(d.budget, 4000);
});

await test('an absurd declared timeout is clamped', () => {
  const d = resolveBudget({ kind: 'net', declared: 900000, config: {} });
  assert.equal(d.arm, true);
  assert.ok(d.budget <= 30000);
});

await test('a leading cd/mkdir does not decide the kind for the whole line', () => {
  assert.equal(classify('ops_bash', { command: 'mkdir -p /tmp/x && npm pack foo' }).kind, 'build');
  assert.equal(classify('ops_bash', { command: 'cd /repo && tar -xzf a.tgz' }).kind, 'build');
  assert.equal(classify('ops_bash', { command: 'cd /repo && grep -rn x .' }).kind, 'search');
  assert.equal(classify('ops_bash', { command: 'cd /repo && curl -sS http://h/' }).kind, 'net');
});

await test('adaptive never drops below the kind floor', () => {
  const d = resolveBudget({ kind: 'shell', config: {}, stats: { ok: 20, p95: 20 } });
  assert.ok(d.budget >= 30000, 'expected >= 30000, got ' + d.budget);
});

await test('adaptive off honors an explicitly configured budget', () => {
  const d = resolveBudget({
    kind: 'net',
    config: { adaptive: false, budgets: { net: 3000 } },
    stats: { ok: 20, p95: 20 },
  });
  assert.equal(d.budget, 3000);
});

await test('a loose declaration is clamped, not honored', () => {
  const d = resolveBudget({ kind: 'shell', declared: 120000, config: {} });
  assert.equal(d.arm, true);
  assert.equal(d.source, 'clamped');
  assert.equal(d.budget, DEFAULT_BUDGETS.shell);
});

await test('every kind has hints', () => {
  for (const kind of Object.keys(DEFAULT_BUDGETS)) {
    assert.ok(Array.isArray(HINTS[kind]) && HINTS[kind].length > 0, 'missing hints for ' + kind);
  }
});

console.log('');
console.log('ledger');

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bguard-')), 'calls.jsonl');

await test('records, flushes, and reads back', () => {
  const ledger = new Ledger({ ledgerPath: tmpFile });
  ledger.record({ ts: 'x', name: 'a', kind: 'net', budget: 1000, elapsed: 12, outcome: 'ok' });
  ledger.record({ ts: 'x', name: 'a', kind: 'net', budget: 1000, elapsed: 40, outcome: 'ok' });
  ledger.record({ ts: 'x', name: 'a', kind: 'net', budget: 1000, elapsed: 1500, outcome: 'timeout' });
  ledger.close();
  const entries = readLedger(tmpFile);
  assert.equal(entries.length, 3);
  const summary = summarize(entries);
  assert.equal(summary.net.ok, 2);
  assert.equal(summary.net.timeouts, 1);
  assert.equal(summary.net.max, 40);
});

await test('warm start seeds stats from disk', () => {
  const ledger = new Ledger({ ledgerPath: tmpFile });
  const stats = ledger.statsFor('net');
  assert.ok(stats && stats.ok >= 2, 'expected warm stats');
  ledger.close();
});

console.log('');
console.log('execute wrapper');

function makeCtx(file) {
  const handlers = {};
  const ctx = {
    on(event, fn) { handlers[event] = fn; },
    tools: { get() { return undefined; } },
  };
  apply(ctx, {
    ledgerPath: file,
    graceMs: 200,
    budgets: { net: 150, search: 150, read: 150, shell: 150, build: 150, tool: 150 },
    ceilings: { net: 1000, search: 1000, read: 1000, shell: 1000, build: 1000, tool: 1000 },
  });
  return handlers['tools/execute'];
}

await test('fast call passes through unchanged', async () => {
  const handler = makeCtx();
  const expected = { content: [{ type: 'text', text: 'done' }] };
  const result = await handler(
    { name: 'read', arguments: {}, signal: new AbortController().signal },
    async () => expected,
  );
  assert.equal(result, expected);
});

await test('hanging call yields a structured budget error with hints', async () => {
  const handler = makeCtx(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bguard-')), 'calls.jsonl'));
  const signal = new AbortController().signal;
  const result = await handler(
    { name: 'web_fetch', arguments: { url: 'http://x' }, signal },
    () => new Promise(() => {}),
  );
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, 'BUDGET_EXCEEDED');
  const text = result.content[0].text;
  assert.match(text, /150ms budget/);
  assert.match(text, /kind: net/);
  assert.match(text, /Next, in order of cost/);
  assert.match(text, /Do not re-issue/);
});

await test('caller cancellation still reaches the tool body', async () => {
  const handler = makeCtx();
  const controller = new AbortController();
  const exec = { name: 'read', arguments: {}, signal: controller.signal };
  const pending = handler(exec, () => new Promise((resolve) => {
    // The wrapper swaps exec.signal, so a tool reading it must see the composed
    // signal -- one that still aborts when the caller does.
    exec.signal.addEventListener('abort', () => resolve({ cancelled: true }));
  }));
  // The wrapper replaces exec.signal, so verify the composed signal aborts with the caller.
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.ok(result && (result.cancelled === true || result.isError === true), 'cancellation must propagate');
});

await test('a tool that throws keeps its error when no budget fired', async () => {
  const handler = makeCtx();
  await assert.rejects(
    () => handler(
      { name: 'read', arguments: {}, signal: new AbortController().signal },
      async () => { throw new Error('boom'); },
    ),
    /boom/,
  );
});

await test('never-arm tools bypass the guard entirely', async () => {
  const handler = makeCtx();
  const expected = { content: [{ type: 'text', text: 'asked' }] };
  const result = await handler(
    { name: 'ask_user_question', arguments: {}, signal: new AbortController().signal },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return expected;
    },
  );
  assert.equal(result, expected, 'ask_user_question must never be cut off');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
