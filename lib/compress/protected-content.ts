import type { SessionState } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import { escapeRegExpChar, isToolProtected, type BeadsProtection } from "../protected-patterns"
import {
    buildSubagentResultText,
    extractTaskResultBody,
    getSubAgentId,
    mergeSubagentResult,
} from "../subagents/subagent-results"
import { fetchSessionMessages } from "./search"
import type { SearchContext, SelectionResolution } from "./types"

export function appendProtectedUserMessages(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const userTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                userTexts.push(part.text)
                break
            }
        }
    }

    if (userTexts.length === 0) {
        return summary
    }

    const heading = "\n\nThe following user messages were sent in this conversation verbatim:"
    const body = userTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function appendProtectedPromptInfo(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
    beads?: BeadsProtection,
): string {
    // Beads protection is independent of the protectTags flag.
    if (!enabled && beads?.active !== true) return summary

    const protectedTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "text" || typeof part.text !== "string") continue

            protectedTexts.push(...extractProtectedPromptInfo(part.text, beads, enabled))
        }
    }

    if (protectedTexts.length === 0) {
        return summary
    }

    const heading =
        "\n\nThe following protected prompt information was included in this conversation verbatim:"
    const body = protectedTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function extractProtectedPromptInfo(
    text: string,
    beads?: BeadsProtection,
    protectTags = true,
): string[] {
    const protectedTexts: string[] = []
    const seen = new Set<string>()
    const add = (value: string | undefined) => {
        const trimmed = value?.trim()
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed)
            protectedTexts.push(trimmed)
        }
    }

    if (protectTags) {
        const protectTagRegex = /<protect>([\s\S]*?)<\/protect>/gi
        for (const match of text.matchAll(protectTagRegex)) add(match[1])
    }

    if (beads?.active !== true) return protectedTexts

    // `--skills` is the skill-router handoff contract: keep every occurrence
    // byte-identical, including the field name and its full value.
    for (const line of text.split(/\r?\n/)) {
        if (/\bbd\s+(?:create|show|ready|update|dep|close)\b/.test(line)) add(line)
        for (const field of line.matchAll(/--skills[^\r\n]*/g)) add(field[0])
    }

    if (beads.prefix) {
        const escaped = [...beads.prefix].map(escapeRegExpChar).join("")
        const beadIdRegex = new RegExp(`\\b${escaped}-[0-9A-Za-z][0-9A-Za-z.-]*`, "g")
        for (const match of text.matchAll(beadIdRegex)) add(match[0])
    }

    return protectedTexts
}

export function appendCompressionDigest(
    summary: string,
    messageCount: number,
    toolOutputCount: number,
): string {
    return `${summary}\n<!-- dcp-compress: ${messageCount} messages, ${toolOutputCount} tool outputs -->`
}

export function countProtectedToolOutputs(
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
    beads?: BeadsProtection,
): number {
    let count = 0
    for (const messageId of selection.messageIds) {
        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) continue
            const output =
                part.state?.status === "completed" && part.state?.output
                    ? typeof part.state.output === "string"
                        ? part.state.output
                        : JSON.stringify(part.state.output)
                    : ""
            if (
                isToolProtected(
                    part.tool,
                    part.state.input,
                    protectedTools,
                    protectedFilePatterns,
                    "metadata" in part.state ? part.state.metadata : undefined,
                    beads,
                ) &&
                output
            ) {
                count++
            }
        }
    }
    return count
}

export async function appendProtectedTools(
    client: any,
    state: SessionState,
    allowSubAgents: boolean,
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
    beads?: BeadsProtection,
    digest?: number | boolean | { messageCount?: number; messages?: number; toolOutputCount?: number; toolOutputs?: number; enabled?: boolean },
    digestEnabled?: boolean,
): Promise<string> {
    const protectedOutputs: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                if (
                    isToolProtected(
                        part.tool,
                        part.state.input,
                        protectedTools,
                        protectedFilePatterns,
                        "metadata" in part.state ? part.state.metadata : undefined,
                        beads,
                    )
                ) {
                    const title = `Tool: ${part.tool}`
                    let output = ""

                    if (part.state?.status === "completed" && part.state?.output) {
                        output =
                            typeof part.state.output === "string"
                                ? part.state.output
                                : JSON.stringify(part.state.output)
                    }

                    if (
                        allowSubAgents &&
                        (part.tool === "task" || part.tool === "subagent") &&
                        part.state?.status === "completed" &&
                        typeof part.state?.output === "string"
                    ) {
                        const cachedSubAgentResult = state.subAgentResultCache.get(part.callID)

                        if (cachedSubAgentResult !== undefined) {
                            if (cachedSubAgentResult) {
                                output = mergeSubagentResult(
                                    part.state.output,
                                    cachedSubAgentResult,
                                )
                            }
                        } else {
                            const extractedResult = extractTaskResultBody(part.state.output)
                            if (extractedResult) {
                                state.subAgentResultCache.set(part.callID, extractedResult)
                                output = mergeSubagentResult(part.state.output, extractedResult)
                            } else {
                                const subAgentSessionId = getSubAgentId(part)
                                if (subAgentSessionId) {
                                    let subAgentResultText = ""
                                    try {
                                        const subAgentMessages = await fetchSessionMessages(
                                            client,
                                            subAgentSessionId,
                                        )
                                        subAgentResultText = buildSubagentResultText(subAgentMessages)
                                    } catch {
                                        subAgentResultText = ""
                                    }

                                    if (subAgentResultText) {
                                        state.subAgentResultCache.set(part.callID, subAgentResultText)
                                        output = mergeSubagentResult(
                                            part.state.output,
                                            subAgentResultText,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    if (output) {
                        protectedOutputs.push(`\n### ${title}\n${output}`)
                    }
                }
            }
        }
    }

    let digestRequested = digestEnabled === true
    let digestMessageCount: number | undefined
    let digestToolOutputCount: number | undefined
    if (typeof digest === "number") {
        digestRequested = true
        digestMessageCount = digest
    } else if (digest === true) {
        digestRequested = true
    } else if (digest && typeof digest === "object") {
        digestRequested = digest.enabled !== false
        digestMessageCount = digest.messageCount ?? digest.messages
        digestToolOutputCount = digest.toolOutputCount ?? digest.toolOutputs
    }
    if (digestRequested && digestMessageCount === undefined) {
        digestMessageCount = selection.messageIds.length
    }
    const digestCount = digestMessageCount ?? selection.messageIds.length

    if (protectedOutputs.length === 0) {
        if (digestRequested) {
            return appendCompressionDigest(summary, digestCount, digestToolOutputCount ?? 0)
        }
        return summary
    }

    const heading = "\n\nThe following protected tools were used in this conversation as well:"
    const withTools = summary + heading + protectedOutputs.join("")
    if (digestRequested) {
        return appendCompressionDigest(withTools, digestCount, digestToolOutputCount ?? protectedOutputs.length)
    }
    return withTools
}
