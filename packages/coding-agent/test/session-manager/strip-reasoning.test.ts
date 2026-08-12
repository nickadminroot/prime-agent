import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";

describe("session reasoning stripping", () => {
	let tempDir: string;
	let sourceFile: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `strip-reasoning-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		sourceFile = join(tempDir, "source.jsonl");
		const header = { type: "session", version: 3, id: "source", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir };
		const assistant = (id: string, parentId: string | null) => ({
			type: "message",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:01Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `secret-${id}` },
					{ type: "text", text: `visible-${id}` },
				],
				timestamp: 1,
				stopReason: "stop",
			},
		});
		const compaction = {
			type: "compaction",
			id: "c",
			parentId: "a",
			timestamp: "2025-01-01T00:00:02Z",
			summary: "summary",
			firstKeptEntryId: "a",
			tokensBefore: 10,
			compactedMessages: [assistant("nested", null).message],
		};
		writeFileSync(
			sourceFile,
			`${[header, assistant("a", null), compaction, assistant("b", "c")].map(JSON.stringify).join("\n")}\n`,
		);
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	function reasoningBlocks(path: string): unknown[] {
		const entries = loadEntriesFromFile(path);
		return entries.flatMap((entry: any) =>
			entry.type === "message"
				? entry.message.content.filter((block: any) => block.type === "thinking")
				: entry.type === "compaction"
					? (entry.compactedMessages ?? []).flatMap((message: any) =>
							message.content.filter((block: any) => block.type === "thinking"),
						)
					: [],
		);
	}

	it("strips all inherited and nested reasoning by default", () => {
		const fork = SessionManager.forkFrom(sourceFile, tempDir, tempDir);
		expect(reasoningBlocks(fork.getSessionFile()!)).toEqual([]);
		expect(readFileSync(fork.getSessionFile()!, "utf8")).toContain("visible-a");
	});

	it("preserves reasoning when explicitly disabled", () => {
		const fork = SessionManager.forkFrom(sourceFile, tempDir, tempDir, undefined, false);
		expect(reasoningBlocks(fork.getSessionFile()!)).toHaveLength(3);
	});

	it("rewrites the current session", () => {
		const session = SessionManager.open(sourceFile, tempDir);
		expect(session.stripReasoning()).toBe(true);
		expect(reasoningBlocks(sourceFile)).toEqual([]);
		expect(session.stripReasoning()).toBe(false);
	});
});
