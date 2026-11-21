import type { PluginInput } from "@opencode-ai/plugin";
type ConfigContext = Pick<PluginInput, "directory"> & {
    client: {
        tui: {
            showToast(input: {
                body: {
                    title: string;
                    message: string;
                    variant: "warning";
                    duration: number;
                };
            }): unknown;
        };
    };
};
type Permission = "ask" | "allow" | "deny";
type CompressMode = "range" | "message";
export interface Deduplication {
    enabled: boolean;
    protectedTools: string[];
}
export declare const compressToolName: (config: PluginConfig) => string;
export interface CompressConfig {
    mode: CompressMode;
    permission: Permission;
    /**
     * Model-facing name under which DCP registers its compress tool.
     *
     * Defaults to "dcp_compress" (see compressToolName) so the tool cannot be
     * shadowed by another tool named "compress" injected between the host and
     * the model. The sleev gateway injects its own `compress` tool into every
     * completion request and synthesizes the tool result itself, which
     * silently replaced DCP's registration on the wire. Permission rules keep
     * using the "compress" action label regardless of this name.
     */
    toolName?: string;
    showCompression: boolean;
    summaryBuffer: boolean;
    maxContextLimit: number | `${number}%`;
    minContextLimit: number | `${number}%`;
    modelMaxLimits?: Record<string, number | `${number}%`>;
    modelMinLimits?: Record<string, number | `${number}%`>;
    nudgeFrequency: number;
    iterationNudgeThreshold: number;
    nudgeForce: "strong" | "soft";
    protectedTools: string[];
    protectTags: boolean;
    protectUserMessages: boolean;
}
export interface Commands {
    enabled: boolean;
    protectedTools: string[];
}
export interface ManualModeConfig {
    enabled: boolean;
    automaticStrategies: boolean;
}
export interface PurgeErrors {
    enabled: boolean;
    turns: number;
    protectedTools: string[];
}
export interface TurnProtection {
    enabled: boolean;
    turns: number;
}
export interface ExperimentalConfig {
    allowSubAgents: boolean;
    customPrompts: boolean;
}
export interface PluginConfig {
    enabled: boolean;
    autoUpdate: boolean;
    debug: boolean;
    pruneNotification: "off" | "minimal" | "detailed";
    pruneNotificationType: "chat" | "toast";
    commands: Commands;
    manualMode: ManualModeConfig;
    turnProtection: TurnProtection;
    experimental: ExperimentalConfig;
    protectedFilePatterns: string[];
    compress: CompressConfig;
    strategies: {
        deduplication: Deduplication;
        purgeErrors: PurgeErrors;
    };
}
export declare const VALID_CONFIG_KEYS: Set<string>;
export declare function getInvalidConfigKeys(userConfig: Record<string, any>): string[];
interface ValidationError {
    key: string;
    expected: string;
    actual: string;
}
export declare function validateConfigTypes(config: Record<string, any>): ValidationError[];
export declare function getConfig(ctx: ConfigContext): PluginConfig;
export {};
//# sourceMappingURL=config.d.ts.map