/**
 * Classification and budget resolution for one tool call.
 *
 * The point of this module is that a timeout is a *routing decision*, not a
 * number to guess. Every call is sorted into a kind, and the kind decides both
 * the deadline and what to do when the deadline wins.
 *
 * @module dsh-deadline-guard/catalog
 */

/** Default deadline per kind, in milliseconds. Deliberately tighter than the
 * upstream defaults (120s shell / 300s pwsh): those only need to bound the worst
 * case, and the worst case is exactly what wastes the wall clock. */
export const DEFAULT_BUDGETS = {
  net: 15000,
  search: 30000,
  read: 15000,
  shell: 60000,
  build: 180000,
  tool: 60000,
};

/** Floor per kind, used only by the adaptive rule. A measured p95 under the
 * floor means the samples are dominated by trivially fast calls (cd, echo, ls),
 * so p95 * 3 would produce a deadline that kills the first genuinely slow
 * command that lands in the same kind. The floor is what keeps that from
 * happening -- e.g. `mkdir -p x && npm pack` is a shell-kind call that needs
 * far more than the 5s a pure p95 rule would hand it. */
export const DEFAULT_FLOORS = {
  net: 10000,
  search: 20000,
  read: 10000,
  shell: 30000,
  build: 120000,
  tool: 20000,
};

/** Hard ceiling per kind. A tool that declares its own timeout above this is
 * still clamped: a declared 10-minute grep is a declaration of a bug. */
export const DEFAULT_CEILINGS = {
  net: 30000,
  search: 120000,
  read: 60000,
  shell: 300000,
  build: 600000,
  tool: 600000,
};

/** What to do when this kind runs out of budget. Rendered into the tool result
 * the model reads, so the next step is steered instead of retried blindly. */
export const HINTS = {
  net: [
    'probe the socket first: curl -sS --connect-timeout 3 --max-time 5 URL (not the full request)',
    'verify port, cert and proxy before retrying; a DNS hijack or TLS intercept presents exactly as a hang',
    'switch mirror/hosts instead of raising the timeout',
  ],
  search: [
    'add a filter: --glob / include / single directory, then widen only if the hit count demands it',
    'cut output volume with summary / files_with_matches / -l before re-running',
    'a scan that needs >30s on a repo this size is scanning build output, node_modules or .git',
  ],
  read: [
    'read a line range (offset/limit) instead of the whole file',
    'confirm the path exists with a glob before reading it',
    'a single read that hangs is an I/O or lock problem, not a size problem',
  ],
  shell: [
    'assume the command is waiting on stdin: pass -y / --yes, or redirect </dev/null',
    'anything projected above ~30s belongs in run_in_background + job_output polling',
    'write output to a file and read the tail rather than holding the pipe',
  ],
  build: [
    'run the single file / single package first and measure it, then multiply',
    'never hold a build synchronously: run_in_background + job_output(wait, timeout_ms)',
    'install steps belong in the background; only the verification step needs the foreground',
  ],
  tool: [
    'narrow the arguments (fewer items, smaller range) and retry',
    'split the batch: N sequential calls under a bounded wait beat one unbounded call',
    'if the tool exposes its own timeout parameter, lower it and let it terminate cleanly',
  ],
};

/** Tools that forward a shell command string, where the command decides the kind. */
const SHELL_TOOLS = new Set(['ops_bash', 'win_bash', 'bash', 'pwsh', 'shell', 'terminal']);

/** Tools that always reach the network. */
const NET_TOOLS = new Set(['web_fetch', 'web_search', 'pilot_open', 'pilot_download', 'pilot_reload']);

/** Tools that walk the filesystem looking for content. */
const SEARCH_TOOLS = new Set(['grep', 'glob', 'ops_grep', 'ops_glob', 'ops_replace', 'find']);

/** Tools that touch a single known file. */
const READ_TOOLS = new Set(['read', 'write', 'edit', 'str_replace_editor', 'read_image', 'ops_inspect_local_file']);

const NET_RE = /^(curl|wget|ping|ping6|nc|ncat|netcat|telnet|ssh|scp|sftp|openssl|dig|nslookup|tracert|traceroute|test-netconnection|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i;
const SEARCH_RE = /^(grep|rg|ag|ack|find|fd|ls|dir|wc|du|tree|fzf|git\s+grep)\b/i;
const BUILD_RE = /^(npm|pnpm|yarn|bun|pip|pip3|python|python3|node|npx|deno|tsc|esbuild|vite|webpack|rollup|make|cmake|ninja|cargo|go|rustc|dotnet|msbuild|mvn|gradle|docker|podman|codesign|tar|unzip|7z|gzip|git\s+(clone|fetch|submodule))\b/i;

/** First token of a command string, used only for evidence in the ledger. */
function firstWord(command) {
  const head = String(command || '').trim().split(/\s+/)[0] || '';
  return head.slice(0, 24);
}

/** Extract the command string from a shell tool's arguments. */
function commandOf(args) {
  if (!args || typeof args !== 'object') return '';
  const value = args.command !== undefined ? args.command : args.script_path;
  return typeof value === 'string' ? value : '';
}

/**
 * Split a compound command into its simple segments.
 *
 * A leading `cd`, `mkdir` or `test` must not decide the kind for the whole line:
 * `mkdir -p x && npm pack` is a build, and classifying it as a shell call is how
 * a 5s deadline ends up killing a package download.
 */
export function segments(command) {
  return String(command || '')
    .split(/&&|\|\||[;|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Sort one call into a budget kind.
 *
 * @param name - the tool name from the execution.
 * @param args - the parsed arguments of that call.
 * @returns the kind plus a short evidence string for the ledger.
 */
export function classify(name, args) {
  const tool = String(name || '').toLowerCase();
  if (SHELL_TOOLS.has(tool)) {
    const command = commandOf(args);
    const parts = segments(command);
    for (const part of parts) {
      if (BUILD_RE.test(part)) return { kind: 'build', evidence: 'cmd:' + firstWord(part) };
    }
    for (const part of parts) {
      if (NET_RE.test(part)) return { kind: 'net', evidence: 'cmd:' + firstWord(part) };
    }
    for (const part of parts) {
      if (SEARCH_RE.test(part)) return { kind: 'search', evidence: 'cmd:' + firstWord(part) };
    }
    return { kind: 'shell', evidence: 'cmd:' + (firstWord(command) || '(none)') };
  }
  if (NET_TOOLS.has(tool) || tool.startsWith('bili_') || tool.startsWith('pilot_')) {
    return { kind: 'net', evidence: 'tool' };
  }
  if (SEARCH_TOOLS.has(tool)) return { kind: 'search', evidence: 'tool' };
  if (READ_TOOLS.has(tool)) return { kind: 'read', evidence: 'tool' };
  return { kind: 'tool', evidence: 'tool' };
}

/** Clamp a candidate budget into a sane range for its kind. A floor here only
 * rejects absurd values (0, negative); per-kind floors belong to the adaptive
 * rule, so that an explicitly small configured budget is honored. */
function clampBudget(value, kind, config, declared) {
  const budgets = { ...DEFAULT_BUDGETS, ...(config.budgets || {}) };
  const ceilings = { ...DEFAULT_CEILINGS, ...(config.ceilings || {}) };
  const ceiling = ceilings[kind] || budgets[kind] || DEFAULT_BUDGETS.tool;
  const bounded = Math.max(100, Math.min(value, ceiling));
  return { budget: Math.round(bounded), ceiling, declared };
}

/**
 * Decide the deadline for one call, and whether this guard should arm it.
 *
 * Precedence: an explicit tighter declaration wins (the tool knows better);
 * otherwise the measured p95 for this kind wins when there is enough history,
 * bounded below by the kind floor; otherwise the configured catalog value.
 * Anything above the ceiling is clamped even when it was declared -- that is the
 * case this plugin exists for.
 *
 * @param options - kind, declared timeout, plugin config, and measured stats.
 * @returns budget in ms, how it was chosen, and whether to arm a deadline.
 */
export function resolveBudget(options) {
  const { kind, declared, config = {}, stats } = options || {};
  const budgets = { ...DEFAULT_BUDGETS, ...(config.budgets || {}) };
  const floors = { ...DEFAULT_FLOORS, ...(config.floors || {}) };
  const base = budgets[kind] || DEFAULT_BUDGETS.tool;
  const hasDeclared = typeof declared === 'number' && declared > 0;

  let target = base;
  let source = 'catalog';

  if (config.adaptive !== false && stats && stats.ok >= 5 && stats.p95 > 0) {
    // Three times the observed p95 keeps a normal call intact; the kind floor
    // keeps a sample set full of 20ms `cd` calls from strangling the first real
    // command that shares the kind.
    const floor = floors[kind] || 5000;
    target = Math.max(stats.p95 * 3, floor);
    source = 'adaptive';
  }

  const clamped = clampBudget(target, kind, config, hasDeclared ? declared : undefined);

  if (hasDeclared && declared <= clamped.budget && config.respectDeclared !== false) {
    // The tool is already stricter than anything this guard would pick: let the
    // upstream policy arm it and stay out of the way.
    return { budget: Math.round(declared), source: 'declared', arm: false, kind };
  }
  if (hasDeclared) {
    // It declared something looser than this kind deserves. That is the case worth
    // tightening, so record why the number is not simply the catalog value.
    source = 'clamped';
  }
  return { budget: clamped.budget, source, arm: true, kind };
}
