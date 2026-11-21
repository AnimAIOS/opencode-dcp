import type { PluginConfig } from "../config"
import { escapeRegExpChar } from "../protected-patterns"
import {
    DEFAULT_BD_TIMEOUT_MS,
    defaultBdRunner,
    extractTokenEconomizerFactPatterns,
    resolveIntegrations,
    type BdCommandRunner,
} from "../integrations"
import { countAllMessageTokens } from "../token-utils"
import { isMessageCompacted } from "../state/utils"
import type { SessionState, WithParts } from "../state"
import { isIgnoredUserMessage, isProtectedUserMessage, messageHasCompress } from "./query"

const MEDIUM_PRIORITY_MIN_TOKENS = 500
const HIGH_PRIORITY_MIN_TOKENS = 5000

export type MessagePriority = "low" | "medium" | "high"

export interface CompressionPriorityEntry {
    ref: string
    tokenCount: number
    priority: MessagePriority
}

export type CompressionPriorityMap = Map<string, CompressionPriorityEntry>


export interface BuildPriorityMapOptions {
    directory?: string
    run?: BdCommandRunner
    timeoutMs?: number
    systemParts?: readonly string[]
    beads?: { active: boolean; prefix: string | null }
}

function normalizeBuildPriorityMapOptions(rest: unknown[]): BuildPriorityMapOptions {
    const options: BuildPriorityMapOptions = {}
    for (const arg of rest) {
        if (arg == null) continue
        if (typeof arg === "string") {
            if (!options.directory) options.directory = arg
            continue
        }
        if (typeof arg === "function") {
            if (!options.run) options.run = arg as BdCommandRunner
            continue
        }
        if (typeof arg !== "object") continue
        const o = arg as Record<string, unknown>
        // A bare BeadsProtection / {active,prefix} object.
        if (
            typeof o.active === "boolean" &&
            "prefix" in o &&
            !("directory" in o) &&
            !("run" in o) &&
            !("timeoutMs" in o) &&
            !("systemParts" in o) &&
            !("beads" in o)
        ) {
            options.beads = { active: o.active, prefix: (o.prefix as string | null) ?? null }
            continue
        }
        if (typeof o.directory === "string") options.directory = o.directory
        if (typeof o.run === "function") options.run = o.run as BdCommandRunner
        if (typeof o.timeoutMs === "number") options.timeoutMs = o.timeoutMs
        if (Array.isArray(o.systemParts)) options.systemParts = o.systemParts as readonly string[]
        if (o.beads && typeof o.beads === "object") {
            const b = o.beads as Record<string, unknown>
            if (typeof b.active === "boolean") {
                options.beads = { active: b.active, prefix: (b.prefix as string | null) ?? null }
            }
        }
    }
    return options
}

function integrationsConfigOf(config: PluginConfig): {
    tokenEconomizer: "auto" | "off"
    beads: "auto" | "off"
    beadsPrefix: string | null
} {
    const cfg = (config as { integrations?: any })?.integrations
    if (!cfg || typeof cfg !== "object") {
        return { tokenEconomizer: "off", beads: "off", beadsPrefix: null }
    }
    return {
        tokenEconomizer: cfg.tokenEconomizer === "auto" ? "auto" : "off",
        beads: cfg.beads === "auto" ? "auto" : "off",
        beadsPrefix: cfg.beadsPrefix ?? null,
    }
}

function messageText(message: WithParts): string {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts
        .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
        .map((p: any) => p.text)
        .join("\n")
}

function isOpenOrInProgressStatus(status: string): boolean {
    const normalized = status.trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-")
    return normalized === "open" || normalized === "in-progress" || normalized === "inprogress"
}

async function readBeadStatuses(
    options: BuildPriorityMapOptions,
    directory: string,
): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const run = options.run ?? defaultBdRunner
    const timeoutMs = options.timeoutMs ?? DEFAULT_BD_TIMEOUT_MS
    const stdout = await run(["ready", "--json"], { cwd: directory, timeoutMs })
    let parsed: any
    try {
        parsed = JSON.parse(stdout)
    } catch {
        return result
    }
    const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.issues)
          ? parsed.issues
          : Array.isArray(parsed?.data)
            ? parsed.data
            : Array.isArray(parsed?.items)
              ? parsed.items
              : []
    for (const item of items) {
        if (!item || typeof item !== "object") continue
        const id = item.id ?? item.issue_id ?? item.issueId ?? item.beadId
        const status = item.status ?? item.state ?? item.statusLabel
        if (typeof id === "string" && id.length > 0) {
            result.set(id, typeof status === "string" ? status : String(status ?? ""))
        }
    }
    return result
}

export async function buildPriorityMap(
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
    ...rest: unknown[]
): Promise<CompressionPriorityMap> {
    if (config.compress.mode !== "message") {
        return new Map()
    }
    const options = normalizeBuildPriorityMapOptions(rest)
    const priorities: CompressionPriorityMap = new Map()

    // Integration-aware boost: resolve integration state (off/not-detected => no boost).
    const integrationsConfig = integrationsConfigOf(config)
    const directory = options.directory ?? process.cwd()
    let beadsActive = options.beads?.active === true
    let beadsPrefix = options.beads?.prefix ?? null
    let teActive = false
    // Resolve TE (and Beads, when not explicitly provided) from the available
    // system parts. `resolveIntegrations` is the single gate for TE activation.
    if (options.beads === undefined || options.systemParts !== undefined) {
        try {
            const resolveConfig =
                options.beads === undefined
                    ? integrationsConfig
                    : { ...integrationsConfig, beads: "off" as const }
            const resolved = await resolveIntegrations({
                config: resolveConfig,
                directory,
                ...(options.systemParts ? { systemParts: options.systemParts } : {}),
                ...(options.run ? { run: options.run } : {}),
                ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            })
            teActive = resolved.tokenEconomizer === true
            if (options.beads === undefined) {
                beadsActive = resolved.beads
                beadsPrefix = resolved.beadsPrefix
            }
        } catch {
            teActive = false
            if (options.beads === undefined) {
                beadsActive = false
                beadsPrefix = null
            }
        }
    }
    if (integrationsConfig.beads === "off") {
        beadsActive = false
    }
    if (integrationsConfig.tokenEconomizer === "off") {
        teActive = false
    }
    // Active TE fact patterns (empty when TE is off/not detected/no facts).
    const teFacts = teActive
        ? extractTokenEconomizerFactPatterns(options.systemParts ?? [])
        : []

    let beadStatuses = new Map<string, string>()
    if (beadsActive && beadsPrefix) {
        try {
            beadStatuses = await readBeadStatuses(options, directory)
        } catch {
            beadStatuses = new Map()
        }
    }

    const beadIdRegex =
        beadsActive && beadsPrefix
            ? new RegExp(
                  `\\b${[...beadsPrefix].map(escapeRegExpChar).join("")}-[0-9A-Za-z][0-9A-Za-z.-]*`,
                  "g",
              )
            : null

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        if (isProtectedUserMessage(config, message)) {
            continue
        }

        if (isMessageCompacted(state, message)) {
            continue
        }

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
            continue
        }

        const ref = state.messageIds.byRawId.get(rawMessageId)
        if (!ref) {
            continue
        }

        const tokenCount = await countAllMessageTokens(message)
        let priority: MessagePriority = messageHasCompress(message)
            ? "high"
            : classifyMessagePriority(tokenCount)

        if (beadIdRegex) {
            const text = messageText(message)
            const ids = new Set<string>()
            for (const match of text.matchAll(beadIdRegex)) ids.add(match[0])
            let boost = false
            for (const id of ids) {
                const status = beadStatuses.get(id)
                if (status !== undefined && isOpenOrInProgressStatus(status)) {
                    boost = true
                    break
                }
            }
            if (boost && priority !== "high") priority = "high"
        }

        // TE-aware boost: messages mentioning an active TE fact pattern.
        if (teFacts.length > 0) {
            const text = messageText(message).toLowerCase()
            const mentionsFact = teFacts.some((fact) => text.includes(fact.toLowerCase()))
            if (mentionsFact && priority !== "high") priority = "high"
        }

        priorities.set(rawMessageId, {
            ref,
            tokenCount,
            priority,
        })
    }

    return priorities
}

export function classifyMessagePriority(tokenCount: number): MessagePriority {
    if (tokenCount >= HIGH_PRIORITY_MIN_TOKENS) {
        return "high"
    }

    if (tokenCount >= MEDIUM_PRIORITY_MIN_TOKENS) {
        return "medium"
    }

    return "low"
}

export function listPriorityRefsBeforeIndex(
    messages: WithParts[],
    priorities: CompressionPriorityMap,
    anchorIndex: number,
    priority: MessagePriority,
): string[] {
    const refs: string[] = []
    const seen = new Set<string>()
    const upperBound = Math.max(0, Math.min(anchorIndex, messages.length))

    for (let index = 0; index < upperBound; index++) {
        const rawMessageId = messages[index]?.info.id
        if (typeof rawMessageId !== "string") {
            continue
        }

        const entry = priorities.get(rawMessageId)
        if (!entry || entry.priority !== priority || seen.has(entry.ref)) {
            continue
        }

        seen.add(entry.ref)
        refs.push(entry.ref)
    }

    return refs
}
