import assert from "node:assert/strict"
import "./lab/persistence-env"
import test, { afterEach, mock } from "node:test"
import { handleSweepCommand } from "../lib/commands/sweep"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { tokenCounter } from "../lib/token-counter"

const SESSION_ID = "ses_sweep_cmd"
afterEach(() => {
    mock.restoreAll()
})

function buildConfig(
    protectedTools: string[] = [],
    protectedFilePatterns: string[] = [],
): PluginConfig {
    return {
        enabled: true,
        commands: { enabled: true, protectedTools },
        turnProtection: { enabled: false, turns: 4 },
        protectedFilePatterns,
        compress: { mode: "range", permission: "allow", protectedTools: [] },
    } as PluginConfig
}

function userMessage(id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SESSION_ID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
        },
        parts: [{ type: "text", text: "do the work" }],
    } as unknown as WithParts
}

function toolPart(messageID: string, callID: string, tool: string, input: any) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID: SESSION_ID,
        type: "tool",
        tool,
        callID,
        state: { status: "completed", input, output: "output" },
    }
}

function toolMessage(id: string, created: number, parts: any[]): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SESSION_ID,
            agent: "assistant",
            time: { created },
        },
        parts,
    } as unknown as WithParts
}

/** The sweep handler caches tool token counts through the shared tokenizer service. */
function stubTokenCount(): void {
    mock.method(tokenCounter, "count", async (text: string) => text.length)
}

function cachedTokens(input: any): number {
    return `${JSON.stringify(input)} output`.length
}

function makeClient() {
    const sent: any[] = []
    return {
        client: {
            session: {
                prompt: async (input: any) => {
                    sent.push(input)
                    return {}
                },
            },
        },
        sent,
    }
}

function textOf(sent: any[]): string {
    assert.equal(sent.length, 1)
    return sent[0].body.parts[0].text as string
}

test("since-user sweep prunes unprotected tools, updates stats and reports skipped tools", async () => {
    stubTokenCount()
    const { client, sent } = makeClient()
    const logger = new Logger(false)
    const infoCalls: any[][] = []
    mock.method(logger, "info", (...args: any[]) => {
        infoCalls.push(args)
    })
    const state = createSessionState()
    const runArgs = {
        client,
        state,
        config: buildConfig(["task"]),
        logger,
        sessionId: SESSION_ID,
        workingDirectory: "/repo",
        args: [],
    }

    await handleSweepCommand({
        ...runArgs,
        messages: [
            userMessage("msg-user", 1),
            toolMessage("msg-a", 2, [
                toolPart("msg-a", "call-bash", "bash", { description: "run tests" }),
                toolPart("msg-a", "call-write", "write", { filePath: "/repo/src/a.ts" }),
            ]),
            toolMessage("msg-b", 3, [
                toolPart("msg-b", "call-task", "task", { description: "delegate" }),
            ]),
        ],
    })

    const expectedSaved =
        cachedTokens({ description: "run tests" }) + cachedTokens({ filePath: "/repo/src/a.ts" })
    assert.deepEqual([...state.prune.tools.keys()], ["call-bash", "call-write"])
    assert.equal(state.prune.tools.get("call-bash"), cachedTokens({ description: "run tests" }))
    assert.equal(state.prune.tools.has("call-task"), false)

    assert.equal(state.stats.pruneTokenCounter, 0)
    assert.equal(state.stats.totalPruneTokens, expectedSaved)

    const text = textOf(sent)
    assert.match(text, /^▣ DCP\n/)
    assert.match(text, /DCP Sweep/)
    assert.match(text, /Swept 2 tool\(s\) since the previous user message\./)
    assert.match(text, new RegExp(`Tokens saved: ~${expectedSaved.toLocaleString()}`))
    assert.match(text, /\(1 protected tool\(s\) skipped\)/)
    assert.match(text, /→ bash: run tests/)
    assert.match(text, /→ write: src\/a\.ts/)

    const completion = infoCalls.find(([message]) => message === "Sweep command completed")
    assert.ok(completion)
    assert.equal(completion![1].toolsSwept, 2)
    assert.equal(completion![1].tokensSaved, expectedSaved)
    assert.equal(completion![1].skippedProtected, 1)
    assert.equal(completion![1].mode, "since-user")
})

test("last-N sweep uses the tool id list and reports a different message", async () => {
    stubTokenCount()
    const { client, sent } = makeClient()
    const state = createSessionState()

    await handleSweepCommand({
        client,
        state,
        config: buildConfig(),
        logger: new Logger(false),
        sessionId: SESSION_ID,
        messages: [
            userMessage("msg-user", 1),
            toolMessage("msg-a", 2, [
                toolPart("msg-a", "call-1", "bash", { description: "first" }),
                toolPart("msg-a", "call-2", "bash", { description: "second" }),
                toolPart("msg-a", "call-3", "bash", { description: "third" }),
            ]),
        ],
        args: ["2"],
        workingDirectory: "/repo",
    })

    assert.deepEqual([...state.prune.tools.keys()], ["call-2", "call-3"])
    assert.match(textOf(sent), /Swept the last 2 tool\(s\)\./)
})

test("a non-numeric argument falls back to since-user mode", async () => {
    stubTokenCount()
    const { client, sent } = makeClient()
    const state = createSessionState()

    await handleSweepCommand({
        client,
        state,
        config: buildConfig(),
        logger: new Logger(false),
        sessionId: SESSION_ID,
        messages: [
            userMessage("msg-user", 1),
            toolMessage("msg-a", 2, [toolPart("msg-a", "call-1", "bash", { description: "one" })]),
        ],
        args: ["many"],
        workingDirectory: "/repo",
    })

    assert.match(textOf(sent), /Swept 1 tool\(s\) since the previous user message\./)
})

test("sweep without a user message reports nothing and leaves the prune state untouched", async () => {
    const { client, sent } = makeClient()
    const state = createSessionState()

    await handleSweepCommand({
        client,
        state,
        config: buildConfig(),
        logger: new Logger(false),
        sessionId: SESSION_ID,
        messages: [
            toolMessage("msg-a", 1, [toolPart("msg-a", "call-1", "bash", { description: "one" })]),
        ],
        args: [],
        workingDirectory: "/repo",
    })

    assert.match(textOf(sent), /Nothing swept: no user message found\./)
    assert.equal(state.prune.tools.size, 0)
    assert.equal(state.stats.totalPruneTokens, 0)
})

test("sweep reports protected-only and already-pruned tools as nothing new", async () => {
    stubTokenCount()
    const { client, sent } = makeClient()
    const protectedState = createSessionState()

    await handleSweepCommand({
        client,
        state: protectedState,
        config: buildConfig(["task"]),
        logger: new Logger(false),
        sessionId: SESSION_ID,
        messages: [
            userMessage("msg-user", 1),
            toolMessage("msg-a", 2, [
                toolPart("msg-a", "call-task", "task", { description: "delegate" }),
            ]),
        ],
        args: [],
        workingDirectory: "/repo",
    })
    let text = textOf(sent)
    assert.match(text, /No tools found since the previous user message\./)
    assert.match(text, /\(1 protected tool\(s\) skipped\)/)
    assert.equal(protectedState.prune.tools.size, 0)

    // The same tool in last-N mode, already pruned, yields the last-N empty message.
    const prunedState: SessionState = createSessionState()
    prunedState.prune.tools.set("call-1", 10)
    sent.length = 0
    await handleSweepCommand({
        client,
        state: prunedState,
        config: buildConfig(),
        logger: new Logger(false),
        sessionId: SESSION_ID,
        messages: [
            userMessage("msg-user", 1),
            toolMessage("msg-a", 2, [toolPart("msg-a", "call-1", "bash", { description: "one" })]),
        ],
        args: ["1"],
        workingDirectory: "/repo",
    })
    text = textOf(sent)
    assert.match(text, /No tools found to sweep\./)
    assert.equal(prunedState.prune.tools.get("call-1"), 10)
})

test("compacted messages after the last user message are not swept", async () => {
    stubTokenCount()
    const { client, sent } = makeClient()
    const state = createSessionState()
    state.lastCompaction = 100

    await handleSweepCommand({
        client,
        state,
        config: buildConfig(),
        logger: new Logger(false),
        sessionId: SESSION_ID,
        messages: [
            toolMessage("msg-before", 1, [
                toolPart("msg-before", "call-old", "bash", { description: "stale" }),
            ]),
            userMessage("msg-user", 101),
            toolMessage("msg-after", 102, [
                toolPart("msg-after", "call-new", "bash", { description: "fresh" }),
            ]),
        ],
        args: [],
        workingDirectory: "/repo",
    })

    assert.deepEqual([...state.prune.tools.keys()], ["call-new"])
    assert.match(textOf(sent), /Swept 1 tool\(s\) since the previous user message\./)
})

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("manual sweep does not prune a bash tool output whose command contains a bd subcommand when Beads is active", async () => {
    stubTokenCount()
    const { client } = makeClient()
    const state = createSessionState()
    const dir = mkdtempSync(join(tmpdir(), "dcp-sweep-beads-active-"))
    mkdirSync(join(dir, ".beads"))
    const run = async () => JSON.stringify({ prefix: "opencode-dcp" })
    const config = buildConfig()
    config.integrations = { tokenEconomizer: "off", beads: "auto", beadsPrefix: null }
    const logger = new Logger(false)

    await handleSweepCommand({
        client,
        state,
        config,
        logger,
        sessionId: SESSION_ID,
        messages: [
            userMessage("msg-user", 1),
            toolMessage("msg-a", 2, [
                toolPart("msg-a", "call-bd", "bash", { command: "bd show opencode-dcp-39l.7" }),
            ]),
        ],
        args: [],
        workingDirectory: dir,
        run,
    })

    assert.equal(state.prune.tools.has("call-bd"), false)
    rmSync(dir, { recursive: true, force: true })
})

test("manual sweep is a no-op for bd bash outputs when Beads is off or not detected", async () => {
    for (const mode of ["off", "not-detected"] as const) {
        stubTokenCount()
        const { client } = makeClient()
        const state = createSessionState()
        const dir = mkdtempSync(join(tmpdir(), "dcp-sweep-beads-inactive-"))
        if (mode === "not-detected") mkdirSync(join(dir, ".beads"))
        const run =
            mode === "not-detected"
                ? async () => {
                      throw new Error("bd unavailable")
                  }
                : async () => JSON.stringify({ prefix: "opencode-dcp" })
        const config = buildConfig()
        config.integrations = {
            tokenEconomizer: "off",
            beads: mode === "off" ? "off" : "auto",
            beadsPrefix: null,
        }
        const logger = new Logger(false)

        await handleSweepCommand({
            client,
            state,
            config,
            logger,
            sessionId: SESSION_ID,
            messages: [
                userMessage("msg-user", 1),
                toolMessage("msg-a", 2, [
                    toolPart("msg-a", "call-bd", "bash", { command: "bd show opencode-dcp-39l.7" }),
                ]),
            ],
            args: [],
            workingDirectory: dir,
            run,
        })

        // When inactive, the bd bash output is not protected by Beads; since no
        // other protection applies it gets swept.
        assert.equal(state.prune.tools.has("call-bd"), true)
        rmSync(dir, { recursive: true, force: true })
    }
})
