// State, persistence and async-subflow races on the legacy (shared-state) path.
// The legacy server serialises mutators with exclusive(); these tests probe the
// gaps *around* that lock (fire-and-forget work, session replacement, duplicate
// concurrent transforms) plus filesystem-level persistence interleavings.
import assert from "node:assert/strict"
import test from "node:test"
import "./lab/persistence-env"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tokenCounter } from "../lib/token-counter"
import { stateDir } from "./lab/persistence-env"

interface Deferred<T> {
    promise: Promise<T>
    resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
}

// Marker-gated tokenizer stub. Every count that does not contain an armed
// marker resolves in a microtask, so gates only suspend the named operation.
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
    for (let i = 0; i < 6; i++) await Promise.resolve()
}

// --- Legacy server harness ---------------------------------------------------
type AnyRecord = Record<string, any>
const CTX_NUDGE = "MAX CONTEXT LIMIT REACHED"

function config(): AnyRecord {
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
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: "85%",
            minContextLimit: "60%",
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

function promptStore(reloads: { count: number }) {
    return {
        reload() {
            reloads.count++
        },
        getRuntimePrompts: () => ({
            system: "DCP system prompt",
            manualExtension: "",
            subagentExtension: "",
            contextLimitNudge: CTX_NUDGE,
            turnNudge: "Evaluate the conversation for compressible ranges",
            iterationNudge: "Compress at the next opportunity",
        }),
    } as any
}

async function legacyServer() {
    const { createSessionState, exclusive } = await import("../lib/state")
    const { Logger } = await import("../lib/logger")
    const {
        createChatMessageTransformHandler,
        createSystemPromptHandler,
        createCommandExecuteHandler,
    } = await import("../lib/hooks")
    const state = createSessionState()
    const logger = new Logger(false)
    const settings = config()
    const reloads = { count: 0 }
    const prompts = promptStore(reloads)
    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
            messages: async () => ({ data: conversation("ignored") }),
            prompt: async () => {},
        },
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        { id: "test", models: { fixture: { limit: { context: 100_000 } } } },
                    ],
                },
            }),
        },
        tui: { showToast: async () => {} },
    }
    const transformMessages = createChatMessageTransformHandler(
        client,
        state,
        logger,
        settings,
        prompts,
        { global: undefined, agents: {} },
    )
    const transformSystem = createSystemPromptHandler(state, logger, settings, prompts)
    const executeCommand = createCommandExecuteHandler(
        client,
        state,
        logger,
        settings,
        mkdtempSync(join(tmpdir(), "dcp-race-state-")),
        { global: undefined, agents: {} },
    )
    return {
        state,
        reloads,
        messages: (input: AnyRecord, output: AnyRecord) =>
            exclusive(state, () => transformMessages(input, output)),
        system: (input: AnyRecord, output: AnyRecord) =>
            exclusive(state, () => transformSystem(input, output)),
        command: (input: AnyRecord, output: AnyRecord) =>
            exclusive(state, () => executeCommand(input, output)),
    }
}

function conversation(
    sessionID: string,
    opts: { firstText?: string; toolText?: string } = {},
): AnyRecord[] {
    const first = opts.firstText ?? "ordinary question"
    const messages: AnyRecord[] = [
        {
            info: {
                id: `${sessionID}-u1`,
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "test", modelID: "fixture" },
                time: { created: 1 },
            },
            parts: [
                {
                    id: `${sessionID}-u1-p`,
                    messageID: `${sessionID}-u1`,
                    sessionID,
                    type: "text",
                    text: first,
                },
            ],
        },
        {
            info: {
                id: `${sessionID}-a1`,
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
                tokens: { input: 90_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [
                {
                    id: `${sessionID}-a1-p`,
                    messageID: `${sessionID}-a1`,
                    sessionID,
                    type: "text",
                    text: "answer",
                },
            ],
        },
        {
            info: {
                id: `${sessionID}-u2`,
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "test", modelID: "fixture" },
                time: { created: 3 },
            },
            parts: [
                {
                    id: `${sessionID}-u2-p`,
                    messageID: `${sessionID}-u2`,
                    sessionID,
                    type: "text",
                    text: "follow up",
                },
            ],
        },
    ]
    if (opts.toolText) {
        messages[1].parts.push({
            id: `${sessionID}-tool-p`,
            messageID: `${sessionID}-a1`,
            sessionID,
            type: "tool",
            tool: "bash",
            callID: `${sessionID}-call`,
            state: {
                status: "completed",
                input: { command: opts.toolText },
                output: opts.toolText,
            },
        })
    }
    return messages
}

test("legacy: a queued turn for a different session cannot overwrite the suspended session's nudge anchors", async () => {
    const server = await legacyServer()
    const a = `ses_race_turn_A_${Date.now()}`
    const b = `ses_race_turn_B_${Date.now()}`

    const gate = gateCount("GATE-TURN-A")
    const outA = { messages: conversation(a, { firstText: "GATE-TURN-A question" }) }
    const turnA = server.messages({}, outA)
    await gate.entered

    const outB = { messages: conversation(b, { firstText: "plain B question" }) }
    const turnB = server.messages({}, outB)
    assert.equal(server.state.sessionId, a, "A must own the state while suspended")
    gate.release()
    await Promise.all([turnA, turnB])
    await flushMicrotasks()

    assert.match(JSON.stringify(outA), new RegExp(CTX_NUDGE), "A keeps its own nudge")
    assert.equal(server.state.sessionId, b, "B is the new turn")
    // B's anchors must be B's message ids, with no anchor left over from A.
    for (const anchor of server.state.nudges.contextLimitAnchors) {
        assert.match(anchor, new RegExp(`^${b}-`), `stale anchor from A: ${anchor}`)
    }
})

test("legacy: a manual-mode toggle queued behind a suspended transform wins after the stale transform resumes", async () => {
    const server = await legacyServer()
    const a = `ses_race_manual_${Date.now()}`
    const gate = gateCount("GATE-MANUAL")
    const out = { messages: conversation(a, { firstText: "GATE-MANUAL question" }) }
    const turn = server.messages({}, out)
    await gate.entered

    const command = server.command(
        { command: "dcp", sessionID: a, arguments: "manual on" },
        { parts: [] },
    )
    gate.release()
    await Promise.all([turn, command])
    await flushMicrotasks()

    assert.equal(server.state.manualMode, "active", "newer toggle must win")
    assert.match(
        JSON.stringify(out),
        new RegExp(CTX_NUDGE),
        "stale turn still committed its output",
    )
})

test("legacy: two overlapping transforms for the same session inject one nudge and allocate stable refs", async () => {
    const server = await legacyServer()
    const a = `ses_race_dup_${Date.now()}`
    const gate = gateCount("GATE-DUP")
    const first = { messages: conversation(a, { firstText: "GATE-DUP question" }) }
    const second = { messages: conversation(a, { firstText: "GATE-DUP question" }) }

    const firstTurn = server.messages({}, first)
    await gate.entered
    const secondTurn = server.messages({}, second)
    gate.release()
    await Promise.all([firstTurn, secondTurn])
    await flushMicrotasks()

    for (const output of [first, second]) {
        const nudges = JSON.stringify(output).split(CTX_NUDGE).length - 1
        assert.equal(nudges, 1, `expected one nudge per output, saw ${nudges}`)
    }
    assert.equal(server.state.messageIds.byRawId.size, 3, "refs allocated once per raw id")
    assert.equal(server.state.messageIds.nextRef, 4, "no double allocation")
})

test("legacy: a tool-cache sync suspended mid-count cannot let the next session's turn bleed into it", async () => {
    // syncToolCache awaits countToolTokens, so an in-flight tool count holds the
    // exclusive lock. A second session's turn must wait, and the first session's
    // tool entry must never survive into the second session's cache.
    const server = await legacyServer()
    const a = `ses_race_toolcache_A_${Date.now()}`
    const b = `ses_race_toolcache_B_${Date.now()}`
    const gate = gateCount("GATE-TOOL-A")

    const turnA = server.messages(
        {},
        { messages: conversation(a, { toolText: "GATE-TOOL-A command" }) },
    )
    await gate.entered
    assert.equal(server.state.sessionId, a)

    // B is enqueued behind A's suspended tool count.
    const turnB = server.messages({}, { messages: conversation(b, { toolText: "B command" }) })
    let bDone = false
    void turnB.then(() => (bDone = true))
    await flushMicrotasks()
    assert.equal(bDone, false, "B must wait for A's tool count to finish")

    gate.release()
    await Promise.all([turnA, turnB])
    await flushMicrotasks()

    const keys = [...server.state.toolParameters.keys()]
    assert.ok(
        keys.some((id) => id.startsWith(b)),
        "B's tool must be cached",
    )
    assert.ok(!keys.some((id) => id.startsWith(a)), `stale A tool entry: ${keys.join(", ")}`)
})

// --- Subagent result injection ordering -------------------------------------
function taskMessage(callID: string, subSession: string, output: string): AnyRecord {
    return {
        info: {
            id: `msg-${callID}`,
            role: "assistant",
            sessionID: "parent-session",
            agent: "assistant",
            time: { created: 1 },
        },
        parts: [
            {
                type: "tool",
                tool: "task",
                callID,
                state: {
                    status: "completed",
                    metadata: { sessionId: subSession },
                    output,
                },
            },
        ],
    }
}

test("subagent results: out-of-order fetches keep each call's expansion isolated and cache idempotent", async () => {
    const { injectExtendedSubAgentResults } =
        await import("../lib/messages/inject/subagent-results")
    const { Logger } = await import("../lib/logger")
    const { createSessionState } = await import("../lib/state")
    const state = createSessionState()
    const logger = new Logger(false)

    const gate = deferred<void>()
    const fetchEntered = deferred<void>()
    const client = {
        session: {
            messages: async ({ path }: AnyRecord) => {
                if (path.id === "sub-A") {
                    fetchEntered.resolve()
                    await gate.promise
                }
                const marker = path.id === "sub-A" ? "EXPANSION-A" : "EXPANSION-B"
                return {
                    data: [
                        {
                            info: {
                                id: `${path.id}-msg`,
                                role: "assistant",
                                sessionID: path.id,
                                agent: "assistant",
                                time: { created: 1 },
                            },
                            parts: [{ type: "text", text: `${marker} from subagent` }],
                        },
                    ],
                }
            },
        },
    }

    const messagesA = [taskMessage("call-A", "sub-A", "<task_result>\n</task_result>")]
    const messagesB = [taskMessage("call-B", "sub-B", "<task_result>\n</task_result>")]

    const expansionA = injectExtendedSubAgentResults(client, state, logger, messagesA, true)
    await fetchEntered.promise
    // B's result arrives and is cached while A's fetch is still suspended.
    await injectExtendedSubAgentResults(client, state, logger, messagesB, true)
    gate.resolve()
    await expansionA

    const outputA = messagesA[0].parts[0].state.output as string
    const outputB = messagesB[0].parts[0].state.output as string
    assert.match(outputA, /EXPANSION-A/)
    assert.doesNotMatch(outputA, /EXPANSION-B/)
    assert.match(outputB, /EXPANSION-B/)
    assert.doesNotMatch(outputB, /EXPANSION-A/)
    assert.equal(state.subAgentResultCache.get("call-A"), "EXPANSION-A from subagent")
    assert.equal(state.subAgentResultCache.get("call-B"), "EXPANSION-B from subagent")

    // Re-running after both are cached must replace the body, not append again.
    await Promise.all([
        injectExtendedSubAgentResults(client, state, logger, messagesA, true),
        injectExtendedSubAgentResults(client, state, logger, messagesB, true),
    ])
    assert.equal((messagesA[0].parts[0].state.output as string).split("EXPANSION-A").length - 1, 1)
    assert.equal((messagesB[0].parts[0].state.output as string).split("EXPANSION-B").length - 1, 1)
})

// --- Persistence under concurrency ------------------------------------------
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { Logger } from "../lib/logger"
import { createSessionState, loadSessionState, saveSessionState } from "../lib/state"

function persistedState(sessionID: string, marker: string, size = 0) {
    const state = createSessionState()
    state.sessionId = sessionID
    state.stats.totalPruneTokens = marker.length
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "range",
        topic: marker,
        batchTopic: marker,
        startId: "@1@",
        endId: "@1@",
        anchorMessageId: "msg-1",
        compressMessageId: "compress-1",
        compressCallId: "call-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: marker.repeat(size),
    } as any)
    return state
}

test("persistence: two sessions saved concurrently keep their own data with no cross-session bleed", async () => {
    mkdirSync(stateDir, { recursive: true })
    const suffix = `${Date.now()}`
    const a = `ses_race_persist_A_${suffix}`
    const b = `ses_race_persist_B_${suffix}`
    const logger = new Logger(false)
    try {
        await Promise.all([
            saveSessionState(persistedState(a, "ONLY-A", 20), logger),
            saveSessionState(persistedState(b, "ONLY-B", 20), logger),
        ])
        const loadedA = await loadSessionState(a, logger)
        const loadedB = await loadSessionState(b, logger)
        const summaryA = Object.values(loadedA!.prune.messages.blocksById)[0]!.summary
        const summaryB = Object.values(loadedB!.prune.messages.blocksById)[0]!.summary
        assert.ok(summaryA.startsWith("ONLY-A") && !summaryA.includes("ONLY-B"))
        assert.ok(summaryB.startsWith("ONLY-B") && !summaryB.includes("ONLY-A"))
    } finally {
        for (const id of [a, b]) rmSync(join(stateDir, `${id}.json`), { force: true })
    }
})

test("persistence: a read during an in-flight write returns a whole version, never a partial file", async () => {
    mkdirSync(stateDir, { recursive: true })
    const sessionID = `ses_race_persist_read_${Date.now()}`
    const logger = new Logger(false)
    const path = join(stateDir, `${sessionID}.json`)
    try {
        await saveSessionState(persistedState(sessionID, "OLD", 5), logger)
        const old = await loadSessionState(sessionID, logger)

        // Large payload keeps the write in flight while the read starts.
        const writing = saveSessionState(persistedState(sessionID, "NEW", 400_000), logger)
        const during = await loadSessionState(sessionID, logger)
        await writing

        assert.ok(during, "a read during a write must still see a complete state")
        const summary = Object.values(during.prune.messages.blocksById)[0]!.summary
        assert.ok(
            summary.startsWith("OLD") || summary.startsWith("NEW"),
            `torn read: ${summary.slice(0, 40)}`,
        )
        assert.equal(during.stats.totalPruneTokens, summary.startsWith("OLD") ? 3 : 3)
        assert.equal(old!.stats.totalPruneTokens, 3)
    } finally {
        rmSync(path, { force: true })
    }
})

test("persistence: many concurrent writes to one session leave exactly one complete version and no temp files", async () => {
    mkdirSync(stateDir, { recursive: true })
    const sessionID = `ses_race_persist_many_${Date.now()}`
    const logger = new Logger(false)
    try {
        const markers = Array.from({ length: 8 }, (_, i) => `M${i}`)
        await Promise.all(
            markers.map((marker) =>
                saveSessionState(persistedState(sessionID, marker, 10_000), logger),
            ),
        )
        const saved = JSON.parse(readFileSync(join(stateDir, `${sessionID}.json`), "utf8"))
        const summary: string = Object.values(saved.prune.messages.blocksById)[0]!.summary as string
        assert.ok(
            markers.some((m) => summary.startsWith(m)),
            "final file must be a whole version",
        )
        assert.ok(
            markers.every((m) => !summary.includes(m) || summary.startsWith(m)),
            "no mixed content from two writers",
        )
        const leftovers = readdirSync(stateDir).filter((name) => name.includes(".tmp"))
        assert.deepEqual(leftovers, [], "atomic writes must clean up their temp files")
    } finally {
        rmSync(join(stateDir, `${sessionID}.json`), { force: true })
    }
})

test("message refs stay collision-free across sessions initialised in the same millisecond", async () => {
    const { assignMessageRefs } = await import("../lib/message-ids")
    const { createSessionState } = await import("../lib/state")
    const originalNow = Date.now
    // Freeze the clock: correctness must come from per-state counters, not time.
    Date.now = () => 1_700_000_000_000
    try {
        const refs = new Set<string>()
        for (let i = 0; i < 40; i++) {
            const state = createSessionState()
            const sessionID = `ses_same_ms_${Date.now()}_${i}`
            const msgs = [1, 2, 3].map((n) => ({
                info: {
                    id: `${sessionID}-m${n}`,
                    role: n === 2 ? "assistant" : "user",
                    sessionID,
                    agent: "assistant",
                    time: { created: n },
                    model: { providerID: "test", modelID: "fixture" },
                },
                parts: [{ type: "text", text: `text ${n}` }],
            })) as any
            const assigned = assignMessageRefs(state, msgs)
            assert.equal(assigned, 3)
            const allocated = [...state.messageIds.byRawId.values()]
            assert.deepEqual(allocated, ["m0001", "m0002", "m0003"])
            for (const ref of allocated) refs.add(`${sessionID}/${ref}`)
        }
        assert.equal(refs.size, 120, "every session/message pair is unique")
    } finally {
        Date.now = originalNow
    }
})
