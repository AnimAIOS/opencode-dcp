import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { createSessionState, type WithParts } from "../lib/state"

// `lib/config` cannot be imported from tests (its `jsonc-parser` ESM subpath has no
// named exports under tsx), so the shipped defaults are asserted against the schema
// and the config source instead of against the runtime object.
const repoRoot = join(import.meta.dirname, "..")

function percentageConfig(maxContextLimit: string, minContextLimit: string): PluginConfig {
    return {
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: maxContextLimit as `${number}%`,
            minContextLimit: minContextLimit as `${number}%`,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
    } as PluginConfig
}

function buildMessages(inputTokens: number): WithParts[] {
    const sessionID = "ses_context_limit_defaults"

    return [
        {
            info: {
                id: "msg-user",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
                model: { providerID: "opencode-go", modelID: "big-window" },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-user-part",
                    messageID: "msg-user",
                    sessionID,
                    type: "text" as const,
                    text: "continue please",
                },
            ],
        },
        {
            info: {
                id: "msg-assistant",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
                tokens: {
                    input: inputTokens,
                    output: 10,
                    reasoning: 0,
                    cache: {
                        read: 0,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-assistant-part",
                    messageID: "msg-assistant",
                    sessionID,
                    type: "text" as const,
                    text: "done",
                },
            ],
        },
    ]
}

async function limitsFor(modelContextLimit: number | undefined, tokens: number) {
    const state = createSessionState("ses_context_limit_defaults")
    state.modelContextLimit = modelContextLimit
    return await isContextOverLimits(
        percentageConfig("85%", "60%"),
        state,
        "opencode-go",
        "big-window",
        buildMessages(tokens),
    )
}

test("shipped default limits are percentages, not absolute token budgets", async () => {
    const schema = JSON.parse(readFileSync(join(repoRoot, "dcp.schema.json"), "utf-8"))
    const compress = schema.properties.compress.properties

    assert.equal(compress.maxContextLimit.default, "85%")
    assert.equal(compress.minContextLimit.default, "60%")
    assert.equal(schema.properties.compress.default.maxContextLimit, "85%")
    assert.equal(schema.properties.compress.default.minContextLimit, "60%")

    const configSource = readFileSync(join(repoRoot, "lib", "config.ts"), "utf-8")
    assert.match(configSource, /maxContextLimit: "85%",/)
    assert.match(configSource, /minContextLimit: "60%",/)
})

test("percentage defaults stay quiet well past 100k on a 1M window", async () => {
    // Fork defaults: max 85%, min 60%.
    const at250k = await limitsFor(1_000_000, 250_000)
    assert.equal(at250k.overMaxLimit, false)
    assert.equal(at250k.overMinLimit, false)

    const at750k = await limitsFor(1_000_000, 750_000)
    assert.equal(at750k.overMaxLimit, false)
    assert.equal(at750k.overMinLimit, true)

    const at900k = await limitsFor(1_000_000, 900_000)
    assert.equal(at900k.overMaxLimit, true)
})

test("percentage defaults keep the historical thresholds on a 128k window", async () => {
    const at80k = await limitsFor(128_000, 80_000)
    assert.equal(at80k.overMaxLimit, false)
    assert.equal(at80k.overMinLimit, true)

    const at95k = await limitsFor(128_000, 95_000)
    assert.equal(at95k.overMaxLimit, false)
    assert.equal(at95k.overMinLimit, true)
})

test("percentage defaults fail open when the model window is unknown", async () => {
    const unknown = await limitsFor(undefined, 500_000)
    assert.equal(unknown.overMaxLimit, false)
})
