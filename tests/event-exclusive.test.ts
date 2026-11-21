// Regression: the v1 `event` hook mutates shared compressionTiming / prune.messages
// duration state and saves, so it must take the same exclusive() lock as the other
// shared-state hooks. This pins the interleaving where a chat transform holds the
// lock while suspended in token counting and compress-part events are delivered.
import assert from "node:assert/strict"
import test from "node:test"
import "./lab/persistence-env"
import { tokenCounter } from "../lib/token-counter"
import type { PluginConfig } from "../lib/config"
import { createEventHandler, createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    exclusive,
    loadSessionState,
    saveSessionState,
    type WithParts,
} from "../lib/state"

interface Deferred<T> {
    promise: Promise<T>
    resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
}

// --- Deterministic gate on the shared tokenizer -------------------------------
// Only text carrying the marker blocks; everything else resolves in a microtask.
const gates = new Map<string, Deferred<void>>()
const entered = new Map<string, Deferred<void>>()
tokenCounter.count = async (text: string): Promise<number> => {
    for (const [marker, gate] of [...gates]) {
        if (text.includes(marker)) {
            gates.delete(marker)
            entered.get(marker)?.resolve()
            await gate.promise
        }
    }
    return text.length
}
function gateCount(marker: string) {
    const gate = deferred<void>()
    const enteredSignal = deferred<void>()
    gates.set(marker, gate)
    entered.set(marker, enteredSignal)
    return { entered: enteredSignal.promise, release: () => gate.resolve() }
}

async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve()
}

// --- Config / fixtures ---------------------------------------------------------
function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
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
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

// A user message carrying the gate marker plus an assistant message with token
// usage so cacheSystemPromptTokens actually counts the gated user text.
function transformMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "message-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "test", modelID: "fixture" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "p1",
                    messageID: "message-1",
                    sessionID,
                    type: "text",
                    text: "GATE-DURATION question",
                },
            ],
        },
        {
            info: {
                id: "a1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                tokens: { input: 1000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "p2",
                    messageID: "a1",
                    sessionID,
                    type: "text",
                    text: "answer",
                },
            ],
        },
    ] as WithParts[]
}

function compressBlock(): any {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "message-1",
        compressMessageId: "message-1",
        compressCallId: "call-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["message-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    }
}

function partEvent(sessionID: string, status: "pending" | "completed") {
    const state: Record<string, unknown> =
        status === "pending"
            ? { status: "pending", input: {}, raw: "" }
            : {
                  status: "completed",
                  input: {},
                  output: "done",
                  title: "",
                  metadata: {},
                  // pending started at 100 (top-level time); running start 400 =>
                  // serialized duration must be 300ms.
                  time: { start: 400, end: 900 },
              }
    return {
        event: {
            type: "message.part.updated",
            ...(status === "pending" ? { time: 100 } : {}),
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-1",
                    messageID: "message-1",
                    sessionID,
                    state,
                },
            },
        },
    }
}

// --- Minimal legacy (V1) server wired exactly as index.ts ---------------------
// index.ts cannot be imported directly (its config loader uses a jsonc-parser
// ESM import), so mirror its hooks — including the exclusive-wrapped event hook.
function legacyServer() {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    const prompts = {
        reload() {},
        getRuntimePrompts: () => ({
            system: "DCP system prompt",
            manualExtension: "",
            subagentExtension: "",
            contextLimitNudge: "MAX CONTEXT LIMIT REACHED",
            turnNudge: "DCP: compress now",
            iterationNudge: "DCP: compress at next opportunity",
        }),
    } as any
    const client = {
        session: { get: async () => ({ data: { parentID: null } }) },
        config: { providers: async () => ({ data: { providers: [] } }) },
        tui: { showToast: async () => {} },
    } as any
    const transformMessages = createChatMessageTransformHandler(
        client,
        state,
        logger,
        config,
        prompts,
        { global: undefined, agents: {} },
    )
    const handleEvent = createEventHandler(state, logger)
    return {
        state,
        messagesHook: (input: any, output: any) =>
            exclusive(state, () => transformMessages(input, output)),
        eventHook: (input: { event: any }) => exclusive(state, () => handleEvent(input)),
    }
}

test("event hook queues behind a suspended chat transform and applies its duration serially", async () => {
    const sessionID = `ses_event_exclusive_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const logger = new Logger(false)
    const server = legacyServer()
    const state = server.state
    state.sessionId = sessionID
    // Skip the provider lookup; the transform must reach the gated token count.
    state.modelContextLimit = 150000
    state.prune.messages.blocksById.set(1, compressBlock())
    await saveSessionState(state, logger)

    const before = await loadSessionState(sessionID, logger)
    assert.equal(before?.prune.messages.blocksById["1"]?.durationMs, 0)

    // Suspend a chat transform mid-count while it holds the exclusive lock.
    const gated = gateCount("GATE-DURATION")
    const output = { messages: transformMessages(sessionID) }
    const transform = server.messagesHook({}, output)
    await gated.entered

    // Deliver both compress-part events while the transform is suspended. With
    // the fix they queue behind the lock instead of mutating shared state now.
    const pending = server.eventHook(partEvent(sessionID, "pending"))
    const completed = server.eventHook(partEvent(sessionID, "completed"))
    await flushMicrotasks()

    assert.equal(
        state.compressionTiming.startsByCallId.size,
        0,
        "pending event must not record a start while the transform owns the lock",
    )
    assert.equal(
        state.compressionTiming.pendingByCallId.size,
        0,
        "completed event must not apply a duration while the transform owns the lock",
    )
    assert.equal(
        state.prune.messages.blocksById.get(1)?.durationMs,
        0,
        "block duration must not change before the transform finishes",
    )

    gated.release()
    await Promise.all([transform, pending, completed])

    // Serialized outcome: the event ran after the transform, so its duration is
    // applied once and no timing keys are left dangling.
    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 300)
    assert.equal(state.compressionTiming.startsByCallId.size, 0, "no stale start keys")
    assert.equal(state.compressionTiming.pendingByCallId.size, 0, "no stale pending keys")

    const after = await loadSessionState(sessionID, logger)
    assert.equal(
        after?.prune.messages.blocksById["1"]?.durationMs,
        300,
        "persisted save must reflect the serialized duration",
    )
    assert.equal(after?.compression?.durationMs, 300)
})
