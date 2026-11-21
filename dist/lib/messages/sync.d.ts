import type { SessionState, WithParts } from "../state";
import type { Logger } from "../logger";
/**
 * Recompute block liveness against the current message window.
 *
 * Returns true when any block's liveness changed, so callers can persist the
 * new state to disk immediately (write-through) instead of relying on the
 * next incidental save.
 *
 * A block stays active unless the user deactivated it or a newer block
 * consumed it. A block whose origin message (compressMessageId) or anchor is
 * missing from the current window REMAINS ACTIVE: request windows roll, so a
 * missing origin only means "not visible right now". Range filtering is keyed
 * by raw message ids (filterCompressedRanges), so an out-of-window block is a
 * harmless no-op that becomes live again when its range re-enters the window
 * (e.g. after a restart restores the full history). Deactivating on a missing
 * origin used to permanently kill compression whenever the origin scrolled out
 * of a truncated window, and the deactivation was then persisted to disk.
 */
export declare const syncCompressionBlocks: (state: SessionState, logger: Logger, messages: WithParts[]) => boolean;
//# sourceMappingURL=sync.d.ts.map