# Upstream PRs merged into this fork (branch merge-good-prs, base cf5e728)

| PR | Title | Merge commit | Notes |
|---|---|---|---|
| #639 | fix: reuse one tokenizer instead of building one per countTokens call | 71946d7 | fork tokenizer reuse retained |
| #616 | fix: coerce mis-wrapped compress content args and teach format on rejection | 8fabfcf | |
| #569 | fix: move assignMessageRefs after prune to prevent orphan alias leak | 89f5e51 | |
| #628 | fix: register /dcp-compress in the OpenCode v2 slash palette | 1f6656d | |
| #627 | Opencode v2 compatibility improvements | da1658b | resolved conflicts |
| #607 | fix: persist modelContextLimit, skip min-threshold when unknown, percentage defaults, keep blocks active across restarts | dd0ad8f | resolved conflicts; fork 85%/60% defaults kept |
| #597 | fix: preserve per-round subagent task results on resume | cf5e728 | |
| #582 | fix: account for current context growth in token usage | a52cee4 | |
| #564 | fix: stale stats and incorrect token breakdown after Compaction | d9af28e | |
| #648 | chore(scripts): remove unreferenced Python analysis CLIs | 0064525 | |
| #669 | fix(v2): avoid blocking TUI setup on RPC and prevent inotify watcher loop | fde5a41 | |
| #671 | fix(config): default context limits to a share of the model window | a2e773f | |
| #670 | fix: resolve the model context limit before injecting nudges on a fresh process | 5694968 | |
| #660 | Count tokens in a killable child process so a slow encode cannot block OpenCode | 1da4c63 | async token counting threaded through |
| #559 | feat: delete session state file when session is deleted | fb22bee | deleteSessionState retained |
| #510 | Harden DCP chat transforms and clarify compacted output | 6ee964a | model context limit resolution restored; turnNudgeAnchors expectation updated |
| #473 | all time stats tweaks | 129c14e | rpc schema updated for allTime stats |
| #663 | perf: reuse one tokenizer and bound the cost of counting huge inputs | a6ce759 | kept fork tokenizer reuse + bounded counting |

Not merged:
- #594 — conflicts in compress/message.ts, range.ts, config.ts (open upstream)
- #647 — upstream draft (tool-result preservation on reused call IDs)
- #649 — refactor would collapse fork helpers (persistedLoadFailed guard, tokenUsageEstimate memo, exclusive/owners)
- #651 — peer-dependency move breaks installed import paths (@opencode/ai/schema/messages)
- #656 — conflict surface unmanageable (34 files, ~104 conflicts)
- #621 — conflict surface unmanageable (48 files, ~15 conflicts)
- #589 — not an ancestor of HEAD (pr-589 tip not merged into this branch; verified via git merge-base --is-ancestor exit 1)
- #530 — open upstream (not merged)
- #525 — upstream draft (not merged)
