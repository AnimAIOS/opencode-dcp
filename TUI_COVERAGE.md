# TUI `.tsx` coverage: findings and recommendation

Investigation date: 2026-11-20. Bun: `1.4.4` (`/usr/bin/bun`). Node: `v26.13.1`.

## 1. Inventory of `lib/**/*.tsx` (plus package-root `tui.tsx`)

| File                                       | Role                                                                                                                                                                                                                  | Tested?                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/tui/dialogs.tsx`                      | Presentational dialogs: `StatusDialog`, `ContextDialog`, `StatsDialog`, `PanelDialog`, `ManualModeToggle`.                                                                                                            | **Yes** — rendered by `tests/v2-tui-render.test.tsx` (bun). The denied-compression message branch (old lines 190–192) was not hit; now covered by the new `tests/v2-tui-gaps.test.tsx`.                                                                                                                                                                                     |
| `lib/tui/ui.tsx`                           | Shared layout primitives: `DcpFrame`, `Card`, `Metric`, `Progress`, `PromptRow`, `StatusPill`, `ActionRow`, `FooterButton`.                                                                                           | **Indirectly** — exercised whenever a dialog renders (bun). Bun reports 100% lines.                                                                                                                                                                                                                                                                                         |
| `lib/tui/modals.tsx`                       | Legacy **v1** flow: `showDialog`, `showStatusDialog`, `showError`, `openPanelModal`/`openContextModal`/`openStatsModal`, `runModal`, `setManualMode`. Imported only by the package-root `tui.tsx` v1 `tui()` hook.    | **No.** No test imports it; it does not appear in any coverage report because it is never loaded.                                                                                                                                                                                                                                                                           |
| `lib/v2/tui.tsx`                           | **v2** plugin setup: capability detection, RPC client, `rpc.dcp.notify` → toast bridge, `ViewApi` assembly, `enable` check, `/dcp` + `/dcp-compress` slash commands, panel/context/stats navigation and error dialog. | **Partially.** `tests/v2-tui-slash.test.ts` (Node) covers command registration and dispatch. `tests/v2-tui-render.test.tsx` does not import it. The new `tests/v2-tui-gaps.test.tsx` covers toast mapping/defaults/truncation, the disabled early-return, and the missing-UI-API headless fallback. Panel-opening/navigation and error paths remain integration-level gaps. |
| `tui.tsx` (package root, not under `lib/`) | Plugin entrypoint: default export with `id`, `setup` (v2) and `tui` (v1 `openPanelModal` command registration).                                                                                                       | **No.** Not imported by any test and outside the `lib/**` coverage globs.                                                                                                                                                                                                                                                                                                   |

`tests/v2-tui-theme.test.ts` and `tests/v2-tui-slash.test.ts` are `.ts` tests: they exercise `lib/v2/theme.ts` and `lib/v2/tui.tsx` respectively under the **Node** runner, not via bun rendering.

## 2. Can `bun test --coverage` report on `lib/**/*.tsx`?

**Yes.** `bun test --coverage tests/v2-tui-*...` works in this environment and emits a text table to stdout (no files written by default). It naturally includes every `.tsx` module that the test's import graph loads:

```
lib/tui/dialogs.tsx   |   83.33 |  100.00 |
lib/tui/ui.tsx        |   86.67 |  100.00 |
lib/v2/tui.tsx        |   57.14 |   51.68 |
```

Numbers above are from `bun test --coverage tests/v2-tui-*.test.tsx tests/v2-tui-slash.test.ts tests/v2-tui-theme.test.ts` **after** the new gap tests (15 pass). Before the new tests: `dialogs.tsx` 98.45% lines (uncovered 190–192), `ui.tsx` 100%, `v2/tui.tsx` 37.58% lines.

Also works:

```
bun test --coverage --coverage-reporter=lcov --coverage-dir=<dir> tests/v2-tui-*.test.tsx
```

The resulting `lcov.info` contains `SF:lib/tui/dialogs.tsx`, `SF:lib/tui/ui.tsx`, and `SF:lib/v2/tui.tsx`, so machine-readable `.tsx` coverage is available.

**Limitations.** Bun's test coverage has no `--include` / `--test-coverage-include-all` equivalent. It reports only modules that were actually loaded (transitive `.ts` dependencies such as `lib/token-counter.ts` also appear, which makes the headline "All files" row misleading for TUI purposes). Bunfig supports `[test] coveragePathIgnorePatterns` (and `coverageThreshold`, `coverageSkipTestFiles`), so non-TUI files could be filtered out, but that is a global config change and is not necessary to get useful `.tsx` numbers. Crucially, never-loaded files (`lib/tui/modals.tsx`, root `tui.tsx`) cannot be reported at all — bun has no "include-all" mode.

## 3. Can Node coverage include `.tsx`, and is it meaningful?

Technically yes: adding a second flag

```
--test-coverage-include='lib/**/*.tsx'
```

to `test:coverage` makes Node report `lib/tui/dialogs.tsx`, `lib/tui/ui.tsx`, and `lib/v2/tui.tsx` (the latter actually loads under Node via `tests/v2-tui-slash.test.ts` + tsx).

It is **not meaningful as a quality signal**, because Node never renders the components. With `--test-coverage-include-all`, the same files show ~54% / ~46% / 72% lines and only 17% / 11% / 47% functions — they are imported but their component functions are never invoked. A second problem is that `lib/tui/modals.tsx` and root `tui.tsx` are never loaded by the Node suite, so even include-all does not list them. Adding `.tsx` to the Node include would therefore pull the headline numbers down with unexecuted JSX while telling us nothing about rendering behaviour. **Recommendation: leave `test:coverage` scoped to `lib/**/*.ts`.**

## 4. New test file

Created `tests/v2-tui-gaps.test.tsx` (bun-only, snapshot-free, deterministic). It adds four tests:

1. `PanelDialog` renders the supplied `blockedReason` when `canCompress` is false (closes the last uncovered branch in `dialogs.tsx`).
2. `lib/v2/tui.tsx` maps `rpc.dcp.notify` events to toasts: ignores empty events, applies defaults (`DCP` / `info` / 5000ms), and truncates >12-line messages with `... and N more`.
3. `setup()` installs no UI hooks when the server reports DCP disabled.
4. `setup()` degrades to headless (warns once) when host UI APIs are missing.

Result:

```
bun test tests/v2-tui-*.test.tsx        -> 6 pass, 0 fail
bun test --coverage tests/v2-tui-*.test.tsx tests/v2-tui-*.test.ts
                                        -> 15 pass, 0 fail
npm test                                -> 0 failures (268 Node unit tests,
                                           6 bun TUI tests, 8 logger tests)
```

## 5. Scripts in `package.json`

These lines are now landed in `package.json`:

```json
        "test:tui": "if command -v bun >/dev/null 2>&1; then bun test tests/v2-tui-*.test.tsx; else echo '[dcp] bun not found: TUI render tests skipped'; fi",
        "test:coverage": "node --import tsx --test --experimental-test-coverage --test-coverage-include='lib/**/*.ts' --test-coverage-include-all --test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=85 tests/*.test.ts",
        "test:coverage:tui": "if command -v bun >/dev/null 2>&1; then bun test --coverage tests/v2-tui-*.test.tsx tests/v2-tui-*.test.ts; else echo '[dcp] bun not found: TUI coverage skipped'; fi",
```

`test:tui` was changed from naming only `v2-tui-render.test.tsx` to the
`tests/v2-tui-*.test.tsx` glob so the new `v2-tui-gaps.test.tsx` runs in `npm test` / CI.
The `command -v bun` guard preserves the existing skip behaviour when bun is unavailable.
`test:coverage:tui` is informational only — no thresholds are applied to its "All files"
row (see recommendation below).

`test:coverage:tui` includes the two `.ts` v2 TUI tests because doing so raises `lib/v2/tui.tsx` line coverage from ~29.5% to ~51.7% without adding any new files.

## 6. Recommendation

Treat the TUI as **integration-tested (render-tested) via bun**, with a **separate coverage track** — not as unit-tested code folded into the Node coverage headline.

- Keep `test:coverage` on `lib/**/*.ts` only; do not add `.tsx` to it.
- Keep `test:tui` (globbed) as the correctness gate for rendering; it verifies the components mount against real OpenTUI renderables under both host theme shapes.
- Add `test:coverage:tui` as an informational, explicitly separate report. Do not apply global thresholds to the bun "All files" row — it includes transitive `.ts` dependencies that the TUI tests only load. If thresholds are wanted later, gate on the three `.tsx` rows (or an lcov post-filter) once `modals.tsx` / root `tui.tsx` are either tested or deleted as legacy.
- Remaining known gaps are intentional scope boundaries: the v1 `modals.tsx` + root `tui.tsx` path, and v2 panel navigation/error dialogs. These need host-API interaction tests (or a decision to drop the v1 path), not more unit assertions.
