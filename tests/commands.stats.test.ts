import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test, { after, afterEach, before, mock } from "node:test"
import { stateDir } from "./lab/persistence-env"
import { buildStatsReport, formatStatsMessage, handleStatsCommand } from "../lib/commands/stats"
import { Logger } from "../lib/logger"
import { createSessionState, type CompressionBlock, type WithParts } from "../lib/state"

const persistedStatsPath = join(stateDir, "dcp-stats-command-test.json")
const allTime = {
    totalTokens: 5000,
    totalSummaryTokens: 500,
    totalDurationMs: 65_000,
    totalTools: 7,
    totalMessages: 3,
    sessionCount: 2,
}

before(() => {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
        persistedStatsPath,
        JSON.stringify({
            stats: { totalPruneTokens: 5000, pruneTokenCounter: 0 },
            prune: {},
            compression: {
                inputTokens: allTime.totalTokens,
                summaryTokens: allTime.totalSummaryTokens,
                durationMs: allTime.totalDurationMs,
                tools: allTime.totalTools,
                messages: allTime.totalMessages,
            },
        }),
    )
})

after(() => {
    rmSync(persistedStatsPath, { force: true })
})

afterEach(() => {
    mock.restoreAll()
})

function buildBlock(
    blockId: number,
    runId: number,
    mode: "message" | "range",
    active: boolean,
    durationMs: number,
    summaryTokens: number,
    effectiveToolIds: string[],
): CompressionBlock {
    return {
        blockId,
        runId,
        active,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens,
        durationMs,
        mode,
        topic: `topic-${blockId}`,
        batchTopic: mode === "message" ? "batch-notes" : undefined,
        startId: `m${blockId}`,
        endId: `m${blockId}`,
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `origin-${runId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [`msg-${blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds,
        createdAt: blockId,
        summary: `summary-${blockId}`,
    }
}

function stateWithCompression() {
    const state = createSessionState()
    state.stats.totalPruneTokens = 1234
    state.prune.tools.set("t1", 10)
    const blocks = [
        buildBlock(1, 10, "message", true, 100, 50, ["t2"]),
        buildBlock(2, 10, "message", true, 200, 60, ["t3"]),
        buildBlock(3, 11, "range", false, 999, 500, ["t4"]),
    ]
    for (const block of blocks) state.prune.messages.blocksById.set(block.blockId, block)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeBlockIds.add(2)
    state.prune.messages.byMessageId.set("m1", {
        tokenCount: 10,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.byMessageId.set("m2", {
        tokenCount: 10,
        allBlockIds: [2],
        activeBlockIds: [2],
    })
    state.prune.messages.byMessageId.set("m3", {
        tokenCount: 10,
        allBlockIds: [],
        activeBlockIds: [],
    })
    return state
}

function userMessage(): WithParts {
    return {
        info: {
            id: "msg-user",
            role: "user",
            sessionID: "ses_stats_cmd",
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        },
        parts: [{ type: "text", text: "show stats" }],
    } as unknown as WithParts
}

test("formatStatsMessage renders session and all-time stats with formatted units", () => {
    const message = formatStatsMessage(1200, 300, 4, 2, 1250, allTime)

    assert.match(message, /DCP Statistics/)
    assert.match(message, /Compression:/)
    assert.match(message, /Tokens in\|out:\s+~1\.2K tokens \| ~300 tokens/)
    assert.match(message, /Ratio:\s+4:1/)
    assert.match(message, /Time:\s+1\.3 s/)
    assert.match(message, /Messages:\s+2/)
    assert.match(message, /Tools:\s+4/)
    assert.match(message, /All-time:/)
    assert.match(message, /Tokens in\|out:\s+~5K tokens \| ~500 tokens/)
    assert.match(message, /Ratio:\s+10:1/)
    assert.match(message, /Time:\s+1m 5s/)
    assert.match(message, /Tools:\s+7/)
    assert.match(message, /Sessions:\s+2/)
})

test("formatStatsMessage handles zero, infinite, rounded and hour-scale values", () => {
    const zero = formatStatsMessage(0, 0, 0, 0, -5, {
        totalTokens: 0,
        totalSummaryTokens: 0,
        totalDurationMs: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    })
    assert.match(zero, /Ratio:\s+0:1/)
    assert.match(zero, /Time:\s+0 ms/)
    assert.match(zero, /~0 tokens/)

    const infinite = formatStatsMessage(100, 0, 0, 0, 500, allTime)
    assert.match(infinite, /Ratio:\s+∞:1/)
    assert.match(infinite, /Time:\s+500 ms/)

    const rounded = formatStatsMessage(3, 5, 0, 0, 59_900, allTime)
    assert.match(rounded, /Ratio:\s+1:1/)
    assert.match(rounded, /Time:\s+59\.9 s/)

    const minute = formatStatsMessage(100, 10, 0, 0, 60_000, allTime)
    assert.match(minute, /Time:\s+1m 0s/)

    const hour = formatStatsMessage(100, 10, 0, 0, 3_661_000, allTime)
    assert.match(hour, /Time:\s+1h 1m 1s/)
})

test("buildStatsReport aggregates active-only tokens, grouped durations and all-time storage", async () => {
    const report = await buildStatsReport(stateWithCompression(), new Logger(false))

    assert.equal(report.sessionTokens, 1234)
    assert.equal(report.sessionSummaryTokens, 110)
    assert.equal(
        report.sessionDurationMs,
        200,
        "grouped message runs count their max duration once",
    )
    assert.equal(report.sessionTools, 3)
    assert.equal(report.sessionMessages, 2)
    assert.deepEqual(report.allTime, { ...allTime, sessionCount: 1 })
})

test("handleStatsCommand sends the report and logs its metrics", async () => {
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

    await handleStatsCommand({
        client,
        state: stateWithCompression(),
        logger,
        sessionId: "ses_stats_cmd",
        messages: [userMessage()],
    })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].path.id, "ses_stats_cmd")
    assert.equal(sent[0].body.noReply, true)
    assert.equal(sent[0].body.parts[0].ignored, true)
    assert.equal(sent[0].body.agent, "assistant")
    assert.deepEqual(sent[0].body.model, { providerID: "anthropic", modelID: "claude-test" })
    const text = sent[0].body.parts[0].text as string
    assert.match(text, /^▣ DCP\n╭─+╮\n│\s+DCP Statistics/)
    assert.match(text, /~1\.2K tokens \| ~110 tokens/)
    assert.match(text, /Time:\s+200 ms/)
    assert.match(text, /All-time:/)
    assert.match(text, /Tokens in\|out:\s+~5K tokens \| ~500 tokens/)

    const logCall = infoCalls.find(([message]) => message === "Stats command executed")
    assert.ok(logCall, "expected the stats command to log its metrics")
    assert.deepEqual(logCall![1], {
        sessionTokens: 1234,
        sessionSummaryTokens: 110,
        sessionTools: 3,
        sessionMessages: 2,
        sessionDurationMs: 200,
        allTimeTokens: allTime.totalTokens,
        allTimeTools: allTime.totalTools,
        allTimeMessages: allTime.totalMessages,
    })
})
