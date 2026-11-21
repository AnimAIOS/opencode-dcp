import assert from "node:assert/strict"
import "./lab/persistence-env"
import test, { describe } from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    countSystemPromptTokens,
    mapSystemTextsToParts,
    placeSystemPrompt,
    stripTokenEconomizerManual,
    TOKEN_ECONOMIZER_MARKER,
} from "../lib/integrations"
import { createSystemPromptHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { createSessionState } from "../lib/state"
import type { PromptStore } from "../lib/prompts"

const TE_PART = `${TOKEN_ECONOMIZER_MARKER}\n- repo: DCP prunes tool outputs\n- fact: bd is the tracker\n</tokeneconomizer-manual>`
const OTHER_PART = "ordinary system prompt"

function buildConfig(tokenEconomizer: "auto" | "off"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        integrations: { tokenEconomizer, beads: "off", beadsPrefix: null },
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

describe("placeSystemPrompt", () => {
    test("keeps the TE part byte-identical and places DCP below it when active", () => {
        const result = placeSystemPrompt([OTHER_PART, TE_PART], "DCP OWN PROMPT", {
            tokenEconomizer: true,
        })
        assert.equal(result.tePreserved, true)
        assert.equal(result.system[1], TE_PART)
        assert.equal(result.system[2], "DCP OWN PROMPT")
        assert.ok(result.system.indexOf(TE_PART) < result.system.indexOf("DCP OWN PROMPT"))
    })

    test("appends to the last part (old behaviour) when TE mode is off", () => {
        const result = placeSystemPrompt([OTHER_PART, TE_PART], "DCP OWN PROMPT", {
            tokenEconomizer: false,
        })
        assert.equal(result.tePreserved, false)
        assert.deepEqual(result.system, [OTHER_PART, `${TE_PART}\n\nDCP OWN PROMPT`])
    })

    test("is a no-op change when TE is not detected even if active", () => {
        const result = placeSystemPrompt([OTHER_PART], "DCP OWN PROMPT", {
            tokenEconomizer: true,
        })
        assert.equal(result.tePreserved, false)
        assert.deepEqual(result.system, [`${OTHER_PART}\n\nDCP OWN PROMPT`])
    })
})

describe("createSystemPromptHandler with TE integration", () => {
    test("preserves the TE part byte-identical and appends DCP as a new part below it", async () => {
        const state = createSessionState()
        const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("auto"), prompts())
        const output = { system: [TE_PART] }
        await handler({ sessionID: "session-1", model: { limit: { context: 200000 } } }, output)
        assert.equal(output.system[0], TE_PART)
        assert.equal(output.system.length, 2)
        assert.match(output.system[1], /DCP OWN PROMPT/)
        assert.ok(output.system.indexOf(TE_PART) < output.system.findIndex((s) => s.includes("DCP OWN PROMPT")))
    })

    test("is unchanged when TE mode is off", async () => {
        const state = createSessionState()
        const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("off"), prompts())
        const output = { system: [TE_PART] }
        await handler({ sessionID: "session-1", model: { limit: { context: 200000 } } }, output)
        assert.deepEqual(output.system, [`${TE_PART}\n\nDCP OWN PROMPT`])
    })
})

describe("v2 context system mapping", () => {
    test("preserves each original part's metadata and keeps TE above DCP", () => {
        const original = [
            { type: "text", text: TE_PART, metadata: { source: "tokeneconomizer" } },
            { type: "text", text: OTHER_PART, metadata: { source: "agent" } },
        ]
        const finalTexts = [TE_PART, OTHER_PART, "DCP OWN PROMPT"]
        const mapped = mapSystemTextsToParts(original, finalTexts)
        assert.equal(mapped[0].text, TE_PART)
        assert.deepEqual(mapped[0].metadata, { source: "tokeneconomizer" })
        assert.deepEqual(mapped[1].metadata, { source: "agent" })
        assert.equal(mapped[2].text, "DCP OWN PROMPT")
        assert.ok(mapped.findIndex((p) => p.text === TE_PART)! < mapped.findIndex((p) => p.text.includes("DCP OWN PROMPT")))
    })
})

describe("system prompt token accounting", () => {
    test("includes the TE part's tokens", async () => {
        const withoutTE = await countSystemPromptTokens([OTHER_PART])
        const withTE = await countSystemPromptTokens([OTHER_PART, TE_PART])
        assert.ok(withTE > withoutTE, `${withTE} should exceed ${withoutTE}`)
        assert.equal(withTE, await countSystemPromptTokens([`${OTHER_PART}\n${TE_PART}`]))
    })
})

describe("compression summary duplication guard", () => {
    test("strips a copied TE manual so it appears at most once", () => {
        const summary = `Kept the old tool outputs.\n${TE_PART}\nAlso noted:\n${TE_PART}`
        const stripped = stripTokenEconomizerManual(summary)
        assert.ok(!stripped.includes(TOKEN_ECONOMIZER_MARKER))
        assert.ok(!stripped.includes("- repo: DCP prunes tool outputs"))
        assert.ok(stripped.includes("Kept the old tool outputs."))
    })

    test("strips the legacy header form and leaves ordinary prose untouched", () => {
        const legacy = "TokenEconomizer -- Learned Facts\n- DCP is a compression plugin\n\nKept ordinary notes."
        assert.ok(!stripTokenEconomizerManual(legacy).includes("TokenEconomizer --"))
        const ordinary = "We discussed TokenEconomizer in the previous turn -- see notes."
        assert.equal(stripTokenEconomizerManual(ordinary), ordinary)
    })
})
