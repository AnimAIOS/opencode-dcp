import type { SessionState, WithParts } from "../state";
import type { Logger } from "../logger";
export declare function hasCompressHistory(messages: WithParts[]): boolean;
export declare function reconstructFromHistory(state: SessionState, logger: Logger, messages: WithParts[]): Promise<number>;
//# sourceMappingURL=reconstruct.d.ts.map