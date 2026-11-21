import type { WithParts } from "../state";
import type { ToolContext } from "./types";
import type { SearchContext } from "./types";
interface RunContext {
    ask(input: {
        permission: string;
        patterns: string[];
        always: string[];
        metadata: Record<string, unknown>;
    }): Promise<void>;
    metadata(input: {
        title: string;
    }): void;
    sessionID: string;
}
export interface NotificationEntry {
    blockId: number;
    runId: number;
    summary: string;
    summaryTokens: number;
}
export interface PreparedSession {
    rawMessages: WithParts[];
    searchContext: SearchContext;
}
/** Checks manual mode and asks permission; runs before the state lock, as approval may wait. */
export declare function authoriseCompression(ctx: ToolContext, toolCtx: RunContext, title: string): Promise<void>;
/** Call within exclusive(ctx.state, ...) so no other operation can switch the shared state. */
export declare function prepareSession(ctx: ToolContext, toolCtx: RunContext): Promise<PreparedSession>;
export declare function finalizeSession(ctx: ToolContext, toolCtx: RunContext, rawMessages: WithParts[], entries: NotificationEntry[], batchTopic: string | undefined): Promise<void>;
export {};
//# sourceMappingURL=pipeline.d.ts.map