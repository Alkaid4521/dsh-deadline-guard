#!/usr/bin/env node
/**
 * dsh-budget-guard CLI.
 *
 *   report                 what actually happened, per kind, with the budget this
 *                          plugin would pick next time
 *   explain <tool> [--cmd] why a given call gets the budget it gets, without
 *                          dispatching anything
 *   path                   where the ledger lives
 *   reset                  truncate the ledger
 *
 * @module dsh-budget-guard/bin
 */

import fs from 'node:fs';
import { classify, resolveBudget, DEFAULT_BUDGETS } from '../lib/catalog.js';
import { ledgerPath, readLedger, summarize } from '../lib/ledger.js';

const argv = process.argv.slice(2);
const command = argv[0] || 'report';

let flags = {};
let positional = [];
for (let i = 1; i < argv.length; i += 1) {
  const token = argv[i];
  if (token === '--json') flags.json = true;
  else if (token === '--cmd' || token === '--kind' || token === '--tool') {
    flags[token.slice(2)] = argv[i + 1];
    i += 1;
  } else if (token.startsWith('--')) {
    flags[token.slice(2)] = true;
  } else {
    positional.push(token);
  }
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function ms(value) {
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 's';
  return String(value) + 'ms';
}

function commandReport() {
  const file = ledgerPath({});
  if (!fs.existsSync(file)) {
    console.log('No ledger yet at ' + file);
    console.log('Run a few tool calls with the plugin loaded, then come back.');
    return;
  }
  const entries = readLedger(file);
  if (entries.length === 0) {
    console.log('Ledger is empty: ' + file);
    return;
  }
  const summary = summarize(entries);
  if (flags.json) {
    console.log(JSON.stringify({ file, entries: entries.length, kinds: summary }, null, 2));
    return;
  }

  const kinds = Object.keys(summary).sort();
  console.log('ledger: ' + file);
  console.log('calls:  ' + entries.length);
  console.log('');
  console.log(pad('kind', 8) + pad('ok', 6) + pad('err', 6) + pad('timeout', 9) + pad('p50', 8) + pad('p95', 8) + pad('max', 8) + 'next budget');
  console.log('-'.repeat(74));
  for (const kind of kinds) {
    const row = summary[kind];
    const decision = resolveBudget({
      kind,
      declared: undefined,
      config: {},
      stats: row.samples >= 5 ? row : undefined,
    });
    console.log(
      pad(kind, 8) +
      pad(row.ok, 6) +
      pad(row.failed, 6) +
      pad(row.timeouts, 9) +
      pad(ms(row.p50), 8) +
      pad(ms(row.p95), 8) +
      pad(ms(row.max), 8) +
      ms(decision.budget) + ' (' + decision.source + ')',
    );
  }
  console.log('');
  const worst = kinds
    .map((kind) => ({ kind, row: summary[kind] }))
    .filter((item) => item.row.timeouts > 0)
    .sort((a, b) => b.row.timeouts - a.row.timeouts);
  if (worst.length === 0) {
    console.log('No timeouts recorded. Budgets are holding.');
  } else {
    console.log('Timeouts by kind (each one is a retry you did not need to pay for):');
    for (const item of worst) console.log('  ' + item.kind + ': ' + item.row.timeouts);
  }
}

function explain() {
  const toolName = flags.tool || positional[0] || 'ops_bash';
  const args = flags.cmd ? { command: flags.cmd } : {};
  const { kind, evidence } = classify(toolName, args);
  const file = ledgerPath({});
  let stats;
  if (fs.existsSync(file)) {
    try {
      stats = summarize(readLedger(file))[kind];
    } catch {
      stats = undefined;
    }
  }
  const decision = resolveBudget({
    kind,
    declared: undefined,
    config: {},
    stats: stats && stats.samples >= 5 ? stats : undefined,
  });
  const output = {
    tool: toolName,
    evidence,
    kind,
    catalogBudget: DEFAULT_BUDGETS[kind],
    measured: stats || null,
    decision,
  };
  if (flags.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log('tool:      ' + toolName);
  console.log('evidence:  ' + evidence);
  console.log('kind:      ' + kind);
  console.log('budget:    ' + ms(decision.budget) + ' (' + decision.source + ')');
  if (stats && stats.samples > 0) {
    console.log('measured:  p50=' + ms(stats.p50) + ' p95=' + ms(stats.p95) + ' max=' + ms(stats.max) + ' n=' + stats.samples);
  } else {
    console.log('measured:  none yet (needs 5 ok calls before the adaptive budget kicks in)');
  }
}

function printPath() {
  console.log(ledgerPath({}));
}

function reset() {
  const file = ledgerPath({});
  if (!fs.existsSync(file)) {
    console.log('Nothing to reset: ' + file);
    return;
  }
  fs.truncateSync(file, 0);
  console.log('Truncated ' + file);
}

switch (command) {
  case 'report':
    commandReport();
    break;
  case 'explain':
    explain();
    break;
  case 'path':
    printPath();
    break;
  case 'reset':
    reset();
    break;
  default:
    console.log('usage: dsh-budget-guard <report|explain|path|reset> [--tool NAME] [--cmd STRING] [--json]');
    process.exitCode = 1;
}
