import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach, describe, mock } from "node:test"
// Must be imported before lib/config: config.ts snapshots XDG_CONFIG_HOME at module eval.
import "./lab/persistence-env"
import {
    compressToolName,
    getConfig,
    getInvalidConfigKeys,
    validateConfigTypes,
    VALID_CONFIG_KEYS,
    type PluginConfig,
} from "../lib/config"

const configHome = process.env.XDG_CONFIG_HOME!
const globalDir = join(configHome, "opencode")
const globalJsonc = join(globalDir, "dcp.jsonc")
const globalJson = join(globalDir, "dcp.json")
const originalConfigDirEnv = process.env.OPENCODE_CONFIG_DIR
const tempDirs: string[] = []

function clearGlobalConfig(): void {
    rmSync(globalJsonc, { force: true })
    rmSync(globalJson, { force: true })
}

function writeGlobalConfig(content: string, name: "dcp.jsonc" | "dcp.json" = "dcp.jsonc"): void {
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, name), content, "utf-8")
}

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
}

function makeCtx(directory?: string): {
    ctx: {
        directory: string
        client: { tui: { showToast(input: any): unknown } }
    }
    toasts: any[]
} {
    const toasts: any[] = []
    return {
        ctx: {
            directory: directory ?? process.cwd(),
            client: {
                tui: {
                    showToast(input: any) {
                        toasts.push(input)
                    },
                },
            },
        },
        toasts,
    }
}

/** Capture the 7s deferred warning toasts so tests stay fast and deterministic. */
function stubWarningTimers(): Array<() => void> {
    const callbacks: Array<() => void> = []
    mock.method(globalThis, "setTimeout", ((fn: () => void) => {
        callbacks.push(fn)
        return 0
    }) as any)
    return callbacks
}

function getConfigWithWarnings(ctx: Parameters<typeof getConfig>[0], toasts: any[]): PluginConfig {
    const pending = stubWarningTimers()
    const config = getConfig(ctx)
    mock.restoreAll()
    for (const callback of pending) callback()
    void toasts
    return config
}

afterEach(() => {
    mock.restoreAll()
    if (originalConfigDirEnv === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
    } else {
        process.env.OPENCODE_CONFIG_DIR = originalConfigDirEnv
    }
    clearGlobalConfig()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("config key validation", () => {
    test("every documented schema key is accepted, including dynamic model-limit entries", () => {
        assert.ok(VALID_CONFIG_KEYS.has("$schema"))
        assert.ok(VALID_CONFIG_KEYS.has("compress.modelMaxLimits"))
        assert.deepEqual(
            getInvalidConfigKeys({
                $schema: "https://example.com/dcp.schema.json",
                enabled: true,
                compress: {
                    maxContextLimit: "85%",
                    modelMaxLimits: { "anthropic/claude-sonnet-4": 100_000 },
                    modelMinLimits: { "openai/gpt-4o": "50%" },
                },
                strategies: { purgeErrors: { enabled: true } },
            }),
            [],
        )
    })

    test("unknown nested keys are reported by full path and arrays are not traversed", () => {
        assert.deepEqual(
            getInvalidConfigKeys({
                bogusTopLevel: 1,
                compress: {
                    unknownCompressKey: true,
                    protectedTools: ["should-not-be-a-key"],
                },
                strategies: { deduplication: { unexpected: 2 } },
            }),
            ["bogusTopLevel", "compress.unknownCompressKey", "strategies.deduplication.unexpected"],
        )
    })

    test("model limit maps are not recursed into for arbitrary provider/model ids", () => {
        assert.deepEqual(
            getInvalidConfigKeys({
                compress: {
                    modelMaxLimits: { "provider/model:weird:suffix": 42 },
                    modelMinLimits: { "another/model": 12 },
                },
            }),
            [],
        )
    })
})

describe("validateConfigTypes", () => {
    const keys = (config: Record<string, any>) =>
        validateConfigTypes(config).map((error) => error.key)

    test("empty and fully valid configs produce no errors", () => {
        assert.deepEqual(validateConfigTypes({}), [])
        assert.deepEqual(
            validateConfigTypes({
                enabled: false,
                autoUpdate: false,
                debug: true,
                pruneNotification: "minimal",
                pruneNotificationType: "chat",
                protectedFilePatterns: ["src/**"],
                turnProtection: { enabled: true, turns: 3 },
                experimental: { allowSubAgents: true, customPrompts: true },
                commands: { enabled: true, protectedTools: ["task"] },
                manualMode: { enabled: true, automaticStrategies: false },
                compress: {
                    mode: "message",
                    permission: "ask",
                    toolName: "dcp_compress",
                    showCompression: true,
                    summaryBuffer: false,
                    maxContextLimit: "85%",
                    minContextLimit: 50_000,
                    modelMaxLimits: { "p/m": "70%" },
                    modelMinLimits: { "p/m": 1000 },
                    nudgeFrequency: 2,
                    iterationNudgeThreshold: 5,
                    nudgeForce: "strong",
                    protectedTools: ["task"],
                    protectTags: true,
                    protectUserMessages: true,
                },
                strategies: {
                    deduplication: { enabled: true, protectedTools: [] },
                    purgeErrors: { enabled: false, turns: 2, protectedTools: [] },
                },
            }),
            [],
        )
    })

    test("top-level booleans, enums and file patterns are type-checked", () => {
        const errors = validateConfigTypes({
            enabled: "yes",
            autoUpdate: 1,
            debug: null,
            pruneNotification: "verbose",
            pruneNotificationType: "popup",
            protectedFilePatterns: "src/**",
        })
        assert.deepEqual(
            errors.map((error) => error.key),
            [
                "enabled",
                "autoUpdate",
                "debug",
                "pruneNotification",
                "pruneNotificationType",
                "protectedFilePatterns",
            ],
        )
        assert.deepEqual(
            errors.slice(0, 3).map((error) => [error.expected, error.actual]),
            [
                ["boolean", "string"],
                ["boolean", "number"],
                ["boolean", "object"],
            ],
        )
        assert.deepEqual(validateConfigTypes({ protectedFilePatterns: ["ok", 7] }), [
            {
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: "non-string entries",
            },
        ])
    })

    test("turnProtection and experimental objects validate nested fields and shapes", () => {
        assert.deepEqual(keys({ turnProtection: { enabled: "true", turns: "4" } }), [
            "turnProtection.enabled",
            "turnProtection.turns",
        ])
        assert.deepEqual(validateConfigTypes({ turnProtection: { turns: 0 } }), [
            {
                key: "turnProtection.turns",
                expected: "positive number (>= 1)",
                actual: "0",
            },
        ])
        for (const bad of [null, [], "nope"]) {
            assert.deepEqual(keys({ experimental: bad }), ["experimental"])
        }
        assert.deepEqual(
            keys({
                experimental: { allowSubAgents: "yes", customPrompts: 1 },
            }),
            ["experimental.allowSubAgents", "experimental.customPrompts"],
        )
    })

    test("commands and manualMode validate their object shapes and fields", () => {
        for (const bad of [null, [], 4]) {
            assert.deepEqual(keys({ commands: bad }), ["commands"])
            assert.deepEqual(keys({ manualMode: bad }), ["manualMode"])
        }
        assert.deepEqual(
            keys({
                commands: { enabled: "false", protectedTools: "task" },
                manualMode: { enabled: 0, automaticStrategies: "no" },
            }),
            [
                "commands.enabled",
                "commands.protectedTools",
                "manualMode.enabled",
                "manualMode.automaticStrategies",
            ],
        )
    })

    test("compress validates mode, notification flags, thresholds, permission and names", () => {
        for (const bad of [null, [], "range"]) {
            assert.deepEqual(keys({ compress: bad }), ["compress"])
        }
        const errors = validateConfigTypes({
            compress: {
                mode: "whole-session",
                summaryBuffer: "true",
                nudgeFrequency: "often",
                iterationNudgeThreshold: 0,
                nudgeForce: "gentle",
                protectedTools: "task",
                protectTags: 1,
                protectUserMessages: "yes",
                permission: "later",
                toolName: "1bad-name",
                showCompression: "never",
            },
        })
        assert.deepEqual(
            errors.map((error) => error.key),
            [
                "compress.mode",
                "compress.summaryBuffer",
                "compress.nudgeFrequency",
                "compress.nudgeForce",
                "compress.protectedTools",
                "compress.protectTags",
                "compress.protectUserMessages",
                "compress.iterationNudgeThreshold",
                "compress.permission",
                "compress.toolName",
                "compress.showCompression",
            ],
        )
        assert.equal(
            errors.find((error) => error.key === "compress.nudgeFrequency")?.actual,
            "string",
        )
        assert.equal(
            errors.find((error) => error.key === "compress.iterationNudgeThreshold")?.expected,
            "positive number (>= 1)",
        )
    })

    test("compress accepts numbers and percent strings for context limits", () => {
        assert.deepEqual(
            keys({
                compress: {
                    maxContextLimit: 150_000,
                    minContextLimit: "60%",
                },
            }),
            [],
        )
        assert.deepEqual(
            keys({ compress: { maxContextLimit: true, minContextLimit: "sixty-percent" } }),
            ["compress.maxContextLimit", "compress.minContextLimit"],
        )
    })

    test("model limit maps must be objects with numeric or percent-string values", () => {
        assert.deepEqual(
            keys({
                compress: {
                    modelMaxLimits: { "p/m": 1, "p/n": "90%" },
                    modelMinLimits: { "p/m": "10%" },
                },
            }),
            [],
        )
        assert.deepEqual(
            keys({
                compress: {
                    modelMaxLimits: ["not", "an", "object"],
                    modelMinLimits: { "p/bad": "90 percent", "p/null": null },
                },
            }),
            [
                "compress.modelMaxLimits",
                "compress.modelMinLimits.p/bad",
                "compress.modelMinLimits.p/null",
            ],
        )
        assert.deepEqual(keys({ compress: { modelMinLimits: null } }), ["compress.modelMinLimits"])
    })

    test("strategies validate deduplication and purgeErrors fields", () => {
        assert.deepEqual(
            keys({
                strategies: {
                    deduplication: { enabled: "yes", protectedTools: "task" },
                    purgeErrors: {
                        enabled: 1,
                        turns: "4",
                        protectedTools: "task",
                    },
                },
            }),
            [
                "strategies.deduplication.enabled",
                "strategies.deduplication.protectedTools",
                "strategies.purgeErrors.enabled",
                "strategies.purgeErrors.turns",
                "strategies.purgeErrors.protectedTools",
            ],
        )
        assert.deepEqual(validateConfigTypes({ strategies: { purgeErrors: { turns: -2 } } }), [
            {
                key: "strategies.purgeErrors.turns",
                expected: "positive number (>= 1)",
                actual: "-2 (will be clamped to 1)",
            },
        ])
        assert.deepEqual(keys({ strategies: { deduplication: {}, purgeErrors: {} } }), [])
    })
})

describe("getConfig", () => {
    test("returns shipped defaults and creates a global config file when none exists", () => {
        clearGlobalConfig()
        const { ctx } = makeCtx()
        const config = getConfig(ctx)

        assert.equal(config.enabled, true)
        assert.equal(config.autoUpdate, true)
        assert.equal(config.debug, false)
        assert.equal(config.pruneNotification, "detailed")
        assert.equal(config.pruneNotificationType, "toast")
        assert.equal(config.manualMode.enabled, false)
        assert.equal(config.manualMode.automaticStrategies, true)
        assert.equal(config.turnProtection.enabled, false)
        assert.equal(config.turnProtection.turns, 4)
        assert.equal(config.experimental.allowSubAgents, false)
        assert.equal(config.experimental.customPrompts, false)
        assert.deepEqual(config.protectedFilePatterns, [])
        assert.equal(config.compress.mode, "range")
        assert.equal(config.compress.permission, "allow")
        assert.equal(config.compress.toolName, "dcp_compress")
        assert.equal(config.compress.showCompression, false)
        assert.equal(config.compress.summaryBuffer, true)
        assert.equal(config.compress.maxContextLimit, "85%")
        assert.equal(config.compress.minContextLimit, "60%")
        assert.equal(config.compress.nudgeFrequency, 5)
        assert.equal(config.compress.iterationNudgeThreshold, 15)
        assert.equal(config.compress.nudgeForce, "soft")
        assert.deepEqual(config.compress.protectedTools, ["task", "skill", "todowrite", "todoread"])
        assert.equal(config.compress.protectTags, false)
        assert.equal(config.compress.protectUserMessages, false)
        assert.equal(config.strategies.deduplication.enabled, true)
        assert.equal(config.strategies.purgeErrors.enabled, true)
        assert.equal(config.strategies.purgeErrors.turns, 4)
        assert.deepEqual(config.commands.protectedTools, [
            "task",
            "skill",
            "todowrite",
            "todoread",
            "compress",
            "batch",
            "plan_enter",
            "plan_exit",
            "write",
            "edit",
        ])

        assert.equal(existsSync(globalJsonc), true)
        assert.match(readFileSync(globalJsonc, "utf-8"), /dcp\.schema\.json/)
    })

    test("merges JSONC global overrides, keeping false/0 and deduplicating arrays", () => {
        writeGlobalConfig(`{
  // a JSONC comment
  "enabled": false,
  "pruneNotification": "off",
  "protectedFilePatterns": ["src/**", "src/**", "dist/**"],
  "commands": {
    "enabled": false,
    "protectedTools": ["task", "custom-tool"]
  },
  "compress": {
    "mode": "message",
    "toolName": "my_compressor",
    "maxContextLimit": "90%",
    "minContextLimit": 50000,
    "modelMaxLimits": { "anthropic/claude": "75%" },
    "nudgeFrequency": 0,
    "protectedTools": ["task", "extra"],
    "protectTags": true
  },
  "strategies": {
    "deduplication": { "enabled": false, "protectedTools": ["dedup-tool"] },
    "purgeErrors": { "turns": 0 }
  },
}`)
        const { ctx, toasts } = makeCtx()
        // Zero thresholds are preserved by the merge but still produce validation warnings.
        const config = getConfigWithWarnings(ctx, toasts)

        assert.equal(toasts.length, 1)
        assert.match(toasts[0].body.message, /compress\.nudgeFrequency: expected positive number/)
        assert.equal(config.enabled, false)
        assert.equal(config.pruneNotification, "off")
        assert.equal(compressToolName(config), "my_compressor")
        assert.deepEqual(config.protectedFilePatterns, ["src/**", "dist/**"])
        assert.equal(config.commands.enabled, false)
        assert.deepEqual(config.commands.protectedTools, [
            "task",
            "skill",
            "todowrite",
            "todoread",
            "compress",
            "batch",
            "plan_enter",
            "plan_exit",
            "write",
            "edit",
            "custom-tool",
        ])
        assert.equal(config.compress.mode, "message")
        assert.equal(config.compress.maxContextLimit, "90%")
        assert.equal(config.compress.minContextLimit, 50_000)
        assert.deepEqual(config.compress.modelMaxLimits, { "anthropic/claude": "75%" })
        assert.equal(config.compress.nudgeFrequency, 0)
        assert.deepEqual(config.compress.protectedTools, [
            "task",
            "skill",
            "todowrite",
            "todoread",
            "extra",
        ])
        assert.equal(config.compress.protectTags, true)
        assert.equal(config.strategies.deduplication.enabled, false)
        assert.deepEqual(config.strategies.deduplication.protectedTools, ["dedup-tool"])
        assert.equal(config.strategies.purgeErrors.turns, 0)
    })

    test("uses dcp.json when dcp.jsonc is absent", () => {
        writeGlobalConfig('{"debug": true}', "dcp.json")
        const { ctx } = makeCtx()
        assert.equal(getConfig(ctx).debug, true)
    })

    test("OPENCODE_CONFIG_DIR and project .opencode configs layer on top of global", () => {
        writeGlobalConfig('{"enabled": false, "debug": false, "compress": {"mode": "message"}}')
        const configDir = makeTempDir("dcp-config-dir-")
        writeFileSync(
            join(configDir, "dcp.json"),
            JSON.stringify({
                debug: true,
                pruneNotification: "minimal",
                compress: { nudgeForce: "strong" },
            }),
        )
        process.env.OPENCODE_CONFIG_DIR = configDir
        const projectDir = makeTempDir("dcp-project-")
        const opencodeDir = join(projectDir, ".opencode")
        mkdirSync(opencodeDir)
        writeFileSync(
            join(opencodeDir, "dcp.jsonc"),
            `{
  "pruneNotification": "detailed",
  "manualMode": { "enabled": true, "automaticStrategies": false },
  "compress": { "mode": "range", "showCompression": true },
  "experimental": { "allowSubAgents": true }
}`,
        )
        // A lower-priority dcp.json must not override the project dcp.jsonc.
        writeFileSync(join(opencodeDir, "dcp.json"), '{"compress":{"mode":"message"}}')

        const { ctx } = makeCtx(projectDir)
        const config = getConfig(ctx)

        assert.equal(config.enabled, false, "global value survives when not overridden")
        assert.equal(config.debug, true, "configDir overrides global")
        assert.equal(config.pruneNotification, "detailed", "project overrides configDir")
        assert.equal(config.compress.nudgeForce, "strong", "configDir compress override survives")
        assert.equal(config.compress.mode, "range", "project compress override wins")
        assert.equal(config.compress.showCompression, true)
        assert.equal(config.manualMode.enabled, true)
        assert.equal(config.manualMode.automaticStrategies, false)
        assert.equal(config.experimental.allowSubAgents, true)
    })

    test("ignores empty config files and warns using the previous layer's values", () => {
        writeGlobalConfig("")
        const { ctx, toasts } = makeCtx()
        const config = getConfigWithWarnings(ctx, toasts)

        assert.equal(config.enabled, true)
        assert.equal(toasts.length, 1)
        assert.equal(toasts[0].body.title, "DCP: Invalid config")
        assert.match(toasts[0].body.message, /Config file is empty or invalid/)
        assert.match(toasts[0].body.message, /Using previous\/default values/)
        assert.equal(toasts[0].body.variant, "warning")
        assert.equal(toasts[0].body.duration, 7000)
    })

    test("warns about unknown keys and type errors, including overflow counts", () => {
        writeGlobalConfig(`{
  "bogusOne": 1,
  "bogusTwo": 2,
  "bogusThree": 3,
  "bogusFour": 4,
  "enabled": "yes",
  "debug": 1,
  "pruneNotificationType": "popup"
}`)
        const { ctx, toasts } = makeCtx()
        getConfigWithWarnings(ctx, toasts)

        assert.equal(toasts.length, 1)
        const body = toasts[0].body
        assert.equal(body.title, "DCP: config warning")
        assert.match(body.message, /Unknown keys: bogusOne, bogusTwo, bogusThree \(\+1 more\)/)
        assert.match(body.message, /enabled: expected boolean, got string/)
        assert.match(body.message, /debug: expected boolean, got number/)
        assert.match(body.message, /\(\+1 more type errors\)/)
    })

    test("project-layer warnings are titled as project config warnings", () => {
        writeGlobalConfig('{"enabled": true}')
        const projectDir = makeTempDir("dcp-project-warn-")
        const opencodeDir = join(projectDir, ".opencode")
        mkdirSync(opencodeDir)
        writeFileSync(join(opencodeDir, "dcp.json"), '{"unknownProjectKey": 1}')

        const { ctx, toasts } = makeCtx(projectDir)
        getConfigWithWarnings(ctx, toasts)

        assert.equal(toasts.length, 1)
        assert.equal(toasts[0].body.title, "DCP: project config warning")
        assert.match(toasts[0].body.message, /Unknown keys: unknownProjectKey/)
    })

    test("returns deep clones so callers cannot mutate the default config", () => {
        clearGlobalConfig()
        const { ctx } = makeCtx()
        const first = getConfig(ctx)
        first.enabled = false
        first.commands.protectedTools.push("leaked")
        first.compress.protectedTools.push("leaked")
        first.strategies.purgeErrors.protectedTools.push("leaked")
        first.protectedFilePatterns.push("leaked")
        first.compress.modelMaxLimits = { "p/m": 1 }

        const second = getConfig(ctx)
        assert.equal(second.enabled, true)
        assert.equal(second.commands.protectedTools.includes("leaked"), false)
        assert.equal(second.compress.protectedTools.includes("leaked"), false)
        assert.equal(second.strategies.purgeErrors.protectedTools.includes("leaked"), false)
        assert.deepEqual(second.protectedFilePatterns, [])
        assert.deepEqual(second.compress.modelMaxLimits, {})
    })
})

describe("integrations config", () => {
    test("integrations keys are recognised", () => {
        for (const key of [
            "integrations",
            "integrations.tokenEconomizer",
            "integrations.beads",
            "integrations.beadsPrefix",
        ]) {
            assert.ok(VALID_CONFIG_KEYS.has(key), key)
        }
        assert.deepEqual(
            getInvalidConfigKeys({ integrations: { tokenEconomizer: "auto", bogus: true } }),
            ["integrations.bogus"],
        )
    })

    test("valid integrations values pass validation", () => {
        assert.deepEqual(
            validateConfigTypes({
                integrations: { tokenEconomizer: "auto", beads: "off", beadsPrefix: "acme" },
            }),
            [],
        )
        assert.deepEqual(
            validateConfigTypes({
                integrations: { tokenEconomizer: "off", beads: "auto", beadsPrefix: null },
            }),
            [],
        )
        assert.deepEqual(validateConfigTypes({}), [])
    })

    test("invalid integrations values and shapes are reported", () => {
        for (const bad of [null, [], "auto", 7]) {
            assert.deepEqual(validateConfigTypes({ integrations: bad }), [
                { key: "integrations", expected: "object", actual: typeof bad },
            ])
        }
        assert.deepEqual(
            validateConfigTypes({
                integrations: {
                    tokenEconomizer: "always",
                    beads: 1,
                    beadsPrefix: 42,
                },
            }).map((error) => error.key),
            ["integrations.tokenEconomizer", "integrations.beads", "integrations.beadsPrefix"],
        )
    })

    test("no integrations block means both integrations are off", () => {
        clearGlobalConfig()
        const { ctx } = makeCtx()
        const config = getConfig(ctx)
        assert.deepEqual(config.integrations, {
            tokenEconomizer: "off",
            beads: "off",
            beadsPrefix: null,
        })
    })

    test("integrations overrides merge across layers and preserve explicit null", () => {
        writeGlobalConfig(
            JSON.stringify({
                integrations: { tokenEconomizer: "auto", beadsPrefix: "global-prefix" },
            }),
        )
        const { ctx } = makeCtx()
        const config = getConfig(ctx)
        assert.deepEqual(config.integrations, {
            tokenEconomizer: "auto",
            beads: "off",
            beadsPrefix: "global-prefix",
        })
    })

    test("integrations are deep-cloned so callers cannot mutate the defaults", () => {
        clearGlobalConfig()
        const { ctx } = makeCtx()
        const first = getConfig(ctx)
        first.integrations.beadsPrefix = "leaked"
        const second = getConfig(ctx)
        assert.equal(second.integrations.beadsPrefix, null)
    })
})
