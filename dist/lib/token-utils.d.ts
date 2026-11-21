import { SessionState, WithParts } from "./state";
import { Logger } from "./logger";
export declare function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): Promise<number>;
export declare function getCurrentParams(state: SessionState, messages: WithParts[], logger: Logger): {
    providerId: string | undefined;
    modelId: string | undefined;
    agent: string | undefined;
    variant: string | undefined;
};
/** Exact count off the host event loop; rejects with TokenCountError instead of estimating. */
export declare function countTokens(text: string): Promise<number>;
export declare function estimateTokensBatch(texts: string[]): Promise<number>;
export declare const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]";
export declare function extractCompletedToolOutput(part: any): string | undefined;
export declare function extractToolContent(part: any): string[];
export declare function countToolTokens(part: any): Promise<number>;
export declare function getTotalToolTokens(state: SessionState, toolIds: string[]): number;
export declare function countMessageTextTokens(msg: WithParts): Promise<number>;
export declare function countAllMessageTokens(msg: WithParts): Promise<number>;
//# sourceMappingURL=token-utils.d.ts.map