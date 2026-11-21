import { SessionState, ToolParameterEntry, WithParts } from "../state";
export declare function formatStatsHeader(totalTokensSaved: number, pruneTokenCounter: number): string;
/**
 * Every DCP chat notification carries this marker. The V2 request view uses it
 * to keep UI notifications out of the model's context, since the V2 host never
 * strips `ignored` parts. Only the marker prefix matches: manual-trigger
 * prompts start with their own marker (<compress triggered manually>) and must
 * stay visible to the model.
 */
export declare const DCP_CHAT_MARKER = "\u25A3 DCP";
export declare function isDcpChatText(text: string | undefined | null): boolean;
export declare function formatTokenCount(tokens: number, compact?: boolean): string;
export declare function truncate(str: string, maxLen?: number): string;
export declare function formatProgressBar(messageIds: string[], prunedMessages: Map<string, number>, recentMessageIds: string[], width?: number): string;
export declare function cacheSystemPromptTokens(state: SessionState, messages: WithParts[]): Promise<void>;
export declare function shortenPath(input: string, workingDirectory?: string): string;
export declare function formatPrunedItemsList(pruneToolIds: string[], toolMetadata: Map<string, ToolParameterEntry>, workingDirectory?: string): string[];
export declare function formatPruningResultForTool(prunedIds: string[], toolMetadata: Map<string, ToolParameterEntry>, workingDirectory?: string): string;
//# sourceMappingURL=utils.d.ts.map