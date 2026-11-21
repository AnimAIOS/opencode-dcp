import type { SessionState, WithParts } from "../../state";
import type { PluginConfig } from "../../config";
/**
 * Occupancy guidance for compressed blocks. Block summaries stay in the model's
 * context forever, and in a heavily compressed session they are the largest
 * occupants - but the model only ever saw their labels, so it concluded there
 * was nothing left to compress. Making their cost visible and giving the model
 * an explicit decision order (drop what is no longer needed, merge only what
 * must survive the whole session, leave anything uncertain alone) fixes that
 * blind spot.
 */
export declare function buildCompressedBlockGuidance(state: SessionState): string;
export declare function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string;
export declare function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string;
/**
 * Size visibility for uncompressed messages. The model sees this content but
 * has no cost model for it, so manual compress triggers fixate on recent text
 * while hundreds of KB of old tool outputs ride along in every request.
 * Naming the top offenders (with their message refs) makes them targetable.
 */
export declare function buildMessageOccupancyGuidance(state: SessionState, config: PluginConfig, messages: WithParts[]): string;
//# sourceMappingURL=nudge.d.ts.map