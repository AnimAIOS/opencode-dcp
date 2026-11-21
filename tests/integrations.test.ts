import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach, describe } from "node:test"
import {
    DEFAULT_BD_TIMEOUT_MS,
    detectBeads,
    detectTokenEconomizer,
    isTokenEconomizerPart,
    resolveIntegrations,
    TOKEN_ECONOMIZER_MARKER,
    type BdCommandRunner,
} from "../lib/integrations"

const tempDirs: string[] = []

function makeDir(withBeads: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "dcp-integrations-"))
    tempDirs.push(dir)
    if (withBeads) mkdirSync(join(dir, ".beads"))
    return dir
}

function runnerReturning(
    stdout: string,
    calls?: Array<{ args: readonly string[]; cwd: string }>,
): BdCommandRunner {
    return async (args, opts) => {
        calls?.push({ args, cwd: opts.cwd })
        return stdout
    }
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("TokenEconomizer detection", () => {
    test("recognises the stable marker in an injected system part", () => {
        const part = `Some preamble\n${TOKEN_ECONOMIZER_MARKER}\n- repo: DCP prunes tool outputs`
        assert.equal(isTokenEconomizerPart(part), true)
        assert.equal(detectTokenEconomizer(["ordinary system prompt", part]), true)
    })

    test("falls back to the unmarked 'TokenEconomizer --' header", () => {
        const part = "TokenEconomizer -- Learned Facts\n- DCP is a compression plugin"
        assert.equal(isTokenEconomizerPart(part), true)
    })

    test("does not false-positive on ordinary text mentioning TokenEconomizer", () => {
        const ordinary = [
            "The user asked how TokenEconomizer works.",
            "We discussed TokenEconomizer in the previous turn -- see notes.",
            "Inline reference: read the TokenEconomizer -- header section in the docs.",
            "tokeneconomizer -- lowercase is not the header",
        ]
        for (const text of ordinary) {
            assert.equal(isTokenEconomizerPart(text), false, text)
        }
        assert.equal(detectTokenEconomizer(ordinary), false)
    })

    test("handles an empty system part list", () => {
        assert.equal(detectTokenEconomizer([]), false)
    })
})

describe("Beads detection", () => {
    test("reports not detected when there is no .beads workspace", async () => {
        const dir = makeDir(false)
        const result = await detectBeads({
            directory: dir,
            run: runnerReturning(JSON.stringify({ prefix: "should-not-be-used" })),
        })
        assert.deepEqual(result, { detected: false, prefix: null, workspaceDir: null })
    })

    test("detects an active workspace and resolves the prefix from bd where metadata", async () => {
        const dir = makeDir(true)
        const calls: Array<{ args: readonly string[]; cwd: string }> = []
        const result = await detectBeads({
            directory: dir,
            run: runnerReturning(JSON.stringify({ prefix: "opencode-dcp" }), calls),
        })
        assert.equal(result.detected, true)
        assert.equal(result.prefix, "opencode-dcp")
        assert.equal(result.workspaceDir, join(dir, ".beads"))
        assert.deepEqual(calls[0].args, ["where", "--json"])
        assert.equal(calls[0].cwd, dir)
    })

    test("finds a .beads workspace in a parent directory", async () => {
        const root = makeDir(true)
        const nested = join(root, "a", "b")
        mkdirSync(nested, { recursive: true })
        const result = await detectBeads({
            directory: nested,
            run: runnerReturning(JSON.stringify({ prefix: "parent-prefix" })),
        })
        assert.equal(result.detected, true)
        assert.equal(result.prefix, "parent-prefix")
    })

    test("fails open when the bd CLI is missing", async () => {
        const dir = makeDir(true)
        const result = await detectBeads({
            directory: dir,
            run: async () => {
                throw new Error("spawn bd ENOENT")
            },
        })
        assert.deepEqual(result, { detected: false, prefix: null, workspaceDir: null })
    })

    test("fails open on malformed or empty CLI output", async () => {
        const dir = makeDir(true)
        for (const stdout of ["not json", "{}", ""]) {
            const result = await detectBeads({ directory: dir, run: runnerReturning(stdout) })
            assert.deepEqual(result, { detected: false, prefix: null, workspaceDir: null })
        }
    })

    test("uses a short timeout for the CLI call", async () => {
        const dir = makeDir(true)
        let seenTimeout = 0
        await detectBeads({
            directory: dir,
            timeoutMs: 250,
            run: async (_args, opts) => {
                seenTimeout = opts.timeoutMs
                return JSON.stringify({ prefix: "p" })
            },
        })
        assert.equal(seenTimeout, 250)
        assert.ok(DEFAULT_BD_TIMEOUT_MS <= 2000)
    })
})

describe("resolveIntegrations", () => {
    const off = { tokenEconomizer: "off" as const, beads: "off" as const, beadsPrefix: null }
    const detectedRun = runnerReturning(JSON.stringify({ prefix: "detected-prefix" }))

    test("both integrations are inactive by default and when modes are off", async () => {
        const dir = makeDir(true)
        const result = await resolveIntegrations({
            config: off,
            directory: dir,
            systemParts: [TOKEN_ECONOMIZER_MARKER],
            run: detectedRun,
        })
        assert.equal(result.tokenEconomizer, false)
        assert.equal(result.beads, false)
    })

    test("auto mode activates only detected integrations", async () => {
        const dir = makeDir(true)
        const result = await resolveIntegrations({
            config: { tokenEconomizer: "auto", beads: "auto", beadsPrefix: null },
            directory: dir,
            systemParts: ["plain system prompt"],
            run: detectedRun,
        })
        assert.equal(result.tokenEconomizer, false)
        assert.equal(result.beads, true)
        assert.equal(result.beadsPrefix, "detected-prefix")
        assert.equal(result.tokenEconomizerDetected, false)
        assert.equal(result.beadsDetected, true)
    })

    test("auto mode activates TokenEconomizer when its marker is present", async () => {
        const dir = makeDir(false)
        const result = await resolveIntegrations({
            config: { tokenEconomizer: "auto", beads: "auto", beadsPrefix: null },
            directory: dir,
            systemParts: [`<tokeneconomizer-manual>\n- fact`],
        })
        assert.equal(result.tokenEconomizer, true)
        assert.equal(result.tokenEconomizerDetected, true)
        assert.equal(result.beads, false)
    })

    test("off overrides detection for each integration independently", async () => {
        const dir = makeDir(true)
        const teOff = await resolveIntegrations({
            config: { tokenEconomizer: "off", beads: "auto", beadsPrefix: null },
            directory: dir,
            systemParts: [TOKEN_ECONOMIZER_MARKER],
            run: detectedRun,
        })
        assert.equal(teOff.tokenEconomizer, false)
        assert.equal(teOff.tokenEconomizerDetected, true)
        assert.equal(teOff.beads, true)

        const beadsOff = await resolveIntegrations({
            config: { tokenEconomizer: "auto", beads: "off", beadsPrefix: null },
            directory: dir,
            systemParts: [TOKEN_ECONOMIZER_MARKER],
            run: detectedRun,
        })
        assert.equal(beadsOff.beads, false)
        assert.equal(beadsOff.tokenEconomizer, true)
    })

    test("an explicit beadsPrefix overrides the detected one; null means detect", async () => {
        const dir = makeDir(true)
        const explicit = await resolveIntegrations({
            config: { tokenEconomizer: "off", beads: "auto", beadsPrefix: "my-co" },
            directory: dir,
            run: detectedRun,
        })
        assert.equal(explicit.beadsPrefix, "my-co")

        const detected = await resolveIntegrations({
            config: { tokenEconomizer: "off", beads: "auto", beadsPrefix: null },
            directory: dir,
            run: detectedRun,
        })
        assert.equal(detected.beadsPrefix, "detected-prefix")
    })

    test("a missing CLI fails open through resolveIntegrations", async () => {
        const dir = makeDir(true)
        const result = await resolveIntegrations({
            config: { tokenEconomizer: "auto", beads: "auto", beadsPrefix: null },
            directory: dir,
            run: async () => {
                throw new Error("bd unavailable")
            },
        })
        assert.equal(result.beads, false)
        assert.equal(result.beadsDetected, false)
        assert.equal(result.beadsPrefix, null)
    })
})
