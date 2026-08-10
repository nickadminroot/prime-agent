/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	COMPACTED_TRANSCRIPT_CUSTOM_TYPE,
	createCompactedTranscriptMessage,
	isMessageVisibleInContext,
} from "../messages.js";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/** Limits used by the deterministic transcript retained after compaction. */
/** Maximum source payload characters retained for every tool transcript fragment. */
export const COMPACTED_TOOL_PAYLOAD_MAX_CHARS = 200;

const COMPACTED_REASONING_MARKER = "[Previous reasoning omitted during context compaction.]";
const COMPACTED_IMAGE_MARKER = "[Image omitted during context compaction.]";

function truncateCompactedText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... output shortened during context compaction]`;
}

function createHistoricalAssistant(message: AssistantMessage, blocks: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content: blocks,
		api: message.api,
		provider: message.provider,
		model: message.model,
		responseModel: message.responseModel,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: message.timestamp,
	};
}

interface CompactedTranscriptState {
	reasoningMarkerAdded: boolean;
}

function containsCompactedReasoningMarker(message: AgentMessage): boolean {
	if (message.role === "assistant") {
		return message.content.some((block) => block.type === "text" && block.text.includes(COMPACTED_REASONING_MARKER));
	}
	if (message.role === "custom" && typeof message.content === "string") {
		return message.content.includes(COMPACTED_REASONING_MARKER);
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return message.summary.includes(COMPACTED_REASONING_MARKER);
	}
	return false;
}

function serializeCompactedMessage(message: AgentMessage, state: CompactedTranscriptState): AgentMessage[] {
	if (!isMessageVisibleInContext(message)) return [];
	if (containsCompactedReasoningMarker(message)) state.reasoningMarkerAdded = true;
	if (message.role === "user") return [message];
	if (message.role === "assistant") {
		const result: AgentMessage[] = [];
		let assistantBlocks: AssistantMessage["content"] = [];
		const flushAssistant = () => {
			if (assistantBlocks.length > 0) {
				result.push(createHistoricalAssistant(message, assistantBlocks));
				assistantBlocks = [];
			}
		};
		for (const block of message.content) {
			switch (block.type) {
				case "text":
					assistantBlocks.push(block);
					break;
				case "thinking":
					if (!state.reasoningMarkerAdded) {
						assistantBlocks.push({ type: "text", text: COMPACTED_REASONING_MARKER });
						state.reasoningMarkerAdded = true;
					}
					break;
				case "toolCall": {
					flushAssistant();
					let args: string;
					try {
						args = JSON.stringify(block.arguments);
					} catch {
						args = "[arguments unavailable]";
					}
					result.push(
						createCompactedTranscriptMessage(
							`[Previous tool call: ${block.name} (${truncateCompactedText(args, COMPACTED_TOOL_PAYLOAD_MAX_CHARS)})]`,
							"toolCall",
							message.timestamp,
						),
					);
					break;
				}
			}
		}
		flushAssistant();
		return result;
	}
	if (message.role === "toolResult") {
		const parts = message.content.map((block) => (block.type === "text" ? block.text : COMPACTED_IMAGE_MARKER));
		const result = truncateCompactedText(parts.join(""), COMPACTED_TOOL_PAYLOAD_MAX_CHARS);
		const status = message.isError ? " error" : "";
		return [
			createCompactedTranscriptMessage(
				`[Previous tool result${status}: ${message.toolName}] ${result || "(empty)"}`,
				"toolResult",
				message.timestamp,
			),
		];
	}

	if (message.role === "bashExecution") {
		return [
			createCompactedTranscriptMessage(
				`[Previous command: ${truncateCompactedText(message.command, COMPACTED_TOOL_PAYLOAD_MAX_CHARS)}]\n${truncateCompactedText(message.output, COMPACTED_TOOL_PAYLOAD_MAX_CHARS)}`,
				"bashExecution",
				message.timestamp,
			),
		];
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return [
			createCompactedTranscriptMessage(`[Previous context]: ${message.summary}`, "legacySummary", message.timestamp),
		];
	}
	if (message.role !== "custom") return [];
	return [
		{
			...message,
			customType: COMPACTED_TRANSCRIPT_CUSTOM_TYPE,
			display: false,
			details: { kind: "custom", originalCustomType: message.customType },
		},
	];
}

/**
 * Build a provider-safe, deterministic transcript for discarded context.
 * User messages are retained verbatim. Assistant visible text remains an
 * assistant message, while tool and other historical artifacts become hidden
 * custom messages converted to user text only at the provider seam.
 */
export function createCompactedTranscript(messages: AgentMessage[]): AgentMessage[] {
	const state: CompactedTranscriptState = { reasoningMarkerAdded: false };
	return messages.flatMap((message) => serializeCompactedMessage(message, state));
}

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
