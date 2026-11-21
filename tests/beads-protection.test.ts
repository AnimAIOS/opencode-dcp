import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import { deduplicate } from "../lib/strategies/deduplication"
import { purgeErrors } from "../lib/strategies/purge-errors"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    extractProtectedPromptInfo,
} from "../lib/compress/protected-content"
import { isToolProtected, type BeadsProtection } from "../lib/protected-patterns"

const ACTIVE: BeadsProtection = { active: true, prefix: "opencode-dcp" }
const OFF: BeadsProtection = { active: false, prefix: "opencode-dcp" }
const NOT_DETECTED: BeadsProtection = { active: false, prefix: null }

function userMessage(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", time: { created: 1 } },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

function toolMessage(id: string, command: string, output: string): WithParts {
    return {
        info: { id, role: "assistant", time: { created: 2 } },
        parts: [
            {
                type: "tool",
                tool: "bash",
                callID: `${id}-call`,
                state: {
                    status: "completed",
                    input: { command },
                    output,
                },
            },
        ],
    } as unknown as WithParts
}

async function selectionFor(messages: WithParts[]) {
    const state = createSessionState()
    const context = buildSearchContext(state, messages)
    const boundary = { kind: "message" as const, rawIndex: 0, messageId: messages[0].info.id }
    const selection = await resolveSelection(context, boundary, boundary)
    return { state, context, selection }
}

test("bash calls containing a bd subcommand are protected only when Beads is active", () => {
    const command = "bd show opencode-dcp-39l.3 --json"
    assert.equal(isToolProtected("bash", { command }, [], [], undefined, ACTIVE), true)
    assert.equal(isToolProtected("shell", { command: "bd ready --json" }, [], [], undefined, ACTIVE), true)
    assert.equal(isToolProtected("bash", { command: "echo hello" }, [], [], undefined, ACTIVE), false)
    assert.equal(isToolProtected("bash", { command }, [], [], undefined, OFF), false)
    assert.equal(isToolProtected("bash", { command }, [], [], undefined, NOT_DETECTED), false)
    assert.equal(isToolProtected("bash", { command }, [], [], undefined), false)
    assert.equal(isToolProtected("read", { filePath: "x" }, [], [], undefined, ACTIVE), false)
})

test("all bd subcommands are recognised", () => {
    for (const sub of ["create", "show", "ready", "update", "dep", "close"]) {
        assert.equal(
            isToolProtected("bash", { command: `bd ${sub} opencode-dcp-39l` }, [], [], undefined, ACTIVE),
            true,
            `subcommand ${sub} was not protected`,
        )
    }
})

test("a bd show tool output is retained through appendProtectedTools", async () => {
    const messages = [
        toolMessage("m1", "bd show opencode-dcp-39l.3 --json", "BD_OUTPUT_TICKET_BODY"),
    ]
    const { state, context, selection } = await selectionFor(messages)
    const summary = await appendProtectedTools(
        {},
        state,
        false,
        "SUMMARY",
        selection,
        context,
        [],
        [],
        ACTIVE,
    )
    assert.match(summary, /BD_OUTPUT_TICKET_BODY/)
})

test("bd bash outputs are not retained when Beads is off or not detected", async () => {
    for (const beads of [OFF, NOT_DETECTED, undefined]) {
        const messages = [toolMessage("m1", "bd show opencode-dcp-39l.3", "BD_OUTPUT_TICKET_BODY")]
        const { state, context, selection } = await selectionFor(messages)
        const summary = await appendProtectedTools(
            {},
            state,
            false,
            "SUMMARY",
            selection,
            context,
            [],
            [],
            beads,
        )
        assert.equal(summary, "SUMMARY")
    }
})

test("a user message containing a bead ID is retained through appendProtectedPromptInfo", async () => {
    const messages = [userMessage("m1", "Continue work on opencode-dcp-39l.3 next.")]
    const { state, context, selection } = await selectionFor(messages)
    // Beads protection is independent of the protectTags flag (off by default).
    const summary = appendProtectedPromptInfo("SUMMARY", selection, context, state, false, ACTIVE)
    assert.match(summary, /opencode-dcp-39l\.3/)
})

test("only the configured or detected prefix is matched, not a foreign one", async () => {
    const messages = [userMessage("m1", "Continue work on opencode-dcp-39l.3 next.")]
    const { state, context, selection } = await selectionFor(messages)
    const foreign: BeadsProtection = { active: true, prefix: "vi" }
    const summary = appendProtectedPromptInfo("SUMMARY", selection, context, state, false, foreign)
    assert.equal(summary, "SUMMARY")
})

test("--skills fields survive verbatim", async () => {
    const text = [
        "Handing off:",
        "bd update opencode-dcp-39l.3 --skills implement,tdd,code-review",
        "--skills grilling,to-spec",
    ].join("\n")
    const info = extractProtectedPromptInfo(text, ACTIVE)
    assert.ok(info.includes("--skills implement,tdd,code-review"))
    assert.ok(info.includes("--skills grilling,to-spec"))

    const messages = [userMessage("m1", text)]
    const { state, context, selection } = await selectionFor(messages)
    const summary = appendProtectedPromptInfo("SUMMARY", selection, context, state, false, ACTIVE)
    assert.match(summary, /--skills implement,tdd,code-review/)
    assert.match(summary, /--skills grilling,to-spec/)
})

test("bd command lines are lifted out of user messages", () => {
    const info = extractProtectedPromptInfo("Please run `bd show opencode-dcp-39l` for details.", ACTIVE)
    assert.ok(info.some((line) => line.includes("bd show opencode-dcp-39l")))
})

test("Beads prompt info is not lifted when Beads is off or not detected", async () => {
    const messages = [
        userMessage("m1", "opencode-dcp-39l.3\nbd show opencode-dcp-39l\n--skills implement"),
    ]
    for (const beads of [OFF, NOT_DETECTED, undefined]) {
        const { state, context, selection } = await selectionFor(messages)
        const summary = appendProtectedPromptInfo("SUMMARY", selection, context, state, false, beads)
        assert.equal(summary, "SUMMARY")
    }
})

test("bd bash calls are not pruned by the automatic strategies when Beads is active", () => {
    const logger = new Logger(false)
    const config = {
        manualMode: { automaticStrategies: true },
        protectedFilePatterns: [],
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 1, protectedTools: [] },
        },
    } as PluginConfig

    function pruneWith(beads: BeadsProtection | undefined) {
        const state = createSessionState()
        state.currentTurn = 10
        state.toolIdList = ["c1"]
        state.toolParameters.set("c1", {
            tool: "bash",
            parameters: { command: "bd show opencode-dcp-39l" },
            status: "error",
            turn: 1,
            tokenCount: 10,
        })
        deduplicate(state, logger, config, [], beads)
        purgeErrors(state, logger, config, [], beads)
        return state.prune.tools.size
    }

    assert.equal(pruneWith(ACTIVE), 0)
    assert.equal(pruneWith(OFF), 1)
    assert.equal(pruneWith(undefined), 1)
})
