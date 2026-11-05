# dsh-deadline-guard

Deadlines for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) tool calls that are **measured instead of guessed**.

> **Not a cost plugin.** This guard measures **milliseconds** — how long a tool call is allowed to run. It has no token metering, no pricing and no UI. If you are looking for LLM spend tracking with a budget card, that is a different package (`dsh-budget-guard` on npm, by another author).

Every call is sorted into a deadline kind, given a budget, and — when it runs out — answered with the measured p50/p95 for that kind and a concrete "do this next" list instead of a bare `timed out`. The real elapsed time of every call is kept in a JSONL ledger, so the next budget for that kind comes from data.

## Install

```bash
dsh plugin --profile web add github:Alkaid4521/dsh-deadline-guard
```

Or install the tarball from the [releases page](https://github.com/Alkaid4521/dsh-deadline-guard/releases) when the profile host cannot reach GitHub directly.

Restart the harness afterwards. Manual install (older profiles) is covered at the bottom.

## Why

A timeout number is a **prepaid worst case**. If 90% of calls finish in under two seconds, a 120-second bound costs nothing 90% of the time — and costs the full 120 seconds on exactly the calls that were already going wrong: an unreachable host, a port with nothing on it, a package manager stuck on a dead mirror. That is the wall clock this plugin reclaims.

The inverse mistake costs just as much: a budget so tight that a legitimately slow call is killed and re-run. The floor table exists for that, and the `mkdir -p x && npm pack` case below is why.

| Case | What happens |
|---|---|
| Fast call (the 90%) | Never touches the budget. Unaffected. |
| Call that hangs | Stopped at a tight, kind-specific deadline, then told how to avoid repeating itself. |
| Call that is genuinely slow (a build, an install) | Classified as `build` — including when it hides behind a leading `cd` or `mkdir` — and gets a build-sized budget. |

## What it does

1. **Classifies** every call into `net` / `search` / `read` / `shell` / `build` / `tool`. For shell tools the *whole* command line is split on `&&`, `||`, `;` and `|`, and the first segment that matches build / net / search rules decides — so `mkdir -p x && npm pack` is a `build`, not a 5-second `shell`.
2. **Resolves a budget**: a declaration tighter than the resolved value wins; a looser one is clamped. With at least five successful samples for a kind, `max(p95 * 3, floors[kind])` replaces the catalog default.
3. **Arms** that budget on `exec.signal` — the only field a `tools/execute` wrapper may replace — composing with the caller's signal so cancellation is never swallowed.
4. **Explains a timeout**: the result names the kind, reports the measured p50/p95/max and prior timeout count, and lists ordered next steps.
5. **Records** `{ts, name, kind, evidence, budget, source, elapsed, outcome}` per call.

A tool that ignores its signal does not hold the turn open forever: after `graceMs` past the budget the wrapper stops waiting and returns the budget result.

## Configuration

All values live in the `config:` block of `cordis.patch.yml` (or the profile's patch row):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `respectDeclared` | `true` | Honor a tool's own `timeoutMs` when it is tighter. |
| `adaptive` | `true` | Use `max(p95 * 3, floors[kind])` once a kind has 5+ successful samples. |
| `hints` | `true` | Append measured stats and next steps to a timeout result. |
| `ledger` | `true` | Write the JSONL ledger. |
| `graceMs` | `3000` | Extra wait for a tool that ignores its signal before the wrapper gives up. |
| `budgets` | see below | Fixed deadline per kind (used when adaptive is off or sampling is thin). |
| `floors` | see below | Lower bound for the adaptive rule. |
| `ceilings` | see below | Hard cap per kind; anything above is clamped even if declared. |

### Defaults

| Kind | Budget | Floor | Ceiling | Sorted by |
|---|---|---|---|---|
| `net` | 15s | 10s | 30s | `curl`, `wget`, `ping`, `ssh`, `web_fetch`, `web_search`, `pilot_*` |
| `search` | 30s | 20s | 120s | `grep`, `rg`, `find`, `ls`, `glob`, `ops_grep` |
| `read` | 15s | 10s | 60s | `read`, `write`, `edit`, `str_replace_editor` |
| `shell` | 60s | 30s | 300s | any other shell command |
| `build` | 180s | 120s | 600s | `npm`, `pip`, `node`, `make`, `cargo`, `docker`, `tar`, `git clone` |
| `tool` | 60s | 20s | 600s | everything else |

Calls that legitimately wait on a human, a child agent, or a job are never armed: `run_code`, `subagent`, `subagent_fork`, `ask_user_question`, `job_output`, `job_kill`, `ralph`, `create_goal`, `update_goal`, `exit_plan_mode`, `task_board_run`.

## CLI

```bash
dsh-deadline-guard report            # per-kind table + the budget it would pick next
dsh-deadline-guard explain --tool ops_bash --cmd "mkdir -p x && npm pack"
dsh-deadline-guard path              # where the ledger lives
dsh-deadline-guard reset             # truncate it
```

## Relation to `dsh-tool-call-timeout-policy`

The official policy enforces what a tool **declared**. This plugin decides what a tool that declared nothing — or declared something absurd — gets, and turns an expiry into a routed next step. They compose: a declaration tighter than this guard's budget is left to the official policy; anything looser is clamped here.

## Ledger

`$DSH_HOME/deadline-guard/calls.jsonl`, one line per call, append-only, buffered and flushed on a 1.5s timer. The last 400 lines are replayed at startup so budgets survive a restart. A ledger write failure never surfaces as a tool failure.

## Manual install

```bash
git clone https://github.com/Alkaid4521/dsh-deadline-guard.git
```

Then in the profile's `package.json` add the dependency pointing at the clone

```json
"dsh-deadline-guard": "link:D:/path/to/dsh-deadline-guard"
```

and add `dsh-deadline-guard` to `dsh.profile.bundles`. The bundle patch registers itself; restart the harness.

## Tests

```bash
npm test
```

23 assertions over classification (including compound commands), budget resolution (floor / ceiling / declaration precedence), ledger aggregation and the execute wrapper (pass-through, timeout, cancellation propagation, thrown errors, never-arm bypass).

## License

MIT
