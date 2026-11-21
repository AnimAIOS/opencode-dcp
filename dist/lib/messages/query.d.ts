import type { PluginConfig } from "../config";
import type { WithParts } from "../state";
export declare const getLastUserMessage: (messages: WithParts[], startIndex?: number) => WithParts | null;
export { LEGACY_COMPRESS_TOOL_NAME, DEFAULT_COMPRESS_TOOL_NAME, } from "../tool-name";
/**
 * True when a session message part belongs to DCP's compress tool. Accepts the
 * legacy "compress" name so parts recorded by older sessions keep resolving
 * after the tool was renamed (the sleev gateway shadows the name "compress" on
 * the wire, which is why DCP's tool now registers as "dcp_compress").
 */
export declare const isCompressToolPart: (part: any) => boolean;
export declare const messageHasCompress: (message: WithParts) => boolean;
export declare const isIgnoredUserMessage: (message: WithParts) => boolean;
export declare function isProtectedUserMessage(config: PluginConfig, message: WithParts): boolean;
//# sourceMappingURL=query.d.ts.map