import type { SessionState, WithParts } from "./types";
import type { Logger } from "../logger";
import type { IdFormat } from "../message-ids";
export declare const checkSession: (client: any, state: SessionState, logger: Logger, messages: WithParts[], manualModeDefault: boolean) => Promise<void>;
export declare function createSessionState(idFormat?: IdFormat): SessionState;
export declare function resetSessionState(state: SessionState): void;
/**
 * Runs operations that await while mutating one shared state one at a time. The legacy server
 * shares a single state across sessions, so awaited token counts must not interleave there.
 */
export declare function exclusive<T>(state: SessionState, operation: () => Promise<T>): Promise<T>;
export declare function ensureSessionInitialized(client: any, state: SessionState, sessionId: string, logger: Logger, messages: WithParts[], manualModeEnabled: boolean): Promise<void>;
export declare function refreshManualMode(state: SessionState, sessionId: string, logger: Logger, manualModeDefault: boolean): Promise<void>;
//# sourceMappingURL=state.d.ts.map