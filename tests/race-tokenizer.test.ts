// Child-process concurrency for the tokenizer sidecar. The production queue
// dispatches one job at a time, but callers issue many overlapping count()
// promises. These tests use a deterministic fake sidecar so every response is
// provably paired with its own request and a timeout cannot misroute a count.
import assert from "node:assert/strict"
import test from "node:test"
import { copyFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { TokenCounter, TokenCountError } from "../lib/token-counter"

const sidecars = fileURLToPath(new URL("../lib/tokenizer/", import.meta.url))
const tmpDirs: string[] = []
test.after(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tmpDirs.push(dir)
    return dir
}

/**
 * Fake sidecar. Every job is answered with `text.length`, which is a unique,
 * request-specific oracle. A text containing HANG is never answered at all so
 * the parent's job deadline fires.
 */
function fakeSidecar(): string {
    const dir = makeDir("dcp-race-sidecar-") + "/"
    writeFileSync(dir + "package.json", '{"type":"commonjs"}')
    copyFileSync(
        join(sidecars, "tokenizer-runtime.bunfig.toml"),
        dir + "tokenizer-runtime.bunfig.toml",
    )
    writeFileSync(
        dir + "tokenizer-child.js",
        `const readline = require("node:readline")
const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
say({ ready: 1, protocol: "dcp-tokenizer/1", runtime: "race-fake" })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line)
  if (m.text && m.text.includes("HANG")) return
  say({ id: m.id, count: m.text.length })
})
`,
    )
    return dir
}

function pidAlive(pid: number | undefined): boolean {
    if (!pid || !existsSync(`/proc/${pid}`)) return false
    try {
        return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    } catch {
        return false
    }
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof TokenCountError, String(error))
        assert.equal(error.code, code)
        return true
    })
}

test("tokenizer: many overlapping counts return each caller its own exact result", async () => {
    const counter = new TokenCounter({ startupTimeoutMs: 3000, jobTimeoutMs: 5000 }, fakeSidecar())
    try {
        const texts = Array.from(
            { length: 40 },
            (_, i) => `job-${i}:`.padEnd(20 + i, "x") + `#${i}`,
        )
        const pending = texts.map((text) => counter.count(text))
        // The queue is drained one job at a time by a single child; every caller
        // still holds an independent promise.
        assert.ok(counter.stats.queued > 0 || counter.stats.active, "jobs must be in flight")
        const results = await Promise.all(pending)
        assert.deepEqual(
            results,
            texts.map((text) => text.length),
        )
        assert.equal(counter.stats.queued, 0)
        assert.equal(counter.stats.active, false)
    } finally {
        await counter.dispose()
    }
})

test("tokenizer: a timed-out active job is isolated from the queued jobs that follow it", async () => {
    const counter = new TokenCounter(
        {
            startupTimeoutMs: 3000,
            jobTimeoutMs: 300,
            killMarginMs: 150,
            reapTimeoutMs: 1000,
        },
        fakeSidecar(),
    )
    try {
        const hang = counter.count("HANG-this-job-never-answers")
        const others = Array.from({ length: 12 }, (_, i) => `survivor-${i}-`.repeat(5 + i))
        const queued = others.map((text) => counter.count(text))

        await rejectsWith(hang, "timeout")
        const results = await Promise.all(queued)
        assert.deepEqual(
            results,
            others.map((text) => text.length),
            "no cross-talk after timeout",
        )
        assert.equal(counter.stats.queued, 0)
        assert.equal(counter.stats.active, false)
        // The child was replaced, so the timeout did not leave a zombie behind.
        assert.ok(pidAlive(counter.stats.pid), "a fresh child must serve the queued jobs")
    } finally {
        await counter.dispose()
    }
})

test("tokenizer: disposing with many jobs in flight rejects every waiter, with no partial results", async () => {
    const counter = new TokenCounter(
        { startupTimeoutMs: 3000, jobTimeoutMs: 10_000 },
        fakeSidecar(),
    )
    await counter.count("warm up")
    const pid = counter.stats.pid
    const texts = Array.from({ length: 20 }, (_, i) => `pending-${i}:` + "y".repeat(i * 10))
    const pending = texts.map((text) => counter.count(text))
    const settled = Promise.allSettled(pending)

    await counter.dispose()
    const outcomes = await settled
    assert.equal(outcomes.length, texts.length)
    for (const outcome of outcomes) {
        assert.equal(outcome.status, "rejected")
        if (outcome.status === "rejected") {
            assert.ok(outcome.reason instanceof TokenCountError)
            assert.equal(outcome.reason.code, "disposed")
        }
    }
    assert.equal(counter.stats.queued, 0)
    assert.ok(!pidAlive(pid), "dispose must kill the child")
    await rejectsWith(counter.count("after dispose"), "disposed")
})
