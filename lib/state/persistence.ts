/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { randomBytes } from "crypto"
import { homedir } from "os"
import { join } from "path"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"

/** Monotonic counter making each atomic-write temp path unique within a process. */
let tmpSequence = 0

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    manualMode?: boolean
    prune: PersistedPrune
    compression?: PersistedCompressionStats
    nudges: PersistedNudges
    stats: SessionStats
    lastUpdated: string
}

export interface PersistedCompressionStats {
    inputTokens: number
    summaryTokens: number
    durationMs: number
    tools: number
    messages: number
}

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

async function ensureStorageDir(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
        await fs.mkdir(STORAGE_DIR, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json`)
}

export function derivePersistedCompressionStats(
    prune: PersistedPrune,
    stats: SessionStats,
): PersistedCompressionStats {
    const messages = prune.messages
    const blocks = Object.values(messages?.blocksById || {})
    const activeBlocks = blocks.filter((block) => block.active)
    const activeToolIds = new Set<string>(Object.keys(prune.tools || {}))
    for (const block of activeBlocks) {
        for (const toolId of block.effectiveToolIds || []) {
            activeToolIds.add(toolId)
        }
    }

    const groupedDurations = new Map<number, number>()
    const rangeDurationMs = activeBlocks.reduce((total, block) => {
        if (block.mode === "message") {
            const current = groupedDurations.get(block.runId) || 0
            groupedDurations.set(block.runId, Math.max(current, block.durationMs || 0))
            return total
        }

        return total + (block.durationMs || 0)
    }, 0)

    const groupedDurationMs = Array.from(groupedDurations.values()).reduce(
        (total, durationMs) => total + durationMs,
        0,
    )

    return {
        inputTokens: stats.totalPruneTokens,
        summaryTokens: activeBlocks.reduce((total, block) => total + (block.summaryTokens || 0), 0),
        durationMs: rangeDurationMs + groupedDurationMs,
        tools: activeToolIds.size,
        messages: Object.values(messages?.byMessageId || {}).reduce(
            (total, entry) => total + (entry.activeBlockIds?.length > 0 ? 1 : 0),
            0,
        ),
    }
}


async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
): Promise<void> {
    await ensureStorageDir()

    const filePath = getSessionFilePath(sessionId)
    const content = JSON.stringify(state, null, 2)
    // Write via temp file + rename so a kill/restart mid-write can never leave
    // a truncated JSON file behind (a truncated file would fail to load on the
    // next start and previously lost every compression block).
    // The suffix must be unique per call: saves for the same session can run
    // concurrently (fire-and-forget inject saves vs awaited tool saves), and a
    // shared name lets two writers interleave (write/write/rename/ENOENT).
    const tmpPath = `${filePath}.${process.pid}.${tmpSequence++}.${randomBytes(4).toString("hex")}.tmp`
    await fs.writeFile(tmpPath, content, "utf-8")
    await fs.rename(tmpPath, filePath)

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved: state.stats.totalPruneTokens,
    })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return
        }

        // The on-disk state exists but is unreadable for this session. Refuse
        // to write: otherwise the first write-through after a failed load
        // would replace the only copy of the compression blocks with a
        // near-empty state, silently destroying them.
        if (sessionState.persistedLoadFailed) {
            logger.warn("Refusing to overwrite unreadable state file", {
                sessionId: sessionState.sessionId,
            })
            return
        }

        const prune: PersistedPrune = {
            tools: Object.fromEntries(sessionState.prune.tools),
            messages: {
                byMessageId: Object.fromEntries(sessionState.prune.messages.byMessageId),
                blocksById: Object.fromEntries(
                    Array.from(sessionState.prune.messages.blocksById.entries()).map(
                        ([blockId, block]) => [String(blockId), block],
                    ),
                ),
                activeBlockIds: Array.from(sessionState.prune.messages.activeBlockIds),
                activeByAnchorMessageId: Object.fromEntries(
                    sessionState.prune.messages.activeByAnchorMessageId,
                ),
                nextBlockId: sessionState.prune.messages.nextBlockId,
                nextRunId: sessionState.prune.messages.nextRunId,
            },
        }

        const state: PersistedSessionState = {
            sessionName: sessionName,
            manualMode: !!sessionState.manualMode,
            prune,
            compression: derivePersistedCompressionStats(prune, sessionState.stats),
            nudges: {
                contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
                turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
                iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
            },
            stats: sessionState.stats,
            lastUpdated: new Date().toISOString(),
        }

        await writePersistedSessionState(sessionState.sessionId, state, logger)
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        })
    }
}

export function sessionStateFileExists(sessionId: string): boolean {
    return existsSync(getSessionFilePath(sessionId))
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneTools ||
            !hasPruneMessages ||
            !state.stats ||
            !hasNudgeFormat
        ) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.nudges.contextLimitAnchors = dedupedAnchors

        const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : []
        const validSoftAnchors = rawTurnNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
            logger.warn("Filtered out malformed turnNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawTurnNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.nudges.turnNudgeAnchors = dedupedSoftAnchors

        const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : []
        const validIterationAnchors = rawIterationNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
        if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
            logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawIterationNudgeAnchors.length,
                valid: validIterationAnchors.length,
            })
        }
        state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

export async function deleteSessionState(sessionId: string): Promise<void> {
    const filePath = getSessionFilePath(sessionId)
    try {
        await fs.unlink(filePath)
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error
    }
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
    return {
        manualMode,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        lastUpdated: new Date().toISOString(),
    }
}

export async function loadManualModeSetting(
    sessionId: string,
    logger: Logger,
): Promise<boolean | undefined> {
    const state = await loadSessionState(sessionId, logger)
    return typeof state?.manualMode === "boolean" ? state.manualMode : undefined
}

export async function saveManualModeSetting(
    sessionId: string,
    manualMode: boolean,
    logger: Logger,
): Promise<void> {
    const existing = await loadSessionState(sessionId, logger)
    if (!existing && sessionStateFileExists(sessionId)) {
        logger.warn("Refusing to overwrite unreadable state file", {
            sessionId,
        })
        return
    }
    const state = existing ?? emptyPersistedState(manualMode)
    state.manualMode = manualMode
    state.lastUpdated = new Date().toISOString()
    await writePersistedSessionState(sessionId, state, logger)
}

export interface AggregatedStats {
    totalTokens: number
    totalSummaryTokens: number
    totalDurationMs: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalSummaryTokens: 0,
        totalDurationMs: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        if (!existsSync(STORAGE_DIR)) {
            return result
        }

        const files = await fs.readdir(STORAGE_DIR)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(STORAGE_DIR, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    const compression =
                        state.compression ||
                        // LEGACY: Older session files do not have derived compression stats yet.
                        // Keep this reconstruction path during migration, then delete it once old
                        // persisted state is no longer relevant.
                        derivePersistedCompressionStats(state.prune, state.stats)

                    result.totalTokens += compression.inputTokens
                    result.totalSummaryTokens += compression.summaryTokens
                    result.totalDurationMs += compression.durationMs
                    result.totalTools += compression.tools
                    result.totalMessages += compression.messages
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
