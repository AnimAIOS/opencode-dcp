export declare const rpc: {
    readonly id: "dcp";
    readonly methods: {
        readonly status: {
            readonly input: import("zod").ZodObject<{}, import("zod/v4/core").$strip>;
            readonly output: import("zod").ZodObject<{
                enabled: import("zod").ZodBoolean;
            }, import("zod/v4/core").$strip>;
        };
        readonly snapshot: {
            readonly input: import("zod").ZodObject<{
                sessionID: import("zod").ZodString;
            }, import("zod/v4/core").$strip>;
            readonly output: import("zod").ZodObject<{
                manualMode: import("zod").ZodBoolean;
                canCompress: import("zod").ZodBoolean;
                blockedReason: import("zod").ZodOptional<import("zod").ZodString>;
                context: import("zod").ZodObject<{
                    system: import("zod").ZodNumber;
                    user: import("zod").ZodNumber;
                    assistant: import("zod").ZodNumber;
                    tools: import("zod").ZodNumber;
                    toolCount: import("zod").ZodNumber;
                    toolsInContextCount: import("zod").ZodNumber;
                    prunedTokens: import("zod").ZodNumber;
                    prunedToolCount: import("zod").ZodNumber;
                    prunedMessageCount: import("zod").ZodNumber;
                    total: import("zod").ZodNumber;
                }, import("zod/v4/core").$strip>;
                stats: import("zod").ZodObject<{
                    sessionTokens: import("zod").ZodNumber;
                    sessionSummaryTokens: import("zod").ZodNumber;
                    sessionDurationMs: import("zod").ZodNumber;
                    sessionTools: import("zod").ZodNumber;
                    sessionMessages: import("zod").ZodNumber;
                    allTime: import("zod").ZodObject<{
                        totalTokens: import("zod").ZodNumber;
                        totalSummaryTokens: import("zod").ZodNumber;
                        totalDurationMs: import("zod").ZodNumber;
                        totalTools: import("zod").ZodNumber;
                        totalMessages: import("zod").ZodNumber;
                        sessionCount: import("zod").ZodNumber;
                    }, import("zod/v4/core").$strip>;
                }, import("zod/v4/core").$strip>;
            }, import("zod/v4/core").$strip>;
        };
        readonly manual: {
            readonly input: import("zod").ZodObject<{
                sessionID: import("zod").ZodString;
                enabled: import("zod").ZodBoolean;
            }, import("zod/v4/core").$strip>;
            readonly output: import("zod").ZodObject<{}, import("zod/v4/core").$strip>;
        };
    };
    readonly events: {
        readonly notify: {
            readonly schema: import("zod").ZodObject<{
                title: import("zod").ZodString;
                message: import("zod").ZodString;
                variant: import("zod").ZodOptional<import("zod").ZodEnum<{
                    warning: "warning";
                    error: "error";
                    info: "info";
                    success: "success";
                }>>;
                duration: import("zod").ZodOptional<import("zod").ZodNumber>;
            }, import("zod/v4/core").$strip>;
        };
    };
};
//# sourceMappingURL=rpc.d.ts.map