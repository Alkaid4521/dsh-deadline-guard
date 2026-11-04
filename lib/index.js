/**
 * dsh-budget-guard -- tool-call deadlines that are measured, not guessed.
 *
 * A `tools/execute` wrapper. For every call it:
 *
 *   1. sorts the call into a kind and resolves a budget (declared < adaptive <
 *      catalog), clamping anything above the kind's ceiling;
 *   2. arms that budget on `exec.signal` -- the only field a wrapper may replace;
 *   3. on expiry returns a structured result that names the kind, reports the
 *      measured p50/p95 for that kind, and lists concrete next steps, instead of
 *      a bare 'timed out' the model can only answer by retrying;
 *   4. records the real elapsed time so the next budget for that kind comes from
 *      data.
 *
 * It is deliberately complementary to @deepseek-ai/dsh-tool-call-timeout-policy:
 * that one enforces what a tool declared, this one decides what a tool that
 * declared nothing (or declared something absurd) gets.
 *
 * @module dsh-budget-guard
 */

import { classify, resolveBudget, HINTS } from './catalog.js';
import { Ledger } from './ledger.js';

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'budget-guard';

/** The registry this plugin wraps. */
export const inject = ['tools'];

/** Error code carried on both the abort reason and the substituted result. */
const BUDGET_EXCEEDED = 'BUDGET_EXCEEDED';

/**
 * Calls that must never be given a wall-clock budget: they legitimately wait on a
 * human, a child agent, or a job the caller chose to block on. Clamping these
 * would turn the guard from a convenience into a hazard.
 */
const NEVER_ARM = new Set([
  'run_code',
  'subagent',
  'subagent_fork',
  'ralph',
  'ask_user_question',
  'job_output',
  'job_kill',
  'create_goal',
  'update_goal',
  'exit_plan_mode',
  'task_board_run',
]);

/** Read the plugin config with every default filled in. */
function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: config.enabled !== false,
    respectDeclared: config.respectDeclared !== false,
    adaptive: config.adaptive !== false,
    hintsEnabled: config.hints !== false,
    ledger: config.ledger !== false,
    ledgerPath: config.ledgerPath,
    graceMs: typeof config.graceMs === 'number' && config.graceMs >= 0 ? config.graceMs : 3000,
    budgets: config.budgets && typeof config.budgets === 'object' ? config.budgets : {},
    ceilings: config.ceilings && typeof config.ceilings === 'object' ? config.ceilings : {},
  };
}

/**
 * Arm a deadline on top of an upstream signal without detaching it.
 *
 * The returned signal aborts when either the budget expires or the caller
 * cancels, so replacing `exec.signal` can never hide a caller cancellation.
 */
function armDeadline(upstream, budgetMs) {
  const controller = new AbortController();
  let fired = false;

  const timer = setTimeout(() => {
    fired = true;
    const reason = new Error('budget exceeded after ' + budgetMs + 'ms');
    reason.name = 'BudgetExceededError';
    reason.code = BUDGET_EXCEEDED;
    controller.abort(reason);
  }, budgetMs);

  const forward = () => {
    try {
      controller.abort(upstream && upstream.reason);
    } catch {
      controller.abort();
    }
  };

  if (upstream && upstream.aborted) forward();
  else if (upstream && typeof upstream.addEventListener === 'function') {
    upstream.addEventListener('abort', forward, { once: true });
  }

  return {
    signal: controller.signal,
    fired: () => fired,
    dispose() {
      clearTimeout(timer);
      if (upstream && typeof upstream.removeEventListener === 'function') {
        upstream.removeEventListener('abort', forward);
      }
    },
  };
}

/** Render the structured result a budget expiry produces. */
function timeoutResult(options) {
  const { toolName, kind, budget, elapsed, stats, hints } = options;
  const lines = [];
  lines.push(
    'Error: ' + toolName + ' exceeded its ' + budget + 'ms budget ' +
    '(kind: ' + kind + ', elapsed: ' + Math.round(elapsed) + 'ms).',
  );
  if (stats && stats.samples > 0) {
    lines.push(
      'Measured for ' + kind + ': p50=' + stats.p50 + 'ms p95=' + stats.p95 +
      'ms max=' + stats.max + 'ms over ' + stats.samples + ' ok calls; ' +
      stats.timeouts + ' prior timeout(s).',
    );
  }
  if (hints && hints.length > 0) {
    lines.push('Next, in order of cost:');
    hints.forEach((hint, i) => lines.push('  ' + (i + 1) + '. ' + hint));
  }
  lines.push(
    'Do not re-issue the same call unchanged: it will spend the same budget again.',
  );

  const message = toolName + ' exceeded its ' + budget + 'ms budget';
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: true,
    error: {
      message,
      info: { name: 'ToolBudgetError', code: BUDGET_EXCEEDED },
    },
  };
}

/**
 * Register the guard.
 *
 * @param ctx - the cordis context; `tools` is injected above.
 * @param rawConfig - the `config:` block from cordis.patch.yml.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const ledger = new Ledger(config);

  ctx.on('dispose', () => {
    try {
      ledger.close();
    } catch {
      // Shutdown is best effort.
    }
  });

  ctx.on('tools/execute', async (exec, next) => {
    const toolName = String(exec && exec.name ? exec.name : 'unknown');
    if (NEVER_ARM.has(toolName)) return next();

    const { kind, evidence } = classify(toolName, exec && exec.arguments);

    let declared;
    try {
      declared = ctx.tools.get(toolName, exec.agent)?.timeoutMs;
    } catch {
      declared = undefined;
    }

    const stats = ledger.statsFor(kind);
    const decision = resolveBudget({ kind, declared, config, stats });

    if (!decision.arm) {
      const started = performance.now();
      try {
        const result = await next();
        ledger.record({
          ts: new Date().toISOString(),
          name: toolName,
          kind,
          evidence,
          budget: decision.budget,
          source: decision.source,
          elapsed: Math.round(performance.now() - started),
          outcome: 'ok',
        });
        return result;
      } catch (err) {
        ledger.record({
          ts: new Date().toISOString(),
          name: toolName,
          kind,
          evidence,
          budget: decision.budget,
          source: decision.source,
          elapsed: Math.round(performance.now() - started),
          outcome: 'error',
        });
        throw err;
      }
    }

    const started = performance.now();
    const guard = armDeadline(exec.signal, decision.budget);
    const upstream = exec.signal;
    const sentinel = Symbol('budget-expired');

    let graceTimer;
    const gracePromise = new Promise((resolve) => {
      graceTimer = setTimeout(() => resolve(sentinel), decision.budget + config.graceMs);
    });

    exec.signal = guard.signal;
    try {
      const pending = next();
      // A tool that ignores its signal must not hold the turn open past the grace
      // window; swallow its eventual rejection so it cannot surface as unhandled.
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});

      const outcome = await Promise.race([pending, gracePromise]);
      const elapsed = performance.now() - started;

      if (outcome === sentinel || guard.fired()) {
        ledger.record({
          ts: new Date().toISOString(),
          name: toolName,
          kind,
          evidence,
          budget: decision.budget,
          source: decision.source,
          elapsed: Math.round(elapsed),
          outcome: 'timeout',
        });
        return timeoutResult({
          toolName,
          kind,
          budget: decision.budget,
          elapsed,
          stats,
          hints: config.hintsEnabled ? HINTS[kind] : undefined,
        });
      }

      ledger.record({
        ts: new Date().toISOString(),
        name: toolName,
        kind,
        evidence,
        budget: decision.budget,
        source: decision.source,
        elapsed: Math.round(elapsed),
        outcome: 'ok',
      });
      return outcome;
    } catch (err) {
      const elapsed = performance.now() - started;
      const timedOut = guard.fired();
      ledger.record({
        ts: new Date().toISOString(),
        name: toolName,
        kind,
        evidence,
        budget: decision.budget,
        source: decision.source,
        elapsed: Math.round(elapsed),
        outcome: timedOut ? 'timeout' : 'error',
      });
      if (timedOut) {
        return timeoutResult({
          toolName,
          kind,
          budget: decision.budget,
          elapsed,
          stats,
          hints: config.hintsEnabled ? HINTS[kind] : undefined,
        });
      }
      throw err;
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
      guard.dispose();
      exec.signal = upstream;
    }
  });
}

export default { name, inject, apply };
