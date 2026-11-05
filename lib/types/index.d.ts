/**
 * Type surface for dsh-deadline-guard. The plugin is plain JavaScript; these
 * declarations exist so a TypeScript host profile can reference the config
 * shape and the exported cordis plugin without a build step.
 */
import type { Context } from '@deepseek-ai/cordis';

/** Deadline kinds the guard sorts every call into. */
export type BudgetKind = 'net' | 'search' | 'read' | 'shell' | 'build' | 'tool';

/** One call's measured entry, as written to the ledger. */
export interface LedgerEntry {
  ts: string;
  name: string;
  kind: BudgetKind;
  evidence: string;
  budget: number;
  source: 'catalog' | 'adaptive' | 'declared' | 'clamped';
  elapsed: number;
  outcome: 'ok' | 'error' | 'timeout';
}

/** Rolling per-kind aggregate; the resolver reads this before every dispatch. */
export interface KindSummary {
  ok: number;
  failed: number;
  timeouts: number;
  samples: number;
  p50: number;
  p95: number;
  max: number;
}

/** Plugin configuration, mirroring the config block in cordis.patch.yml. */
export interface BudgetGuardConfig {
  enabled?: boolean;
  respectDeclared?: boolean;
  adaptive?: boolean;
  hints?: boolean;
  ledger?: boolean;
  ledgerPath?: string;
  graceMs?: number;
  budgets?: Partial<Record<BudgetKind, number>>;
  ceilings?: Partial<Record<BudgetKind, number>>;
}

/** The cordis plugin object exported by this package. */
export interface BudgetGuardPlugin {
  name: string;
  inject: string[];
  apply(ctx: Context, config?: BudgetGuardConfig): void;
}

export declare const name: string;
export declare const inject: string[];
export declare function apply(ctx: Context, config?: BudgetGuardConfig): void;

declare const plugin: BudgetGuardPlugin;
export default plugin;
