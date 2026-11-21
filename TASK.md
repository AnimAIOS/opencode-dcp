# TASK: Tight integration with TokenEconomizer microskills and Beads

## Context

DCP is one layer in a larger agent stack:

- **TokenEconomizer (TE)** learns per-repo facts and a repomap, and injects them into the
  system prompt at session start. On OpenCode 2.x it pushes a system part via
  `ctx.session.hook("context")` containing the "manual" (facts + repomap).
- **Beads (`bd`)** is the durable issue tracker. Work is a graph of epics/tickets with
  `--skills` fields; `bd-drive` routes ready beads to skills and closes them.
- **DCP** compresses conversation history, prunes superseded tool outputs, and appends its
  own system prompt. It currently knows nothing about either TE or Beads.

These layers already coexist (both TE and DCP append to `event.system` rather than replacing
it), but the integration is accidental. This task makes it explicit and safe.

## Goal

Make DCP preserve and cooperate with TE's learned context and Beads' working state, so
compression never destroys the facts, ticket IDs, or skill contracts the agent needs.

## Non-goals

- Reimplementing TE's fact learning or Beads' tracker.
- Calling model APIs from DCP.
- Changing DCP's default compression strategies.

## Current behaviour (verified in this checkout)

- `lib/v2/index.ts` `ctx.session.hook("context")`: reads `event.system.map(p => p.text)`,
  appends DCP's prompt via `createSystemPromptHandler`, writes parts back with
  `...event.system[index]`. TE's injected part survives, but only by accident of ordering.
- `createSystemPromptHandler` (`lib/hooks.ts`) appends to the last system string.
- `extractProtectedPromptInfo` (`lib/compress/protected-content.ts`) only honours
  `<protect>…</protect>` tags in user messages.
- `isToolProtected` (`lib/protected-patterns.ts`) matches tool names/globs, not command content.
- `buildPriorityMap` (`lib/messages/priority.ts`) scores messages for pruning but knows nothing
  about beads or learned facts.

## Work items

### 1. Protect the TE manual as a named system part

- Detect TE's injected part (agree a stable marker with TE, e.g. `<tokeneconomizer-manual>`;
  fall back to matching its `TokenEconomizer --` header for unmarked older versions).
- In `lib/v2/index.ts` and `createSystemPromptHandler`, keep that part intact and never
  reorder it below DCP's own prompt. Do not copy it into a compression summary — it already
  lives in every request's system prompt; duplicating it wastes tokens.
- Include its token count in `state.systemPromptTokens` so DCP's context accounting is honest.

### 2. Protect Beads references from pruning

- Extend `isToolProtected` so a `bash` call whose command contains `bd ` (create / show /
  ready / update / dep / close) is protected by default when Beads is detected.
- Extend `extractProtectedPromptInfo` to lift bead IDs and `bd …` command lines out of user
  messages into the compression summary, so a compacted session still knows which ticket it
  is working. Match the configured bead prefix rather than a hardcoded one.
- Preserve `--skills` fields verbatim: they are the handoff contract to the skill router.

### 3. Beads-aware priority signals

- In `buildPriorityMap`, boost messages that reference an **open or in-progress** bead.
  Read bead state read-only via `bd ready --json` / `bd show <id>` when Beads is detected;
  never mutate the tracker from DCP.
- Do not boost closed beads — their conversation can be compressed freely.

### 4. TE-aware priority signals

- When TE facts are present, boost messages that mention those fact patterns so the evidence
  for a learned fact is not pruned while the fact is still active.
- Emit a small, machine-readable compression digest at the end of a summary
  (`<!-- dcp-compress: <n> messages, <m> tool outputs -->`). This is free for TE's fact
  proposer to read from the session export and lets it learn which pruning helps.

### 5. Configuration

Add an `integrations` block to `dcp.schema.json` and `lib/config.ts`:

```jsonc
"integrations": {
  "tokenEconomizer": "auto", // auto | off
  "beads": "auto",            // auto | off
  "beadsPrefix": null         // null = detect from .beads metadata
}
```

`auto` = enable only when the integration is detected in the current project. Default to
off when not detected. No new required settings.

### 6. Tests

- TE system part survives `createSystemPromptHandler` and the v2 context mapping, with its
  text byte-identical and not duplicated in any summary.
- A `bd show vi-…` tool output is retained through `appendProtectedTools`.
- A user message containing a bead ID is retained through `appendProtectedPromptInfo`.
- `buildPriorityMap` ranks messages referencing open beads above equivalent ones referencing
  closed beads.
- All new behaviour is off by default and when integrations are set to `off`.

## Acceptance criteria

- [ ] DCP does not drop, reorder, or duplicate TE's manual.
- [ ] Bead IDs, `--skills` fields, and `bd` tool outputs survive compression.
- [ ] Open-bead references are protected; closed ones are not.
- [ ] No new required config; detection is automatic and reversible with `off`.
- [ ] Tests pass, including the "off" cases.

## Risks / out of scope

- Shelling out to `bd` from a plugin adds a dependency on the CLI; keep it read-only,
  short-timeout, and fail-open.
- TE's marker is not yet stable; the header fallback must be cheap and must not false-positive
  on ordinary text.
- Compressed summaries are part of every subsequent request — keep any added digest tiny.
