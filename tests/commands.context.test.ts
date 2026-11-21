import assert from "node:assert/strict"
import "./lab/persistence-env"
import test, { afterEach, mock } from "node:test"
import {
    analyzeContextTokens,
    formatContextMessage,
    handleContextCommand,
} from "../lib/commands/context"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import { tokenCounter } from "../lib/token-counter"

afterEach(() => {
    mock.restoreAll()
})

function userMessage(id: string, created: number, text: string, ignored = false): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "ses_context_cmd",
            agent: "assistant",
            model: {
                providerID: "anthropic",
                modelID: "claude-test",
                variant: "default",
            },
            time: { created },
        },
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "ses_context_cmd",
                type: "text",
                text,
                ignored,
            },
        ],
    } as unknown as WithParts
}

function assistantMessage(
    id: string,
    created: number,
    tokens: { input: number; output: number; reasoning?: number; read?: number; write?: number },
    parts: any[] = [],
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "ses_context_cmd",
            agent: "assistant",
            time: { created },
            tokens: {
                input: tokens.input,
                output: tokens.output,
                reasoning: tokens.reasoning ?? 0,
                cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
            },
        },
        parts,
    } as unknown as WithParts
}

function toolPart(messageID: string, callID: string, tool: string, input?: any, output?: string) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID: "ses_context_cmd",
        type: "tool",
        tool,
        callID,
        state: {
            status: output === undefined ? "running" : "completed",
            input,
            output,
        },
    }
}

/** Makes token accounting exact and avoids spawning the tokenizer child process. */
function stubTokenCount(): void {
    mock.method(tokenCounter, "count", async (text: string) => text.length)
}

test("formatContextMessage renders all categories, percentages and pruning summary", () => {
    const message = formatContextMessage({
        system: 1000,
        user: 200,
        assistant: 300,
        tools: 500,
        toolCount: 4,
        toolsInContextCount: 3,
        prunedTokens: 750,
        prunedToolCount: 2,
        prunedMessageCount: 1,
        total: 2000,
    })

    assert.match(message, /DCP Context Analysis/)
    assert.match(message, /Session Context Breakdown:/)
    assert.match(message, /System\s+50\.0%\s+│█+.*1K tokens/)
    assert.match(message, /User\s+10\.0%\s+│▓+.*200 tokens/)
    assert.match(message, /Assistant\s+15\.0%\s+│▒+.*300 tokens/)
    assert.match(message, /Tools \(3\)\s+25\.0%\s+│░+.*500 tokens/)
    assert.match(message, /Pruned:\s+2 tools, 1 messages \(~750 tokens\)/)
    assert.match(message, /Current context: ~2K tokens/)
    assert.match(message, /Without DCP:\s+~2\.8K tokens/)
})

test("formatContextMessage handles an empty context and pruned tokens without items", () => {
    const empty = formatContextMessage({
        system: 0,
        user: 0,
        assistant: 0,
        tools: 0,
        toolCount: 0,
        toolsInContextCount: 0,
        prunedTokens: 0,
        prunedToolCount: 0,
        prunedMessageCount: 0,
        total: 0,
    })
    assert.doesNotMatch(empty, /NaN|Infinity|Pruned:/)
    assert.match(empty, /Current context: ~0 tokens/)
    assert.equal((empty.match(/0\.0%/g) ?? []).length, 4)

    const prunedOnly = formatContextMessage({
        system: 0,
        user: 0,
        assistant: 0,
        tools: 0,
        toolCount: 0,
        toolsInContextCount: 0,
        prunedTokens: 100,
        prunedToolCount: 0,
        prunedMessageCount: 0,
        total: 0,
    })
    assert.match(prunedOnly, /Pruned:\s+\(~100 tokens\)/)
    assert.match(prunedOnly, /Without DCP:\s+~100 tokens/)
})

test("analyzeContextTokens separates system/user/tool/assistant usage and pruned items", async () => {
    stubTokenCount()
    const state = createSessionState()
    state.lastCompaction = 100
    state.stats.totalPruneTokens = 99
    state.prune.tools.set("call-pruned", 99)
    state.prune.messages.byMessageId.set("msg-pruned", {
        tokenCount: 20,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const messages: WithParts[] = [
        // Compacted by timestamp: its huge token counts must not seed the breakdown.
        assistantMessage("msg-old", 1, { input: 99999, output: 99999 }),
        userMessage("msg-user", 101, "hello"),
        assistantMessage("msg-first", 102, { input: 100, output: 5, read: 20, write: 30 }),
        // DCP notification: ignored user text must not be counted.
        userMessage("msg-notification", 103, "▣ DCP synthetic notice", true),
        assistantMessage(
            "msg-tools",
            104,
            { input: 200, output: 40, reasoning: 10, read: 20, write: 30 },
            [
                toolPart("msg-tools", "call-1", "bash", { a: 1 }, "result"),
                toolPart("msg-tools", "call-2", "grep"),
                toolPart("msg-tools", "call-pruned", "bash", { secret: true }, "hidden"),
            ],
        ),
        // A later assistant with no output is not used as the last assistant.
        assistantMessage("msg-no-output", 105, { input: 500, output: 0 }),
        userMessage("msg-pruned", 106, "compacted question"),
    ]
    // Give the pruned message a tool so message-level pruning is counted too.
    messages[6]!.parts.push(toolPart("msg-pruned", "call-pruned-msg", "read"))

    const breakdown = await analyzeContextTokens(state, messages)

    assert.equal(breakdown.total, 300)
    assert.equal(breakdown.user, 5)
    assert.equal(breakdown.system, 145)
    assert.equal(breakdown.tools, 13)
    assert.equal(breakdown.assistant, 137)
    assert.equal(breakdown.toolCount, 4)
    assert.equal(breakdown.toolsInContextCount, 2)
    assert.equal(breakdown.prunedToolCount, 2)
    assert.equal(breakdown.prunedMessageCount, 1)
    assert.equal(breakdown.prunedTokens, 99)
})

test("analyzeContextTokens tolerates messages without token accounting or parts", async () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        { info: { id: "msg-u", role: "user", time: { created: 1 } }, parts: [] } as any,
        { info: { id: "msg-a", role: "assistant", time: { created: 2 } }, parts: undefined } as any,
    ]

    const breakdown = await analyzeContextTokens(state, messages)

    assert.equal(breakdown.total, 0)
    assert.equal(breakdown.system, 0)
    assert.equal(breakdown.user, 0)
    assert.equal(breakdown.tools, 0)
    assert.equal(breakdown.assistant, 0)
    assert.equal(breakdown.toolCount, 0)
})

test("handleContextCommand sends a no-reply ignored message using the current params", async () => {
    stubTokenCount()
    const sent: any[] = []
    const client = {
        session: {
            prompt: async (input: any) => {
                sent.push(input)
                return {}
            },
        },
    }
    const state = createSessionState()
    const logger = new Logger(false)
    const messages: WithParts[] = [
        userMessage("msg-user", 1, "question"),
        assistantMessage("msg-assistant", 2, { input: 100, output: 20, read: 10, write: 10 }),
    ]

    await handleContextCommand({ client, state, logger, sessionId: "ses_context_cmd", messages })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].path.id, "ses_context_cmd")
    assert.equal(sent[0].body.noReply, true)
    assert.equal(sent[0].body.parts[0].ignored, true)
    assert.equal(sent[0].body.parts[0].synthetic, true)
    assert.match(sent[0].body.parts[0].text, /^▣ DCP\n╭─+╮\n│\s+DCP Context Analysis/)
    assert.equal(sent[0].body.agent, "assistant")
    assert.deepEqual(sent[0].body.model, {
        providerID: "anthropic",
        modelID: "claude-test",
    })
    assert.equal(sent[0].body.variant, "default")
})
