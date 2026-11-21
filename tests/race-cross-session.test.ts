// Cross-session concurrency for the V2 (per-session state) plugin path.
// V2 keeps one SessionState per session and serialises each session with its own
// queue, so two DIFFERENT sessions genuinely interleave.  This file pins the
// interleavings introduced by the async token counting / model-limit / chat
// transform merges.  All interleavings are driven by deferred-promise gates on
// the shared token counter and on host client calls — never wall-clock races.
import assert from "node:assert/strict"
import test from "node:test"
import "./lab/persistence-env"
import { tokenCounter } from "../lib/token-counter"

interface Deferred<T> {
    promise: Promise<T>
    resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
}

// --- Deterministic gate on the shared tokenizer child facade -----------------
// lib/token-utils.countTokens -> tokenCounter.count is the single suspension
// point inside every transform.  Stub it with a marker-aware gate so only the
// explicitly marked text blocks; all other counts resolve in a microtask.
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

// --- Minimal fake V2 host ----------------------------------------------------
type AnyRecord = Record<string, any>

interface Harness {
    contextHook: (event: AnyRecord) => Promise<void>
    setLimits: (list: AnyRecord[]) => void
    snapshot: (sessionID: string) => Promise<AnyRecord>
    setEntries: (sessionID: string, entries: AnyRecord[]) => void
}

async function bootV2(): Promise<Harness> {
    let contextHook: ((event: AnyRecord) => Promise<void>) | undefined
    let modelEditor: ((editor: { list: () => AnyRecord[] }) => void) | undefined
    let rpcMethods: AnyRecord = {}
    const entrySets = new Map<string, AnyRecord[]>()

    const ctx: AnyRecord = {
        location: { directory: "/tmp/dcp-race-v2" },
        options: {},
        app: {},
        client: {},
        agent: {
            get: async ({ agentID }: AnyRecord) => ({
                data: { id: agentID, permissions: [] },
            }),
        },
        session: {
            get: async ({ sessionID }: AnyRecord) => ({
                id: sessionID,
                agent: "build",
                model: { id: "test", providerID: "test" },
                permissions: [],
            }),
            context: async ({ sessionID }: AnyRecord) =>
                entrySets.get(sessionID) ?? entriesFixture(sessionID),
            hook: async (kind: string, cb: (event: AnyRecord) => Promise<void>) => {
                if (kind === "context") contextHook = cb
                return { dispose: async () => {} }
            },
            prompt: async () => {},
        },
        model: {
            transform: async (cb: (editor: { list: () => AnyRecord[] }) => void) => {
                modelEditor = cb
                return { dispose: async () => {} }
            },
        },
        tool: {
            transform: async () => ({ dispose: async () => {} }),
        },
        command: {
            transform: async () => ({ dispose: async () => {} }),
        },
        rpc: {
            register: async (_rpc: AnyRecord, methods: AnyRecord) => {
                rpcMethods = methods
                return { events: { emit: async () => {} } }
            },
        },
        permission: {
            hook: async () => ({ dispose: async () => {} }),
        },
    }

    const { setup } = await import("../lib/v2/index")
    await setup(ctx as any)
    assert.ok(contextHook, "setup must register a context hook")
    assert.ok(modelEditor, "setup must register the model transform")

    return {
        contextHook: contextHook!,
        setLimits: (list) => modelEditor!({ list: () => list }),
        snapshot: (sessionID) => rpcMethods.snapshot({ sessionID }),
        setEntries: (sessionID, entries) => entrySets.set(sessionID, entries),
    }
}

function entriesFixture(sessionID: string, markers: string[] = ["ALPHA", "BETA"]): AnyRecord[] {
    return [
        {
            id: `${sessionID}-u1`,
            type: "user",
            time: { created: 1 },
            text: `${markers[0]} question`,
            content: [],
        },
        {
            id: `${sessionID}-a1`,
            type: "assistant",
            time: { created: 2 },
            agent: "build",
            model: { id: "test", providerID: "test" },
            tokens: { input: 90_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            content: [{ type: "text", text: "answer" }],
        },
        {
            id: `${sessionID}-u2`,
            type: "user",
            time: { created: 3 },
            text: `${markers[1]} follow up`,
            content: [],
        },
    ]
}

function nativeTranscript(sessionID: string, markers: string[] = ["ALPHA", "BETA"]): AnyRecord[] {
    return [
        {
            id: `${sessionID}-u1`,
            role: "user",
            content: [{ type: "text", text: `${markers[0]} question` }],
        },
        {
            id: `${sessionID}-a1`,
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
        },
        {
            id: `${sessionID}-u2`,
            role: "user",
            content: [{ type: "text", text: `${markers[1]} follow up` }],
        },
    ]
}

function hostEvent(
    sessionID: string,
    modelID: string,
    systemText: string,
    markers?: string[],
): AnyRecord {
    return {
        sessionID,
        agent: "build",
        model: { providerID: "test", id: modelID },
        system: [{ type: "text", text: systemText }],
        messages: nativeTranscript(sessionID, markers),
        tools: {},
    }
}

// The bundled nudge prompts are stable sentinels we can look for in the
// host-facing message array.
const CTX_NUDGE = "MAX CONTEXT LIMIT REACHED"

function messageText(event: AnyRecord): string {
    return JSON.stringify(event.messages)
}

// Flush the fire-and-forget `void applyAnchoredNudges(...)` microtasks without
// relying on a timeout race.
async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve()
}

test("v2: two sessions with different model limits interleaved during system-token counting keep their own nudge decisions", async () => {
    const harness = await bootV2()
    harness.setLimits([
        { providerID: "test", id: "small", limit: { context: 100_000 } },
        { providerID: "test", id: "large", limit: { context: 1_000_000 } },
    ])
    const a = `ses_race_limit_A_${Date.now()}`
    const b = `ses_race_limit_B_${Date.now()}`

    // Session A's system text carries the unique gate marker. Session B has no
    // marker and completes while A is suspended.
    const gated = gateCount("GATE-SYSTEM-A")
    const eventA = hostEvent(a, "small", "system for A GATE-SYSTEM-A", ["ALPHA-ONLY", "ALPHA-TAIL"])
    const eventB = hostEvent(b, "large", "system for B", ["BETA-ONLY", "BETA-TAIL"])
    const counting = harness.contextHook(eventA)
    await gated.entered
    await harness.contextHook(eventB)
    assert.ok(!messageText(eventA).includes(CTX_NUDGE), "A must still be suspended")
    gated.release()
    await counting
    await flushMicrotasks()

    // 90k usage is over the 85% threshold of the 100k window but far below the
    // threshold of the 1M window: only session A should be nudged.
    assert.match(messageText(eventA), new RegExp(CTX_NUDGE), "A must get its own limit nudge")
    assert.doesNotMatch(messageText(eventB), new RegExp(CTX_NUDGE), "B must not be nudged")
    // B ran through the same hook and must not have leaked A's state or content.
    assert.ok(!messageText(eventA).includes("BETA-ONLY"), "B's content leaked into A")
    assert.ok(!messageText(eventB).includes("ALPHA-ONLY"), "A's content leaked into B")
})

test("v2: a fresh-process session that resumes after another session completes recomputes its own limit", async () => {
    // Each setup() is a fresh process: its limits map is empty until model.transform
    // runs, and each session's state is created on first use.  Interleave two
    // such sessions and assert the limit is resolved per session, not globally.
    const harness = await bootV2()
    harness.setLimits([
        { providerID: "test", id: "tiny", limit: { context: 50_000 } },
        { providerID: "test", id: "huge", limit: { context: 5_000_000 } },
    ])
    const a = `ses_race_fresh_A_${Date.now()}`
    const b = `ses_race_fresh_B_${Date.now()}`

    const gate = gateCount("GATE-FRESH-A")
    const eventA = hostEvent(a, "tiny", "system GATE-FRESH-A", ["FRESH-A", "FRESH-A-TAIL"])
    const countingA = harness.contextHook(eventA)
    await gate.entered

    const eventB = hostEvent(b, "huge", "system B", ["FRESH-B", "FRESH-B-TAIL"])
    await harness.contextHook(eventB)
    gate.release()
    await countingA
    await flushMicrotasks()

    assert.match(messageText(eventA), new RegExp(CTX_NUDGE), "tiny window must nudge")
    assert.doesNotMatch(messageText(eventB), new RegExp(CTX_NUDGE), "huge window must not nudge")
    // Both sessions are still independently addressable after the interleave.
    const [snapshotA, snapshotB] = await Promise.all([harness.snapshot(a), harness.snapshot(b)])
    assert.equal(typeof snapshotA.manualMode, "boolean")
    assert.equal(typeof snapshotB.manualMode, "boolean")
})

// --- Minimal legacy (V1) server: one shared state, all mutators behind exclusive() ---
function legacyConfig(): AnyRecord {
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

async function legacyServer() {
    const { createSessionState, exclusive } = await import("../lib/state")
    const { Logger } = await import("../lib/logger")
    const { createChatMessageTransformHandler, createSystemPromptHandler } =
        await import("../lib/hooks")
    const state = createSessionState()
    const logger = new Logger(false)
    const config = legacyConfig()
    const prompts = {
        reload() {},
        getRuntimePrompts: () => ({
            system: "DCP system prompt",
            manualExtension: "",
            subagentExtension: "",
            contextLimitNudge: CTX_NUDGE,
            turnNudge: "Evaluate the conversation for compressible ranges",
            iterationNudge: "Compress at the next opportunity",
        }),
    } as any
    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
        },
        tui: { showToast: async () => {} },
    }
    const transformMessages = createChatMessageTransformHandler(
        client,
        state,
        logger,
        config,
        prompts,
        { global: undefined, agents: {} },
    )
    const transformSystem = createSystemPromptHandler(state, logger, config, prompts)
    return {
        state,
        messages: (input: AnyRecord, output: AnyRecord) =>
            exclusive(state, () => transformMessages(input, output)),
        system: (input: AnyRecord, output: AnyRecord) =>
            exclusive(state, () => transformSystem(input, output)),
    }
}

function legacyMessages(sessionID: string, firstText = "GATE-A high usage question"): AnyRecord[] {
    return [
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
                    text: firstText,
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
                tokens: {
                    input: 90_000,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                },
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
}

test("legacy: two other sessions' system transforms queued behind a suspended message transform cannot change its context limit", async () => {
    const server = await legacyServer()
    const a = `ses_race_sys_A_${Date.now()}`
    const b = `ses_race_sys_B_${Date.now()}`
    const c = `ses_race_sys_C_${Date.now()}`

    // A warm-up turn initialises the shared state for session A; only then can
    // the system hook cache A's limit (initialisation resets modelContextLimit).
    await server.messages({}, { messages: legacyMessages(a, "warm up") })
    await server.system(
        { sessionID: a, model: { limit: { context: 100_000 } } },
        { system: ["base"] },
    )

    const gated = gateCount("GATE-A")
    const outputA = { messages: legacyMessages(a) }
    const countingA = server.messages({}, outputA)
    await gated.entered

    // These system transforms are for OTHER sessions and carry different
    // limits. The shared state's exclusive lock makes them queue behind A.
    const outB = { system: ["b"] }
    const outC = { system: ["c"] }
    const systemB = server.system({ sessionID: b, model: { limit: { context: 200_000 } } }, outB)
    const systemC = server.system({ sessionID: c, model: { limit: { context: 400_000 } } }, outC)
    assert.ok(!JSON.stringify(outputA).includes(CTX_NUDGE), "A must still be suspended")
    gated.release()
    await Promise.all([countingA, systemB, systemC])
    await flushMicrotasks()

    // A committed with its own 100k limit; 90k usage crosses the 85% threshold.
    assert.match(JSON.stringify(outputA), new RegExp(CTX_NUDGE))
    assert.equal(server.state.modelContextLimit, 400_000, "last queued system transform wins")
    assert.match(outB.system.join(" "), /DCP system prompt/, "B's system prompt must be injected")
    assert.match(outC.system.join(" "), /DCP system prompt/, "C's system prompt must be injected")
})

test("v2: out-of-order context hooks for the same session never inject the nudge twice", async () => {
    // The per-session serial queue must fold two overlapping calls into two
    // ordered passes; the anchor sets (not wall-clock timing) are the guard.
    const harness = await bootV2()
    harness.setLimits([{ providerID: "test", id: "small", limit: { context: 100_000 } }])
    const sessionID = `ses_race_same_${Date.now()}`
    harness.setEntries(sessionID, entriesFixture(sessionID))

    const first = hostEvent(sessionID, "small", "system one")
    const second = hostEvent(sessionID, "small", "system two")
    // Both start before either resolves; `serial` orders them on the same session.
    await Promise.all([harness.contextHook(first), harness.contextHook(second)])
    await flushMicrotasks()

    for (const event of [first, second]) {
        const nudges = messageText(event).split(CTX_NUDGE).length - 1
        assert.equal(nudges, 1, `expected exactly one context nudge, saw ${nudges}`)
    }
    const snapshot = await harness.snapshot(sessionID)
    assert.ok(snapshot.context, "snapshot must still work after overlapping hooks")
})
