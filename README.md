# dsh-budget-guard

Deadlines for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) tool calls that are **measured instead of guessed**.

Every call is sorted into a budget kind, given a deadline, and — when it runs out — answered with the measured p50/p95 for that kind and a concrete "do this next" list instead of a bare `timed out`. The real elapsed time of every call is kept in a JSONL ledger, so the next budget for that kind comes from data.

## Install

```bash
dsh plugin --profile web add github:Alkaid4521/dsh-budget-guard
```

Or install the tarball from the [releases page](https://github.com/Alkaid4521/dsh-budget-guard/releases) when the profile host cannot reach GitHub directly:

```bash
dsh plugin --profile web add https://github.com/Alkaid4521/dsh-budget-guard/releases/download/v0.1.0/dsh-budget-guard-0.1.0.tgz
```

Restart the harness afterwards. Manual install (older profiles) is covered at the bottom.

## Why

A timeout number is a **prepaid worst case**. If 90% of calls finish in under two seconds, a 120-second bound costs nothing 90% of the time — and costs the full 120 seconds on exactly the calls that were already going wrong: an unreachable host, a port with nothing on it, a package manager stuck on a dead mirror. That is the wall clock this plugin reclaims.

It is not about making every timeout short. It is about separating the two cases:

| Case | What happens |
|---|---|
| Fast call (the 90%) | Never touches the budget. Unaffected. |
| Call that hangs | Stopped at a tight, kind-specific deadline, then told how to avoid repeating itself. |
| Call that is genuinely slow (a build, an install) | Classified as `build`, gets a large budget, and is expected to run in the background. |

## What it does

1. **Classifies** every call into `net` / `search` / `read` / `shell` / `build` / `tool`, using the tool name plus the shell command when there is one.
2. **Resolves a budget**: a declaration tighter than the resolved value wins; a looser one is clamped. With at least five successful samples for a kind, `max(p95 * 3, 5s)` replaces the catalog default.
3. **Arms** that budget on `exec.signal` — the only field a `tools/execute` wrapper may replace — composing with the caller's signal so cancellation is never swallowed.
4. **Explains a timeout**: the result names the kind, reports the measured p50/p95/max and prior timeout count, and lists ordered next steps.
5. **Records** `{ts, name, kind, evidence, budget, source, elapsed, outcome}` per call.

A tool that ignores its signal does not hold the turn open forever: after `graceMs` past the budget the wrapper stops waiting and returns the budget result.

## Configuration

All values live in the `config:` block of `cordis.patch.yml` (or the profile's patch row):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `respectDeclared` | `true` | Honor a tool's own `timeoutMs` when it is tighter. `false` always uses the resolved budget. |
| `adaptive` | `true` | Use `max(p95 * 3, 5s)` once a kind has 5+ successful samples. |
| `hints` | `true` | Append measured stats and next steps to a timeout result. |
| `ledger` | `true` | Write the JSONL ledger. |
| `graceMs` | `3000` | Extra wait for a tool that ignores its signal before the wrapper gives up. |
| `budgets` | see below | Deadline per kind. |
| `ceilings` | see below | Hard cap per kind; anything above is clamped even if declared. |

### Default budgets and ceilings

| Kind | Budget | Ceiling | Sorted by |
|---|---|---|---|
| `net` | 15s | 30s | `curl`, `wget`, `ping`, `ssh`, `web_fetch`, `web_search`, `pilot_*` |
| `search` | 30s | 120s | `grep`, `rg`, `find`, `ls`, `glob`, `ops_grep` |
| `read` | 15s | 60s | `read`, `write`, `edit`, `str_replace_editor` |
| `shell` | 60s | 300s | any other shell command |
| `build` | 180s | 600s | `npm`, `pip`, `node`, `make`, `cargo`, `docker`, `git clone` |
| `tool` | 60s | 600s | everything else |

Calls that legitimately wait on a human, a child agent, or a job are never armed: `run_code`, `subagent`, `ask_user_question`, `job_output`, `ralph`, `create_goal`, `exit_plan_model`, `task_board_run`, and their siblings.

## CLI

```bash
dsh-budget-guard report            # per-kind table + the budget it would pick next
dsh-budget-guard explain --tool ops_bash --cmd "curl -sS http://x"
dsh-budget-guard path              # where the ledger lives
dsh-budget-guard reset             # truncate it
```

`report` is the answer to "what should this budget be": the `next budget` column is the value the guard will actually use on the next call of that kind.

## Relation to `dsh-tool-call-timeout-policy`

The official policy enforces what a tool **declared**. This plugin decides what a tool that declared nothing — or declared something absurd — gets, and turns an expiry into a routed next step. They compose: a declaration tighter than this guard's budget is left to the official policy; anything looser is clamped here.

## Ledger

`$DSH_HOME/budget-guard/calls.jsonl` (default `~/.dsh/budget-guard/calls.jsonl`), one line per call, append-only, buffered and flushed on a 1.5s timer. The last 400 lines are replayed at startup so budgets survive a restart. A ledger write failure never surfaces as a tool failure.

## Manual install

```bash
git clone https://github.com/Alkaid4521/dsh-budget-guard.git
```

Then in the profile's `package.json` add the dependency pointing at the clone

```json
"dsh-budget-guard": "link:D:/path/to/dsh-budget-guard"
```

and add `dsh-budget-guard` to `dsh.profile.bundles`. The bundle patch registers itself; restart the harness.

## Tests

```bash
npm test
```

20 assertions over classification, budget resolution, ledger aggregation and the execute wrapper (pass-through, timeout, cancellation propagation, thrown errors, never-arm bypass).

## License

MIT
