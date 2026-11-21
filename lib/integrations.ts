import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import type { IntegrationsConfig } from "./config"
import { countTokens } from "./token-utils"

// ---------------------------------------------------------------------------
// TokenEconomizer detection
// ---------------------------------------------------------------------------

/** Stable marker TE injects into its system part. Keep in sync with TE. */
export const TOKEN_ECONOMIZER_MARKER = "<tokeneconomizer-manual>"

/**
 * Fallback for unmarked (older) TE versions. The `TokenEconomizer --` header
 * must start a line, so ordinary prose that merely mentions the tool cannot
 * trigger detection.
 */
const TOKEN_ECONOMIZER_HEADER = /^[ \t]*TokenEconomizer[ \t]+--[ \t]+\S/m

export function isTokenEconomizerPart(text: string): boolean {
    if (typeof text !== "string") return false
    return text.includes(TOKEN_ECONOMIZER_MARKER) || TOKEN_ECONOMIZER_HEADER.test(text)
}

export function detectTokenEconomizer(systemParts: readonly string[]): boolean {
    return systemParts.some(isTokenEconomizerPart)
}

// ---------------------------------------------------------------------------
// TokenEconomizer system-part preservation
// ---------------------------------------------------------------------------

export interface SystemPromptPlacement {
    /** Final system strings after DCP's prompt has been placed. */
    system: string[]
    /** True when a detected TE manual was kept intact as its own part. */
    tePreserved: boolean
}

/**
 * Append DCP's prompt without corrupting a detected TokenEconomizer manual.
 *
 * When TE is active, its part is left byte-identical and DCP's prompt is
 * appended as a NEW part after it, so the manual is never below DCP's prompt.
 * When TE is off or absent, behaviour is exactly as before: append to the last
 * part, or push when there are none.
 */
export function placeSystemPrompt(
    systemParts: readonly string[],
    dcpPrompt: string,
    options: { tokenEconomizer: boolean },
): SystemPromptPlacement {
    if (options.tokenEconomizer && detectTokenEconomizer(systemParts)) {
        return { system: [...systemParts, dcpPrompt], tePreserved: true }
    }
    const system = [...systemParts]
    if (system.length > 0) system[system.length - 1] += "\n\n" + dcpPrompt
    else system.push(dcpPrompt)
    return { system, tePreserved: false }
}

/**
 * Rebuild system parts from the (possibly extended) text array, keeping each
 * original part's metadata by index. Trailing parts added by DCP get default
 * metadata only.
 */
export function mapSystemTextsToParts<T extends { text: string }>(
    original: readonly T[],
    texts: readonly string[],
): T[] {
    return texts.map((text, index) => ({ ...(original[index] ?? {}), type: "text", text })) as T[]
}

/** Total tokens of the final system prompt, including any TE manual part. */
export async function countSystemPromptTokens(systemParts: readonly string[]): Promise<number> {
    return countTokens(systemParts.join("\n"))
}

/**
 * Remove a TokenEconomizer manual that a model copied into a compression
 * summary. It already lives in every request's system prompt, so keeping it in
 * a summary would duplicate it. Only well-formed marked blocks and the legacy
 * header form are removed; ordinary prose is left untouched.
 */
export function stripTokenEconomizerManual(summary: string): string {
    let out = summary.replace(/<tokeneconomizer-manual>[\s\S]*?<\/tokeneconomizer-manual>/gi, "")
    const open = out.indexOf(TOKEN_ECONOMIZER_MARKER)
    if (open !== -1) out = out.slice(0, open)
    out = out.replace(
        /^[ \t]*TokenEconomizer[ \t]+--[ \t]+[^\n]*(?:\n[ \t]*(?:[-*+]|\d+\.)[^\n]*)*/gm,
        "",
    )
    if (out === summary) return summary
    return out.replace(/\n{3,}/g, "\n\n").trimEnd()
}


/**
 * Extract the active TokenEconomizer fact patterns from detected TE manual text.
 *
 * Cheap and deterministic: for every system part that is a TE manual, take the
 * bullet fact lines (minus their bullet marker) and dedupe them. Returns [] when
 * TE is not detected or no facts are present, so callers can treat an empty
 * result as "no boost". TE being off / not detected yields no patterns.
 */
export function extractTokenEconomizerFactPatterns(systemParts: readonly string[]): string[] {
    const seen = new Set<string>()
    const patterns: string[] = []
    for (const part of systemParts) {
        if (typeof part !== "string" || !isTokenEconomizerPart(part)) continue
        // Prefer the marked block when a marker is present; otherwise use the
        // whole part (legacy header form).
        let body = part
        const openIdx = body.indexOf(TOKEN_ECONOMIZER_MARKER)
        if (openIdx !== -1) {
            const closeIdx = body.indexOf("</tokeneconomizer-manual>", openIdx)
            if (closeIdx !== -1) {
                body = body.slice(openIdx + TOKEN_ECONOMIZER_MARKER.length, closeIdx)
            } else {
                body = body.slice(openIdx + TOKEN_ECONOMIZER_MARKER.length)
            }
        }
        for (const rawLine of body.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line) continue
            if (line === TOKEN_ECONOMIZER_MARKER) continue
            if (/^<\/tokeneconomizer-manual>$/i.test(line)) continue
            if (/^TokenEconomizer\s+--/i.test(line)) continue
            const match = line.match(/^[-*+]\s+(.*)$/)
            if (!match) continue
            const fact = match[1].trim()
            if (!fact) continue
            if (seen.has(fact)) continue
            seen.add(fact)
            patterns.push(fact)
        }
    }
    return patterns
}


// ---------------------------------------------------------------------------
// Beads detection
// ---------------------------------------------------------------------------

/** System boundary: run a read-only `bd` command and return its stdout. */
export type BdCommandRunner = (
    args: readonly string[],
    opts: { cwd: string; timeoutMs: number },
) => Promise<string>

export const DEFAULT_BD_TIMEOUT_MS = 1500

const execFileAsync = promisify(execFile)

export const defaultBdRunner: BdCommandRunner = async (args, { cwd, timeoutMs }) => {
    const { stdout } = await execFileAsync("bd", [...args], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
    })
    return stdout
}

function findBeadsDir(startDir: string): string | null {
    let current = startDir
    while (true) {
        const candidate = join(current, ".beads")
        if (existsSync(candidate)) {
            try {
                if (statSync(candidate).isDirectory()) return candidate
            } catch {
                // unreadable entry: keep walking up
            }
        }
        const parent = dirname(current)
        if (parent === current) return null
        current = parent
    }
}

function extractPrefix(stdout: string): string | null {
    try {
        const parsed = JSON.parse(stdout)
        if (typeof parsed?.prefix === "string" && parsed.prefix) return parsed.prefix
    } catch {
        // fall through to the textual forms below
    }
    return (
        stdout.match(/"prefix"\s*:\s*"([^"]+)"/)?.[1] ??
        stdout.match(/^\s*prefix:\s*(\S+)/m)?.[1] ??
        null
    )
}

export interface BeadsDetection {
    detected: boolean
    prefix: string | null
    workspaceDir: string | null
}

export interface DetectBeadsOptions {
    directory: string
    /** Injectable CLI boundary; defaults to a short-timeout `bd where --json`. */
    run?: BdCommandRunner
    timeoutMs?: number
}

/**
 * Read-only, short-timeout, fail-open. A `.beads` directory marks an active
 * workspace; `bd where --json` resolves the prefix from that workspace's
 * metadata. Any error (missing CLI, timeout, bad output) reports "not detected".
 */
export async function detectBeads(options: DetectBeadsOptions): Promise<BeadsDetection> {
    const notDetected: BeadsDetection = { detected: false, prefix: null, workspaceDir: null }
    try {
        const workspaceDir = findBeadsDir(options.directory)
        if (!workspaceDir) return notDetected

        const run = options.run ?? defaultBdRunner
        const stdout = await run(["where", "--json"], {
            cwd: options.directory,
            timeoutMs: options.timeoutMs ?? DEFAULT_BD_TIMEOUT_MS,
        })
        const prefix = extractPrefix(stdout)
        if (!prefix) return notDetected
        return { detected: true, prefix, workspaceDir }
    } catch {
        return notDetected
    }
}

// ---------------------------------------------------------------------------
// Resolved state (public seam for the other integration tickets)
// ---------------------------------------------------------------------------

export interface ResolvedIntegrations {
    /** TokenEconomizer integration is enabled AND detected. */
    tokenEconomizer: boolean
    /** Beads integration is enabled AND detected. */
    beads: boolean
    tokenEconomizerDetected: boolean
    beadsDetected: boolean
    /** Explicit config prefix, else the detected prefix, else null. */
    beadsPrefix: string | null
}

export interface ResolveIntegrationsOptions {
    config: IntegrationsConfig
    directory: string
    /** Text of the current request's system parts (v2: `event.system.map(p => p.text)`). */
    systemParts?: readonly string[]
    run?: BdCommandRunner
    timeoutMs?: number
}

export async function resolveIntegrations(
    options: ResolveIntegrationsOptions,
): Promise<ResolvedIntegrations> {
    const teDetected = detectTokenEconomizer(options.systemParts ?? [])
    // "off" means do not even look at Beads: no subprocess, no tracker access.
    const beads =
        options.config.beads === "off"
            ? { detected: false, prefix: null }
            : await detectBeads({
                  directory: options.directory,
                  ...(options.run ? { run: options.run } : {}),
                  ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
              })

    return {
        tokenEconomizer: options.config.tokenEconomizer === "auto" && teDetected,
        beads: options.config.beads === "auto" && beads.detected,
        tokenEconomizerDetected: teDetected,
        beadsDetected: beads.detected,
        beadsPrefix: options.config.beadsPrefix ?? beads.prefix,
    }
}
