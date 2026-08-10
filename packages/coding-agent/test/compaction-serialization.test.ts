import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	COMPACTED_TOOL_PAYLOAD_MAX_CHARS,
	createCompactedTranscript,
	serializeConversation,
} from "../src/core/compaction/utils.js";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	convertToLlm,
	SESSION_SLASH_COMMAND_CUSTOM_TYPE,
} from "../src/core/messages.js";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "ipython",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "ipython",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});

describe("createCompactedTranscript", () => {
	it("preserves user and assistant text while shortening reasoning and tool data", () => {
		const userText = `user-${"u".repeat(3000)}`;
		const assistantText = `assistant-${"a".repeat(3000)}`;
		const result = createCompactedTranscript([
			{ role: "user", content: userText, timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "secret reasoning" },
					{ type: "text", text: assistantText },
					{ type: "toolCall", id: "call-1", name: "tool", arguments: { value: "v".repeat(2000) } },
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "tool",
				content: [{ type: "text", text: `result-${"r".repeat(3000)}` }],
				isError: false,
				timestamp: 3,
			},
		]);

		expect(result).toHaveLength(4);
		expect(result[0]).toMatchObject({ role: "user", content: userText });
		const text = result
			.slice(1)
			.map((message) =>
				message.role === "assistant"
					? message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n")
					: message.role === "custom" && typeof message.content === "string"
						? message.content
						: "",
			)
			.join("\n");
		expect(text).toContain(assistantText);
		expect(text).not.toContain("secret reasoning");
		expect(text).toContain("output shortened during context compaction");
		expect(text).toContain("tool");
		expect(text.length).toBeGreaterThan(userText.length);
		expect(text).toContain("v".repeat(150));
		expect(text).not.toContain("v".repeat(250));
		expect(text).toContain("r".repeat(150));
		expect(text).not.toContain("r".repeat(250));
	});
	it("uses one reasoning marker for the entire transcript and preserves it recursively", () => {
		const makeAssistant = (thinking: string, text: string, timestamp: number) =>
			({
				role: "assistant",
				content: [
					{ type: "thinking", thinking },
					{ type: "text", text },
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp,
			}) as unknown as import("@earendil-works/pi-agent-core").AgentMessage;
		const messages = [
			makeAssistant("first secret", "first visible", 1),
			makeAssistant("second secret", "second visible", 2),
		];
		const result = createCompactedTranscript(messages);
		const assistantText = result
			.filter(
				(message): message is Extract<(typeof result)[number], { role: "assistant" }> =>
					message.role === "assistant",
			)
			.flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text));
		expect(
			assistantText.filter((text) => text === "[Previous reasoning omitted during context compaction.]"),
		).toHaveLength(1);
		expect(assistantText).toContain("first visible");
		expect(assistantText).toContain("second visible");

		const recursive = createCompactedTranscript(result);
		const recursiveText = recursive
			.filter(
				(message): message is Extract<(typeof recursive)[number], { role: "assistant" }> =>
					message.role === "assistant",
			)
			.flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text));
		expect(
			recursiveText.filter((text) => text === "[Previous reasoning omitted during context compaction.]"),
		).toHaveLength(1);
	});

	it("does not add a reasoning marker when no reasoning was present", () => {
		const result = createCompactedTranscript([
			{
				role: "assistant",
				content: [{ type: "text", text: "visible only" }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		]);
		expect(JSON.stringify(result)).not.toContain("[Previous reasoning omitted during context compaction.]");
	});

	it("bounds bash output while preserving short output", () => {
		const makeBash = (output: string, command = "printf output") =>
			({
				role: "bashExecution",
				command,
				output,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				fullOutputPath: undefined,
				timestamp: 1,
			}) as unknown as import("@earendil-works/pi-agent-core").AgentMessage;

		const short = "short bash output";
		const shortResult = createCompactedTranscript([makeBash(short)]);
		expect(shortResult[0]).toMatchObject({
			role: "custom",
			customType: "compacted_transcript",
			content: expect.stringContaining(short),
		});

		const long = "b".repeat(COMPACTED_TOOL_PAYLOAD_MAX_CHARS + 500);
		const longCommand = "c".repeat(1000);
		const longResult = createCompactedTranscript([makeBash(long, longCommand)]);
		const content =
			longResult[0]?.role === "custom" && typeof longResult[0].content === "string" ? longResult[0].content : "";
		expect(content).toContain("b".repeat(COMPACTED_TOOL_PAYLOAD_MAX_CHARS));
		expect(content).not.toContain("b".repeat(COMPACTED_TOOL_PAYLOAD_MAX_CHARS + 1));
		expect(content).toContain("output shortened during context compaction");
		expect(content).toContain("c".repeat(200));
		expect(content).not.toContain("c".repeat(201));
	});
	it("filters messages excluded from the normal LLM context", () => {
		const secretBash = {
			role: "bashExecution",
			command: "cat secret",
			output: "secret output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 1,
		} as const;
		const secretCustom = {
			role: "custom",
			customType: SESSION_SLASH_COMMAND_CUSTOM_TYPE,
			content: "secret command",
			display: true,
			timestamp: 2,
		} as const;
		const outcome = {
			role: "custom",
			customType: COMPACTION_OUTCOME_CUSTOM_TYPE,
			content: "secret outcome",
			display: true,
			timestamp: 3,
		} as const;
		const messages = [secretBash, secretCustom, outcome] as never[];
		expect(convertToLlm(messages)).toEqual([]);
		expect(convertToLlm(createCompactedTranscript(messages))).toEqual([]);
	});
});
