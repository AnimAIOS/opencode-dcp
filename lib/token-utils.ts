import { SessionState, WithParts } from "./state"
import { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Logger } from "./logger"
import { tokenCounter } from "./token-counter"
import { getLastUserMessage } from "./messages/query"

export async function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): Promise<number> {
    let foundTokens = false
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }

        const assistantInfo = msg.info as AssistantMessage
        if ((assistantInfo.tokens?.output || 0) <= 0) {
            continue
        }
        foundTokens = true

        if (
            state.lastCompaction > 0 &&
            (msg.info.time.created < state.lastCompaction ||
                (msg.info.summary === true && msg.info.time.created === state.lastCompaction))
        ) {
            return 0
        }

        const input = assistantInfo.tokens?.input || 0
        const output = assistantInfo.tokens?.output || 0
        const reasoning = assistantInfo.tokens?.reasoning || 0
        const cacheRead = assistantInfo.tokens?.cache?.read || 0
        const cacheWrite = assistantInfo.tokens?.cache?.write || 0
        const reportedUsage = input + output + reasoning + cacheRead + cacheWrite
        return Math.max(reportedUsage, await estimateCurrentMessageTokenUsage(state, messages))
    }

    if (foundTokens) {
        return 0
    }

    // No assistant message carries token accounting (some v2 storage shapes
    // omit `tokens`). Without a number the nudge thresholds never trip and
    // DCP never asks the model to compress — the exact "v2 never compresses"
    // symptom. Fall back to a content-based estimate; it is a lower bound,
    // which is the safe direction for deciding to nudge.
    const lastMessage = messages[messages.length - 1]
    const key = `${messages.length}:${lastMessage?.info.id ?? ""}`
    if (state.tokenUsageEstimate?.key === key) {
        return state.tokenUsageEstimate.value
    }
    const estimate = await countMessageTokensBatch(messages)
    state.tokenUsageEstimate = { key, value: estimate }
    return estimate
}

async function estimateCurrentMessageTokenUsage(
    state: SessionState,
    messages: WithParts[],
): Promise<number> {
    const live = messages.filter(
        (msg) =>
            !(
                state.lastCompaction > 0 &&
                (msg.info.time.created < state.lastCompaction ||
                    (msg.info.summary === true && msg.info.time.created === state.lastCompaction))
            ),
    )
    return countMessageTokensBatch(live)
}

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: undefined,
        }
    }
    const userInfo = userMsg.info as UserMessage
    const agent: string = userInfo.agent
    const providerId: string | undefined = userInfo.model.providerID
    const modelId: string | undefined = userInfo.model.modelID
    const variant: string | undefined = userInfo.model.variant

    return { providerId, modelId, agent, variant }
}

/** Exact count off the host event loop; rejects with TokenCountError instead of estimating. */
export async function countTokens(text: string): Promise<number> {
    if (!text) return 0
    return tokenCounter.count(text)
}

export async function estimateTokensBatch(texts: string[]): Promise<number> {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "))
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

export function extractCompletedToolOutput(part: any): string | undefined {
    if (
        part?.type !== "tool" ||
        part.state?.status !== "completed" ||
        part.state?.output === undefined
    ) {
        return undefined
    }

    if (part.state?.time?.compacted) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }

    return stringifyToolContent(part.state.output)
}

export function extractToolContent(part: any): string[] {
    const contents: string[] = []

    if (part?.type !== "tool") {
        return contents
    }

    if (part.state?.input !== undefined) {
        contents.push(stringifyToolContent(part.state.input))
    }

    const completedOutput = extractCompletedToolOutput(part)
    if (completedOutput !== undefined) {
        contents.push(completedOutput)
    } else if (part.state?.status === "error" && part.state?.error) {
        contents.push(stringifyToolContent(part.state.error))
    }

    return contents
}

export async function countToolTokens(part: any): Promise<number> {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

export async function countMessageTextTokens(msg: WithParts): Promise<number> {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export async function countAllMessageTokens(msg: WithParts): Promise<number> {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        } else {
            texts.push(...extractToolContent(part))
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

/** Counts a whole session's messages in one child round-trip (counting each part separately
 *  would pay the spawn/handshake cost per message). */
async function countMessageTokensBatch(messages: WithParts[]): Promise<number> {
    const texts: string[] = []
    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text") texts.push(part.text)
            else texts.push(...extractToolContent(part))
        }
    }
    return estimateTokensBatch(texts)
}
