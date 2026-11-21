import assert from "node:assert/strict"
import "./lab/persistence-env"
import test, { describe } from "node:test"
import { createCompressMessageTool } from "../lib/compress/message"
import type { ToolContext } from "../lib/compress/types"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts, type SessionState } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    extractProtectedPromptInfo,
} from "../lib/compress/protected-content"
import { isToolProtected, type BeadsProtection } from "../lib/protected-patterns"
import { createSystemPromptHandler } from "../lib/hooks"
import { placeSystemPrompt, mapSystemTextsToParts, stripTokenEconomizerManual, TOKEN_ECONOMIZER_MARKER, countSystemPromptTokens } from "../lib/integrations"
import { buildPriorityMap } from "../lib/messages/priority"
import type { PromptStore } from "../lib/prompts"

const TE_PART = `${TOKEN_ECONOMIZER_MARKER}\n- repo: DCP prunes tool outputs\n- fact: bd is the tracker\n</tokeneconomizer-manual>`
const OTHER_PART = "ordinary system prompt"
const ACTIVE: BeadsProtection = { active: true, prefix: "opencode-dcp" }
const OFF: BeadsProtection = { active: false, prefix: "opencode-dcp" }
const NOT_DETECTED: BeadsProtection = { active: false, prefix: null }

function buildConfig(tokenEconomizer: "auto" | "off", beads: "auto" | "off" = "off"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        integrations: { tokenEconomizer, beads, beadsPrefix: null },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
    } as PluginConfig
}

function prompts(): PromptStore {
    return {
        reload() {},
        getRuntimePrompts: () => ({
            system: "DCP OWN PROMPT",
            manualExtension: "",
            subagentExtension: "",
        }),
    } as unknown as PromptStore
}

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

function buildMessage(id: string, role: "user" | "assistant", sessionID: string, text: string, created: number): WithParts {
    return {
        info: {
            id,
            role,
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
        },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

function e2eRawMessages(sessionID: string, userText: string, toolOutput: string | null): WithParts[] {
    const msgs: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            },
            parts: [{ type: "text", text: userText }],
        } as unknown as WithParts,
    ]
    if (toolOutput !== null) {
        msgs.push({
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            },
            parts: [
                {
                    type: "tool",
                    tool: "bash",
                    callID: "call-bd-1",
                    state: {
                        status: "completed",
                        input: { command: "bd show opencode-dcp-39l.3" },
                        output: toolOutput,
                    },
                },
            ],
        } as unknown as WithParts)
    }
    return msgs
}

async function runCompression(
    sessionID: string,
    rawMessages: WithParts[],
    config: PluginConfig,
    beads: BeadsProtection | undefined,
    content: { messageId: string; topic: string; summary: string }[],
    topic = "Beads acceptance",
): Promise<SessionState> {
    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
        beads,
    } as unknown as ToolContext)
    await tool.execute(
        { topic, content },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-e2e",
        },
    )
    return state
}

describe("acceptance: TE manual survival across a compression cycle", () => {
    test("createSystemPromptHandler keeps TE part byte-identical and DCP below it", async () => {
        const state = createSessionState()
        const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("auto", "off"), prompts())
        const output = { system: [TE_PART] }
        await handler({ sessionID: "session-1", model: { limit: { context: 200000 } } }, output)
        assert.equal(output.system[0], TE_PART)
        assert.equal(output.system.length, 2)
        assert.ok(output.system.indexOf(TE_PART) < output.system.findIndex((s) => s.includes("DCP OWN PROMPT")))
    })

    test("placeSystemPrompt keeps TE part byte-identical and ordered above DCP", () => {
        const result = placeSystemPrompt([OTHER_PART, TE_PART], "DCP OWN PROMPT", { tokenEconomizer: true })
        assert.equal(result.tePreserved, true)
        assert.equal(result.system[1], TE_PART)
        assert.ok(result.system.indexOf(TE_PART) < result.system.indexOf("DCP OWN PROMPT"))
    })

    test("v2 context mapping preserves part metadata and TE ordering", () => {
        const original = [
            { type: "text", text: TE_PART, metadata: { source: "tokeneconomizer" } },
            { type: "text", text: OTHER_PART, metadata: { source: "agent" } },
        ]
        const finalTexts = [TE_PART, OTHER_PART, "DCP OWN PROMPT"]
        const mapped = mapSystemTextsToParts(original, finalTexts)
        assert.equal(mapped[0].text, TE_PART)
        assert.deepEqual(mapped[0].metadata, { source: "tokeneconomizer" })
        assert.equal(mapped[2].text, "DCP OWN PROMPT")
    })

    test("summary generation strips a copied TE manual so it is not duplicated", () => {
        const summary = `Kept the old tool outputs.\n${TE_PART}\nAlso noted:\n${TE_PART}`
        const stripped = stripTokenEconomizerManual(summary)
        assert.ok(!stripped.includes(TOKEN_ECONOMIZER_MARKER))
        assert.ok(stripped.includes("Kept the old tool outputs."))
    })

    test("token accounting includes the TE part", async () => {
        const withoutTE = await countSystemPromptTokens([OTHER_PART])
        const withTE = await countSystemPromptTokens([OTHER_PART, TE_PART])
        assert.ok(withTE > withoutTE)
    })
})

describe("acceptance: Bead IDs, --skills, and bd outputs survive compression", () => {
    test("a bd show tool output is retained through appendProtectedTools", async () => {
        const messages = [toolMessage("m1", "bd show opencode-dcp-39l.3 --json", "BD_OUTPUT_TICKET_BODY")]
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

    test("a user message bead ID is retained through appendProtectedPromptInfo", async () => {
        const messages = [userMessage("m1", "Continue work on opencode-dcp-39l.3 next.")]
        const { state, context, selection } = await selectionFor(messages)
        const summary = appendProtectedPromptInfo("SUMMARY", selection, context, state, false, ACTIVE)
        assert.match(summary, /opencode-dcp-39l\.3/)
    })

    test("--skills fields survive verbatim", () => {
        const text = [
            "Handing off:",
            "bd update opencode-dcp-39l.3 --skills implement,tdd,code-review",
            "--skills grilling,to-spec",
        ].join("\n")
        const info = extractProtectedPromptInfo(text, ACTIVE)
        assert.ok(info.includes("--skills implement,tdd,code-review"))
        assert.ok(info.includes("--skills grilling,to-spec"))
    })

    test("bd command lines are lifted out of user messages", () => {
        const info = extractProtectedPromptInfo("Please run `bd show opencode-dcp-39l` for details.", ACTIVE)
        assert.ok(info.some((line) => line.includes("bd show opencode-dcp-39l")))
    })
})

describe("acceptance: open-bead references protected, closed not", () => {
    test("buildPriorityMap ranks open-bead messages above closed-bead messages", async () => {
        const sessionID = "ses_acceptance_priority"
        const messages: WithParts[] = [
            buildMessage("msg-open", "user", sessionID, "Continue work on opencode-dcp-1 please.", 1),
            buildMessage("msg-closed", "user", sessionID, "Continue work on opencode-dcp-2 please.", 2),
        ]
        const state = createSessionState()
        const config = buildConfig("auto", "auto")
        assignMessageRefs(state, messages)
        const priorities = await buildPriorityMap(config, state, messages, {
            directory: process.cwd(),
            beads: { active: true, prefix: "opencode-dcp" },
            systemParts: [TE_PART],
            run: async () => JSON.stringify([
                { id: "opencode-dcp-1", status: "open" },
                { id: "opencode-dcp-2", status: "closed" },
            ]),
        })
        assert.equal(priorities.get("msg-open")?.priority, "high")
        assert.notEqual(priorities.get("msg-closed")?.priority, "high")
    })

    test("combined run with TE active still distinguishes open vs closed beads", async () => {
        const sessionID = "ses_acceptance_combined"
        const messages: WithParts[] = [
            buildMessage("msg-open", "user", sessionID, "Continue work on opencode-dcp-1 please. bd is the tracker", 1),
            buildMessage("msg-closed", "user", sessionID, "Continue work on opencode-dcp-2 please.", 2),
        ]
        const state = createSessionState()
        const config = buildConfig("auto", "auto")
        assignMessageRefs(state, messages)
        const priorities = await buildPriorityMap(config, state, messages, {
            directory: process.cwd(),
            beads: { active: true, prefix: "opencode-dcp" },
            systemParts: [TE_PART],
            run: async () => JSON.stringify([
                { id: "opencode-dcp-1", status: "open" },
                { id: "opencode-dcp-2", status: "closed" },
            ]),
        })
        assert.equal(priorities.get("msg-open")?.priority, "high")
        assert.notEqual(priorities.get("msg-closed")?.priority, "high")
    })
})

describe("acceptance: off by default and when off", () => {
    test("no integrations config: bd tool outputs not retained", async () => {
        const messages = [toolMessage("m1", "bd show opencode-dcp-39l.3", "BD_OUTPUT_TICKET_BODY")]
        const { state, context, selection } = await selectionFor(messages)
        const config = buildConfig("off", "off")
        delete (config as unknown as Record<string, unknown>).integrations
        const summary = await appendProtectedTools(
            {},
            state,
            false,
            "SUMMARY",
            selection,
            context,
            [],
            [],
            undefined,
        )
        assert.equal(summary, "SUMMARY")
    })

    test("no integrations config: bead IDs not lifted", async () => {
        const messages = [userMessage("m1", "opencode-dcp-39l.3\nbd show opencode-dcp-39l\n--skills implement")]
        const { state, context, selection } = await selectionFor(messages)
        const summary = appendProtectedPromptInfo("SUMMARY", selection, context, state, false, undefined)
        assert.equal(summary, "SUMMARY")
    })

    test("no integrations config: isToolProtected false for bd bash", () => {
        assert.equal(isToolProtected("bash", { command: "bd show opencode-dcp-39l" }, [], [], undefined, undefined), false)
    })

    test("no integrations config: createSystemPromptHandler appends to last part", async () => {
        const state = createSessionState()
        const config = buildConfig("off", "off")
        delete (config as unknown as Record<string, unknown>).integrations
        const handler = createSystemPromptHandler(state, new Logger(false), config, prompts())
        const output = { system: [TE_PART] }
        await handler({ sessionID: "session-1", model: { limit: { context: 200000 } } }, output)
        assert.deepEqual(output.system, [`${TE_PART}\n\nDCP OWN PROMPT`])
    })

    test("no integrations config: buildPriorityMap does not boost", async () => {
        const sessionID = "ses_off_default"
        const messages: WithParts[] = [
            buildMessage("msg-open", "user", sessionID, "Continue work on opencode-dcp-1 please.", 1),
        ]
        const state = createSessionState()
        const config = buildConfig("off", "off")
        delete (config as unknown as Record<string, unknown>).integrations
        assignMessageRefs(state, messages)
        const priorities = await buildPriorityMap(config, state, messages, {
            directory: process.cwd(),
            systemParts: [TE_PART],
            run: async () => JSON.stringify([{ id: "opencode-dcp-1", status: "open" }]),
        })
        assert.notEqual(priorities.get("msg-open")?.priority, "high")
    })

    test("explicit off: bd tool outputs not retained", async () => {
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
            OFF,
        )
        assert.equal(summary, "SUMMARY")
    })

    test("explicit off: bead IDs not lifted", async () => {
        const messages = [userMessage("m1", "opencode-dcp-39l.3\nbd show opencode-dcp-39l\n--skills implement")]
        const { state, context, selection } = await selectionFor(messages)
        const summary = appendProtectedPromptInfo("SUMMARY", selection, context, state, false, OFF)
        assert.equal(summary, "SUMMARY")
    })

    test("explicit off: isToolProtected false for bd bash", () => {
        assert.equal(isToolProtected("bash", { command: "bd show opencode-dcp-39l" }, [], [], undefined, OFF), false)
    })

    test("explicit off: createSystemPromptHandler appends to last part", async () => {
        const state = createSessionState()
        const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("off", "off"), prompts())
        const output = { system: [TE_PART] }
        await handler({ sessionID: "session-1", model: { limit: { context: 200000 } } }, output)
        assert.deepEqual(output.system, [`${TE_PART}\n\nDCP OWN PROMPT`])
    })

    test("explicit off: buildPriorityMap does not boost", async () => {
        const sessionID = "ses_off_explicit"
        const messages: WithParts[] = [
            buildMessage("msg-open", "user", sessionID, "Continue work on opencode-dcp-1 please.", 1),
        ]
        const state = createSessionState()
        const config = buildConfig("off", "off")
        assignMessageRefs(state, messages)
        const priorities = await buildPriorityMap(config, state, messages, {
            directory: process.cwd(),
            beads: { active: true, prefix: "opencode-dcp" },
            systemParts: [TE_PART],
            run: async () => JSON.stringify([{ id: "opencode-dcp-1", status: "open" }]),
        })
        assert.notEqual(priorities.get("msg-open")?.priority, "high")
    })

    test("explicit off: no digest appended when TE inactive", async () => {
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
            OFF,
            undefined,
            false,
        )
        assert.ok(!summary.includes("<!-- dcp-compress:"))
    })
})

describe("acceptance: compression digest present when TE active", () => {
    test("appendProtectedTools appends digest when TE active", async () => {
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
            ACTIVE,
            selection.messageIds.length,
            true,
        )
        assert.match(summary, /<!-- dcp-compress: 1 messages, 1 tool outputs -->/)
    })

    test("appendProtectedTools appends digest even without protected outputs when TE active", async () => {
        const messages = [toolMessage("m1", "echo hello", "HELLO")]
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
            selection.messageIds.length,
            true,
        )
        assert.match(summary, /<!-- dcp-compress:/)
    })
})

describe("acceptance: e2e compression cycle (beads + TE)", () => {
    test("beads ACTIVE: bd output and bead ID retained in stored block", async () => {
        const sessionID = `ses_e2e_beads_active_${Date.now()}`
        const rawMessages = e2eRawMessages(sessionID, "Continue work on opencode-dcp-39l.3 next.", "BD_OUTPUT_TICKET_BODY")
        const config = buildConfig("auto", "auto")
        const state = await runCompression(sessionID, rawMessages, config, ACTIVE, [
            { messageId: "m0001", topic: "User bead", summary: "Captured user bead reference." },
            { messageId: "m0002", topic: "Bd output", summary: "Captured bd output." },
        ])
        const summaries = Array.from(state.prune.messages.blocksById.values())
            .map((b) => b.summary)
            .join("\n")
        assert.match(summaries, /BD_OUTPUT_TICKET_BODY/)
        assert.match(summaries, /opencode-dcp-39l\.3/)
    })

    test("off by default: no integrations config, beads undefined => bd output not retained", async () => {
        const sessionID = `ses_e2e_off_default_${Date.now()}`
        const rawMessages = e2eRawMessages(sessionID, "Continue work on opencode-dcp-39l.3 next.", "BD_OUTPUT_TICKET_BODY")
        const config = buildConfig("off", "off")
        delete (config as unknown as Record<string, unknown>).integrations
        const state = await runCompression(sessionID, rawMessages, config, undefined, [
            { messageId: "m0001", topic: "User bead", summary: "Captured user bead reference." },
            { messageId: "m0002", topic: "Bd output", summary: "Captured bd output." },
        ])
        const summaries = Array.from(state.prune.messages.blocksById.values())
            .map((b) => b.summary)
            .join("\n")
        assert.ok(!summaries.includes("BD_OUTPUT_TICKET_BODY"))
    })

    test("explicit off: beads OFF => bd output not retained", async () => {
        const sessionID = `ses_e2e_off_explicit_${Date.now()}`
        const rawMessages = e2eRawMessages(sessionID, "Continue work on opencode-dcp-39l.3 next.", "BD_OUTPUT_TICKET_BODY")
        const config = buildConfig("off", "off")
        const state = await runCompression(sessionID, rawMessages, config, OFF, [
            { messageId: "m0001", topic: "User bead", summary: "Captured user bead reference." },
            { messageId: "m0002", topic: "Bd output", summary: "Captured bd output." },
        ])
        const summaries = Array.from(state.prune.messages.blocksById.values())
            .map((b) => b.summary)
            .join("\n")
        assert.ok(!summaries.includes("BD_OUTPUT_TICKET_BODY"))
    })

    test("TE manual not duplicated when TE active", async () => {
        const sessionID = `ses_e2e_te_manual_${Date.now()}`
        const rawMessages = e2eRawMessages(
            sessionID,
            `Notes\n${TE_PART}\nend`,
            "BD_OUTPUT_TICKET_BODY",
        )
        const config = buildConfig("auto", "off")
        const state = await runCompression(sessionID, rawMessages, config, undefined, [
            { messageId: "m0001", topic: "User note", summary: `Kept notes.\n${TE_PART}` },
        ])
        const summaries = Array.from(state.prune.messages.blocksById.values())
            .map((b) => b.summary)
            .join("\n")
        assert.ok(!summaries.includes(TOKEN_ECONOMIZER_MARKER))
    })

    test("digest present when TE active", async () => {
        const sessionID = `ses_e2e_digest_${Date.now()}`
        const rawMessages = e2eRawMessages(sessionID, "Continue work on opencode-dcp-39l.3 next.", "BD_OUTPUT_TICKET_BODY")
        const config = buildConfig("auto", "auto")
        const state = await runCompression(sessionID, rawMessages, config, ACTIVE, [
            { messageId: "m0001", topic: "User bead", summary: "Captured user bead reference." },
            { messageId: "m0002", topic: "Bd output", summary: "Captured bd output." },
        ])
        const summaries = Array.from(state.prune.messages.blocksById.values())
            .map((b) => b.summary)
            .join("\n")
        assert.match(summaries, /<!-- dcp-compress:/)
    })
})
