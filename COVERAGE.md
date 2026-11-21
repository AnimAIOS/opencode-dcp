# Coverage Evaluation Report

This document records how unit-test coverage is measured for this plugin, the baseline
snapshot taken before a round of new tests, and the refreshed numbers after those tests
landed. It is a repeatable evaluation record, not a claim of completeness.

## How coverage is measured

Coverage is gathered with the **Node 26 built-in V8 coverage** support, exposed through
Node's test runner:

```sh
npm run test:coverage
```

which runs exactly:

```sh
node --import tsx --test --experimental-test-coverage \
  --test-coverage-include='lib/**/*.ts' --test-coverage-include-all \
  --test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=85 \
  tests/*.test.ts
```

Key points about this setup:

- **Node 26 built-in V8 coverage** — no third-party coverage tool (e.g. `c8`/`nyc`) is
  used. Node's `--experimental-test-coverage` flag instruments V8 and the test runner
  prints a line / branch / function summary at the end of the run.
- **tsx loader** — `--import tsx` transpiles the TypeScript sources on the fly so the
  `.ts` files under `lib/` can be imported and instrumented directly; there is no separate
  build step.
- **Include-all** — `--test-coverage-include-all` makes source files that were never
  loaded still count against the totals. This is why large, untested handler modules pull
  the headline numbers down instead of being silently omitted.
- **Threshold gates** — the run fails if lines drop below 90%, branches below 80%, or
  functions below 85%. These are intentionally set at the current baseline minus a small
  margin so regressions fail CI without blocking day-to-day work.
- **Scope of these numbers** — the glob `lib/**/*.ts` limits the report to `.ts` source
  files. The `.tsx` TUI files are render-tested separately by `test:tui`/`test:coverage:tui`
  (bun) and are **not** in these numbers; see [TUI_COVERAGE.md](TUI_COVERAGE.md). The
  `tests/logger` workspace is also exercised by a separate
  `npm test --workspace=tests/logger` run and is **not** included here.

## Baseline snapshot (before new tests)

**Overall totals:** lines 85.51%, branches 78.05%, functions 84.76% across 77 files.

| Distribution of line coverage | Files |
| ----------------------------- | ----- |
| 100% line                     | 29    |
| >= 90% line                   | 54    |
| >= 75% line                   | 66    |
| >= 50% line                   | 68    |
| below 50% line                | 9     |

### Lowest-coverage files at baseline

| File                | Lines  | Branches | Functions |
| ------------------- | ------ | -------- | --------- |
| config.ts           | 77.14% | 27.27%   | 83.33%    |
| commands/stats.ts   | 28.48% | 100%     | 16.67%    |
| commands/sweep.ts   | 31.95% | 100%     | 16.67%    |
| commands/help.ts    | 34.21% | 100%     | 25%       |
| commands/context.ts | 42.21% | 100%     | 20%       |
| ui/utils.ts         | 54.06% | 86.11%   | 41.67%    |
| update.ts           | 64.86% | 62.50%   | 63.64%    |
| auth.ts             | 0%     | 100%     | 100%      |
| state/types.ts      | 13.01% | 100%     | 100%      |

> **Caveat on "100% branch" for mostly-unloaded files:** V8 only reports branches for
> code that actually executed. For files that are barely loaded (e.g. `auth.ts` at 0%
> lines, or the command handlers at 30–40% lines), a "100% branch" figure does **not**
> mean the branching logic is thoroughly tested — it means no uncovered branch was
> observed in the small fraction of code that ran. These baseline branch numbers were
> vacuous until the corresponding files were meaningfully exercised.

## Current snapshot (after new tests)

`npm run test:coverage` now reports:

| Metric    | Baseline | Current | Threshold |
| --------- | -------- | ------- | --------- |
| Lines     | 85.51%   | 92.20%  | >= 90%    |
| Branches  | 78.05%   | 83.22%  | >= 80%    |
| Functions | 84.76%   | 90.35%  | >= 85%    |

| Distribution of line coverage | Files |
| ----------------------------- | ----- |
| 100% line                     | 32    |
| >= 90% line                   | 59    |
| >= 75% line                   | 70    |
| >= 50% line                   | 72    |
| below 50% line                | 5     |

### Targeted improvements

| File                | Before (L/B/F)    | After (L/B/F)   |
| ------------------- | ----------------- | --------------- |
| config.ts           | 77.14/27.27/83.33 | 99.62/92.89/100 |
| commands/context.ts | 42.21/100/20      | 99.68/89.23/100 |
| commands/help.ts    | 34.21/100/25      | 100/100/100     |
| commands/stats.ts   | 28.48/100/16.67   | 100/100/100     |
| commands/sweep.ts   | 31.95/100/16.67   | 100/90/90       |

The four command handlers now report real branch execution rather than vacuous 100%,
and `config.ts` went from 27% to 93% branch coverage.

## Test status

- One test was failing at baseline: `tests/compress-atomicity.test.ts:397` ("another
  session's system hook cannot change a counting turn's model context"). The root cause
  turned out to be a real production race, not a test artifact: PR #510's merge dropped
  `await` from the legacy transform's async calls. It is now fixed (see below), and both
  original assertions remain intact without any timing workaround.
- Full verification passes with zero failures:
    - `npm test` — 294 Node unit tests (289 pass, 5 pre-existing skips), 6 bun TUI tests,
      8 logger workspace tests.
    - `npm run test:coverage` — thresholds pass at 92.20 / 83.22 / 90.35.
    - `npm run typecheck` — clean.

## Race hardening after the PR merges

A systematic audit of the recent upstream merges (#660, #670, #510, #589, #669, #607,
#569) plus a new deterministic stress suite found and fixed these hazards:

1. **Legacy transform fire-and-forget (high)** — `lib/hooks.ts:184` and `:196` now await
   `syncToolCache` and `injectCompressNudges`. PR #510's merge had dropped both awaits,
   so the hook resolved before tool data and nudges were injected; a suspended count
   could also write stale tool entries into the next session's state.
   `tests/hooks-permission.test.ts` was updated from the old timing expectation and now
   also asserts the nudge is present immediately after the hook resolves.
2. **Nested fire-and-forget in the injector (high)** — `lib/messages/inject/utils.ts`
   nudge helpers were made `async` despite doing no I/O, and `inject.ts` called them and
   `saveSessionState` with `void`. The chain is now synchronous where there is no I/O,
   and persistence is awaited, so nudges and saved state are complete when the hook
   returns. Covered by `tests/inject-race.test.ts`.
3. **Last-renamer-wins persistence (medium-high)** — `lib/state/persistence.ts` now
   serializes writes per session via a write queue, preserving the atomic temp+rename
   while guaranteeing the newest snapshot commits last. The detached saves in
   `state.ts` and `commands/sweep.ts` are now awaited.
4. **Unserialized v1 event hook (medium)** — `index.ts` now wraps `createEventHandler`
   in `exclusive(state, ...)`, matching the other mutating hooks. A gated regression test
   in `tests/event-exclusive.test.ts` fails if the wrapper is removed.
5. **Reconstruction staleness (low-medium)** — `lib/compress/reconstruct.ts` now captures
   state identity before its awaits and calls `assertPlannedBlockIds` before applying,
   matching the compress tools. A reset during counting now applies nothing.

New deterministic stress tests: `tests/race-cross-session.test.ts` (cross-session
token counting, model limits, system-hook interleaving), `tests/race-state.test.ts`
(state replacement, same-session concurrency, persistence, prompt/tool cache),
`tests/race-tokenizer.test.ts` (40 overlapping counts, timeout with queued survivors,
dispose with in-flight waiters), plus `tests/event-exclusive.test.ts` and
`tests/inject-race.test.ts`. All use promise gates rather than timer races.

Areas audited and found sound: child-process tokenizer queue/reap/timeout logic,
`tokenUsageEstimate` memo, model-context-limit resolution, prompt store, subagent result
cache, `Date.now()`-based IDs, and the v2 `serial`/compaction atomicity paths.

## Remaining gaps and observations

- **TUI** — separate coverage track; see [TUI_COVERAGE.md](TUI_COVERAGE.md).
- `lib/update.ts` (64.86% lines) — network/update paths still untested.
- `lib/auth.ts` (0% lines) — only exercised by lab/integration scripts.
- `lib/tui/commands.ts` / `data.ts` / `format.ts` — TUI helpers not loaded by the Node
  suite; bun coverage reports `format.ts` at 55.56% lines.
- `lib/ui/notification.ts` (78.25%) and `lib/state/types.ts` (13.01%, mostly type
  declarations).
- `tests/race-cross-session.test.ts` still has harmless `flushMicrotasks()` calls left
  over from the old fire-and-forget behavior; they can be removed but do not affect results.
- **Dead code:** `lib/commands/help.ts` defines `TOOL_COMMANDS.decompress` and
  `TOOL_COMMANDS.recompress`, but `getVisibleCommands` only adds `TOOL_COMMANDS.compress`.
- **Cosmetic:** `formatContextMessage` renders "1 messages" for a single pruned message.
