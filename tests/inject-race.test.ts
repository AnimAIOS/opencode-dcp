import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import { rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges, injectMessageIds } from "../lib/messages/inject/inject"
import { applyAnchoredNudges } from "../lib/messages/inject/utils"
import type { RuntimePrompts } from "../lib/prompts/store"
import { setWriteGateForTests, saveSessionState } from "../lib/state/persistence"
import { stateDir } from "./lab/persistence-env"
import { assignMessageRefs } from "../lib/message-ids"
import { createSessionState, type WithParts } from "../lib/state"

const NUDGE = "<dcp-system-reminder>RACE_NUDGE_SENTINEL</dcp-system-reminder>"

function buildConfig(mode: "message" | "range" = "message"): PluginConfig {
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
            mode,
            permission: "allow",
            showCompression: false,
            // Large limits so injectCompressNudges neither adds new anchors nor
            // clears the ones pre-seeded by the test.
            maxContextLimit: 1_000_000_000,
            minContextLimit: 1_000_000_000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

const prompts = {
    system: "",
    compressRange: "",
    compressMessage: "",
    contextLimitNudge: NUDGE,
    turnNudge: "",
    iterationNudge: "",
} as RuntimePrompts

function buildUserMessage(id: string, sessionID: string, text: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "test", modelID: "model" },
            time: { created },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID,
                type: "text" as const,
                text,
            },
        ],
    } as WithParts
}

function assertNudgesBeforeIdTags(messages: WithParts[]): void {
    for (const message of messages) {
        const parts = message.parts as any[]
        const nudgeIndexes = parts
            .map((part, index) => ({ part, index }))
            .filter(
                ({ part }) =>
                    typeof part.text === "string" && part.text.includes("RACE_NUDGE_SENTINEL"),
            )
            .map(({ index }) => index)
        const tagIndex = parts.findIndex(
            (part) => typeof part.text === "string" && part.text.includes("dcp-message-id"),
        )

        assert.equal(nudgeIndexes.length, 1, `expected exactly one nudge on ${message.info.id}`)
        assert.ok(tagIndex >= 0, `expected a message-ID tag on ${message.info.id}`)
        assert.ok(
            nudgeIndexes[0]! < tagIndex,
            `nudge must be injected before the message-ID tag on ${message.info.id}`,
        )
    }
}

test("applyAnchoredNudges injects ALL anchored nudges synchronously (4 anchors, one category)", () => {
    const sessionID = "ses_inject_race_sync"
    const messages = [
        buildUserMessage("msg-1", sessionID, "alpha content", 1),
        buildUserMessage("msg-2", sessionID, "beta content", 2),
        buildUserMessage("msg-3", sessionID, "gamma content", 3),
        buildUserMessage("msg-4", sessionID, "delta content", 4),
    ]
    const state = createSessionState()
    const config = buildConfig("message")
    for (const message of messages) {
        state.nudges.contextLimitAnchors.add(message.info.id)
    }
    assignMessageRefs(state, messages)

    // No await, no microtask flush: the entire nudge chain must be synchronous.
    applyAnchoredNudges(state, config, messages, prompts)

    for (const message of messages) {
        const nudges = (message.parts as any[]).filter(
            (part) =>
                part.type === "text" && part.synthetic && /RACE_NUDGE_SENTINEL/.test(part.text),
        )
        assert.equal(nudges.length, 1, `expected exactly one nudge on ${message.info.id}`)
    }

    injectMessageIds(state, config, messages)
    assertNudgesBeforeIdTags(messages)
})

test("awaiting injectCompressNudges makes all nudges visible before message-ID tags", async () => {
    const sessionID = "ses_inject_race_async"
    const messages = [
        buildUserMessage("msg-1", sessionID, "alpha content", 1),
        buildUserMessage("msg-2", sessionID, "beta content", 2),
        buildUserMessage("msg-3", sessionID, "gamma content", 3),
        buildUserMessage("msg-4", sessionID, "delta content", 4),
        {
            info: {
                id: "msg-assistant",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 5 },
                tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            } as WithParts["info"],
            parts: [
                {
                    id: "assistant-part",
                    messageID: "msg-assistant",
                    sessionID,
                    type: "text" as const,
                    text: "done",
                },
            ],
        } as WithParts,
    ]
    const state = createSessionState()
    const config = buildConfig("message")
    // Pre-seed four anchors of a single category.
    for (const message of messages.slice(0, 4)) {
        state.nudges.contextLimitAnchors.add(message.info.id)
    }
    assignMessageRefs(state, messages)

    await injectCompressNudges(state, config, new Logger(false), messages, prompts)

    // Immediately after awaiting the hook (no flush Microtasks/setTimeout), all
    // four nudge parts must already be present.
    for (const message of messages.slice(0, 4)) {
        const nudges = (message.parts as any[]).filter(
            (part) => typeof part.text === "string" && part.text.includes("RACE_NUDGE_SENTINEL"),
        )
        assert.equal(nudges.length, 1, `expected exactly one nudge on ${message.info.id}`)
    }

    injectMessageIds(state, config, messages)
    assertNudgesBeforeIdTags(messages.slice(0, 4))
})

test("an older detached save cannot clobber a newer awaited save for the same session", async () => {
    const sessionID = `ses_save_race_${Date.now()}`
    const filePath = join(stateDir, `${sessionID}.json`)
    const logger = new Logger(false)

    const older = createSessionState()
    older.sessionId = sessionID
    older.manualMode = false
    older.stats.totalPruneTokens = 111

    const newer = createSessionState()
    newer.sessionId = sessionID
    newer.manualMode = "active"
    newer.stats.totalPruneTokens = 999

    let signalEntered!: () => void
    let releaseGate!: () => void
    const gateEntered = new Promise<void>((resolve) => (signalEntered = resolve))
    const gate = new Promise<void>((resolve) => (releaseGate = resolve))

    // Gate the FIRST write only; the second save is serialized behind it.
    setWriteGateForTests(async () => {
        setWriteGateForTests(undefined)
        signalEntered()
        await gate
    })

    try {
        const oldSave = saveSessionState(older, logger)
        await gateEntered
        const newSave = saveSessionState(newer, logger)
        releaseGate()
        await Promise.all([oldSave, newSave])

        const persisted = JSON.parse(await readFile(filePath, "utf-8"))
        assert.equal(persisted.manualMode, true, "newer manualMode must win on disk")
        assert.equal(persisted.stats.totalPruneTokens, 999, "newer stats must win on disk")
    } finally {
        setWriteGateForTests(undefined)
        rmSync(filePath, { force: true })
    }
})
