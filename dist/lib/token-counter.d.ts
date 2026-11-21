export type TokenCountErrorCode = "too_large" | "queue_full" | "queue_timeout" | "timeout" | "unavailable" | "protocol" | "crashed" | "encode" | "disposed";
export declare class TokenCountError extends Error {
    readonly code: TokenCountErrorCode;
    constructor(code: TokenCountErrorCode);
}
export interface TokenCounterLimits {
    /** Largest accepted text, in UTF-16 code units. Larger text is rejected, never truncated. */
    maxTextLength: number;
    /** Maximum queued (not yet dispatched) jobs. */
    maxQueuedJobs: number;
    /** Maximum aggregate queued text, in UTF-16 code units. */
    maxQueuedTextLength: number;
    /** Maximum time a job may wait in the queue before dispatch. */
    queueTimeoutMs: number;
    /** Child process startup and handshake deadline. */
    startupTimeoutMs: number;
    /** Active counting deadline; the child kills itself when it expires. */
    jobTimeoutMs: number;
    /** Extra parent-side allowance beyond the child's own deadline before the parent kills it. */
    killMarginMs: number;
    /** Time allowed for a killed child to be reaped before the service stays unavailable. */
    reapTimeoutMs: number;
    /** Idle time after which the child is shut down. */
    idleTimeoutMs: number;
}
export declare const DEFAULT_TOKEN_COUNTER_LIMITS: TokenCounterLimits;
export declare class TokenCounter {
    private readonly limits;
    private readonly dir;
    private queue;
    private queuedTextLength;
    private nextId;
    private child;
    private ready;
    private active;
    private activeTimer;
    private activeDeadline;
    private idleTimer;
    private startupTimer;
    private reaping;
    private unavailable;
    private disposed;
    private stdout;
    private readonly killOnExit;
    constructor(limits?: Partial<TokenCounterLimits>, dir?: string);
    /** Exact token count. Rejects with TokenCountError rather than estimating. */
    count(text: string): Promise<number>;
    /** Kills any child and rejects every pending job. */
    dispose(): Promise<void>;
    /** Test/diagnostic view; never contains text. */
    get stats(): {
        pid: number | undefined;
        queued: number;
        queuedTextLength: number;
        active: boolean;
        unavailable: boolean;
    };
    private remove;
    private pump;
    private start;
    private receive;
    private finish;
    /** An idle child must not keep the host process alive. */
    private setRef;
    private armIdle;
    /** Fails the active job (and queued jobs if the child never started), then replaces the child. */
    private fail;
    private failAll;
    /** SIGKILLs the child and waits for it to be reaped before allowing a replacement. */
    private stopChild;
}
/** Shared per-bundle counting service; its child starts on the first count. */
export declare const tokenCounter: TokenCounter;
//# sourceMappingURL=token-counter.d.ts.map