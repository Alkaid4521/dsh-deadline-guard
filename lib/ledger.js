/**
 * Measured latency ledger: the part that turns "what budget should I use" from a
 * guess into arithmetic. One JSONL line per tool call, plus in-memory per-kind
 * aggregates that the resolver reads before every dispatch.
 *
 * @module dsh-deadline-guard/ledger
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Turns kept per kind in memory; enough for a stable p95, small enough to be free. */
const WINDOW = 200;

/** Lines read back at startup so a fresh process still knows yesterday's timings. */
const WARM_LINES = 400;

/** Resolve the DSH home the same way the harness does. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), '.dsh');
}

/** Default JSONL location; overridable for tests. */
export function ledgerPath(config = {}) {
  if (config.ledgerPath) return config.ledgerPath;
  if (process.env.DSH_DEADLINE_GUARD_LEDGER) return process.env.DSH_DEADLINE_GUARD_LEDGER;
  return path.join(dshHome(), 'deadline-guard', 'calls.jsonl');
}

/** Nearest-rank percentile over an unordered sample. */
export function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

/** One kind's rolling aggregate. */
class KindStats {
  constructor() {
    this.ok = 0;
    this.failed = 0;
    this.timeouts = 0;
    this.samples = [];
    this.max = 0;
  }

  push(elapsed, outcome) {
    if (outcome === 'timeout') this.timeouts += 1;
    else if (outcome === 'ok') this.ok += 1;
    else this.failed += 1;
    if (outcome === 'ok') {
      this.samples.push(elapsed);
      if (this.samples.length > WINDOW) this.samples.shift();
      if (elapsed > this.max) this.max = elapsed;
    }
  }

  summary() {
    return {
      ok: this.ok,
      failed: this.failed,
      timeouts: this.timeouts,
      samples: this.samples.length,
      p50: Math.round(percentile(this.samples, 50)),
      p95: Math.round(percentile(this.samples, 95)),
      max: Math.round(this.max),
    };
  }
}

/** Buffered JSONL writer with per-kind aggregates. Never throws into a tool call. */
export class Ledger {
  constructor(config = {}) {
    this.enabled = config.ledger !== false;
    this.path = ledgerPath(config);
    this.kinds = new Map();
    this.pending = [];
    this.timer = null;
    this.closed = false;
    if (this.enabled) this.warm();
  }

  statsFor(kind) {
    const bucket = this.kinds.get(kind);
    return bucket ? bucket.summary() : undefined;
  }

  all() {
    const out = {};
    for (const [kind, bucket] of this.kinds) out[kind] = bucket.summary();
    return out;
  }

  record(entry) {
    try {
      const bucket = this.kinds.get(entry.kind) || new KindStats();
      bucket.push(entry.elapsed, entry.outcome);
      this.kinds.set(entry.kind, bucket);
      if (!this.enabled || this.closed) return;
      this.pending.push(JSON.stringify(entry));
      this.schedule();
    } catch {
      // A ledger problem must never surface as a tool failure.
    }
  }

  schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  flush() {
    if (this.pending.length === 0) return;
    const chunk = this.pending.join('\n') + '\n';
    this.pending = [];
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.appendFileSync(this.path, chunk, 'utf8');
    } catch {
      // Losing telemetry is acceptable; breaking the call is not.
    }
  }

  /** Replay the tail of an existing ledger so budgets survive a restart. */
  warm() {
    try {
      if (!fs.existsSync(this.path)) return;
      const size = fs.statSync(this.path).size;
      if (size > 8 * 1024 * 1024) return;
      const text = fs.readFileSync(this.path, 'utf8');
      const lines = text.split('\n').filter(Boolean).slice(-WARM_LINES);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (!entry || !entry.kind) continue;
          const bucket = this.kinds.get(entry.kind) || new KindStats();
          bucket.push(entry.elapsed || 0, entry.outcome || 'ok');
          this.kinds.set(entry.kind, bucket);
        } catch {
          // Skip a torn line rather than refusing to start.
        }
      }
    } catch {
      // No warm start available.
    }
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }
}

/** Read the whole ledger and aggregate it, for the CLI report. */
export function readLedger(file) {
  const target = file || ledgerPath({});
  const text = fs.readFileSync(target, 'utf8');
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.kind) entries.push(entry);
    } catch {
      // Tolerate a partial trailing write.
    }
  }
  return entries;
}

/** Group ledger entries by kind into the same summary shape the resolver reads. */
export function summarize(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    const bucket = buckets.get(entry.kind) || new KindStats();
    bucket.push(entry.elapsed || 0, entry.outcome || 'ok');
    buckets.set(entry.kind, bucket);
  }
  const out = {};
  for (const [kind, bucket] of buckets) out[kind] = bucket.summary();
  return out;
}
