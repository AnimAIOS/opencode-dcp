import assert from "node:assert/strict"
import "./lab/persistence-env"
import test, { afterEach, mock } from "node:test"
import { formatHelpMessage, handleHelpCommand } from "../lib/commands/help"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"

afterEach(() => {
    mock.restoreAll()
})

function buildConfig(permission: "ask" | "allow" | "deny" = "allow"): PluginConfig {
    return {
        compress: {
            permission,
            mode: "range",
            maxContextLimit: "85%",
            minContextLimit: "60%",
        },
    } as PluginConfig
}

function userMessage(id: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "ses_help_cmd",
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        },
        parts: [{ type: "text", text: "show help" }],
    } as unknown as WithParts
}

test("formatHelpMessage always lists modal commands and respects manual mode", () => {
    const state = createSessionState()
    const message = formatHelpMessage(state, buildConfig())

    assert.match(message, /DCP Commands/)
    assert.match(message, /Manual mode:\s+OFF/)
    assert.match(message, /DCP Context\s+Show token usage breakdown/)
    assert.match(message, /DCP Stats\s+Show DCP pruning statistics/)
    assert.match(message, /DCP Help\s+Show this help in a modal/)
    assert.match(message, /\/dcp-compress \[focus\]\s+Trigger manual compress/)

    state.manualMode = "active"
    assert.match(formatHelpMessage(state, buildConfig()), /Manual mode:\s+ON/)
})

test("compress command is hidden when config or session permission is deny", () => {
    const state = createSessionState()
    assert.match(formatHelpMessage(state, buildConfig("ask")), /\/dcp-compress \[focus\]/)
    assert.doesNotMatch(
        formatHelpMessage(state, buildConfig("deny")),
        /\/dcp-compress \[focus\]\s+Trigger manual compress/,
    )

    state.compressPermission = "deny"
    assert.doesNotMatch(
        formatHelpMessage(state, buildConfig("allow")),
        /\/dcp-compress \[focus\]\s+Trigger manual compress/,
    )
    // Other commands remain visible regardless of compress permission.
    assert.match(formatHelpMessage(state, buildConfig("deny")), /DCP Stats/)
})

test("handleHelpCommand sends an ignored no-reply message and logs execution", async () => {
    const sent: any[] = []
    const client = {
        session: {
            prompt: async (input: any) => {
                sent.push(input)
                return {}
            },
        },
    }
    const logger = new Logger(false)
    const infoCalls: any[][] = []
    mock.method(logger, "info", (...args: any[]) => {
        infoCalls.push(args)
    })
    const state = createSessionState()
    state.manualMode = "active"

    await handleHelpCommand({
        client,
        state,
        config: buildConfig("deny"),
        logger,
        sessionId: "ses_help_cmd",
        messages: [userMessage("msg-user")],
    })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].path.id, "ses_help_cmd")
    assert.equal(sent[0].body.noReply, true)
    assert.equal(sent[0].body.parts[0].ignored, true)
    assert.equal(sent[0].body.agent, "assistant")
    assert.deepEqual(sent[0].body.model, { providerID: "anthropic", modelID: "claude-test" })
    const text = sent[0].body.parts[0].text as string
    assert.match(text, /^▣ DCP\n/)
    assert.match(text, /Manual mode:\s+ON/)
    assert.doesNotMatch(text, /\/dcp-compress \[focus\]\s+Trigger manual compress/)
    assert.deepEqual(infoCalls.at(-1), ["Help command executed"])
})

test("handleHelpCommand still sends help with no user message to read params from", async () => {
    const sent: any[] = []
    const client = {
        session: {
            prompt: async (input: any) => {
                sent.push(input)
                return {}
            },
        },
    }

    await handleHelpCommand({
        client,
        state: createSessionState(),
        config: buildConfig(),
        logger: new Logger(false),
        sessionId: "ses_help_cmd",
        messages: [],
    })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].body.agent, undefined)
    assert.equal(sent[0].body.model, undefined)
    assert.match(sent[0].body.parts[0].text, /DCP Commands/)
})
