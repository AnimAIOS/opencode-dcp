/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types";
import type { Logger } from "../logger";
export declare function setWriteGateForTests(gate: (() => Promise<void>) | undefined): void;
/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>;
    blocksById: Record<string, CompressionBlock>;
    activeBlockIds: number[];
    activeByAnchorMessageId: Record<string, number>;
    nextBlockId: number;
    nextRunId: number;
}
export interface PersistedPrune {
    tools?: Record<string, number>;
    messages?: PersistedPruneMessagesState;
}
export interface PersistedNudges {
    contextLimitAnchors: string[];
    turnNudgeAnchors?: string[];
    iterationNudgeAnchors?: string[];
}
export interface PersistedSessionState {
    sessionName?: string;
    manualMode?: boolean;
    prune: PersistedPrune;
    compression?: PersistedCompressionStats;
    nudges: PersistedNudges;
    stats: SessionStats;
    lastUpdated: string;
}
export interface PersistedCompressionStats {
    inputTokens: number;
    summaryTokens: number;
    durationMs: number;
    tools: number;
    messages: number;
}
export declare function derivePersistedCompressionStats(prune: PersistedPrune, stats: SessionStats): PersistedCompressionStats;
export declare function saveSessionState(sessionState: SessionState, logger: Logger, sessionName?: string): Promise<void>;
export declare function sessionStateFileExists(sessionId: string): boolean;
export declare function loadSessionState(sessionId: string, logger: Logger): Promise<PersistedSessionState | null>;
export declare function deleteSessionState(sessionId: string): Promise<void>;
export declare function loadManualModeSetting(sessionId: string, logger: Logger): Promise<boolean | undefined>;
export declare function saveManualModeSetting(sessionId: string, manualMode: boolean, logger: Logger): Promise<void>;
export interface AggregatedStats {
    totalTokens: number;
    totalSummaryTokens: number;
    totalDurationMs: number;
    totalTools: number;
    totalMessages: number;
    sessionCount: number;
}
export declare function loadAllSessionStats(logger: Logger): Promise<AggregatedStats>;
//# sourceMappingURL=persistence.d.ts.map