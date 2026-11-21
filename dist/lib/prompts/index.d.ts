import type { RuntimePrompts } from "./store";
export type { PromptStore, RuntimePrompts } from "./store";
/**
 * Rewrite generic "compress tool" mentions in model-facing prompt text to the
 * configured tool name. The sleev gateway shadows the literal name "compress"
 * on the wire (it injects its own `compress` tool into every request), so
 * prompt text must reference DCP's actual registered name. Prompts written
 * for the legacy name need no rewrite.
 */
export declare const withCompressToolName: (text: string, toolName: string) => string;
export declare function renderSystemPrompt(prompts: RuntimePrompts, protectedToolsExtension?: string, manual?: boolean, subagent?: boolean, toolName?: string): string;
//# sourceMappingURL=index.d.ts.map