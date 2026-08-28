import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	FILE_MODIFIED_SINCE_READ_ERROR,
	FILE_NOT_READ_ERROR,
} from "../src/constants.js";
import { EditGuardError, editOutcome, editSummaryText } from "../src/edit.js";
import {
	applyEditToFile,
	findActualString,
	preserveQuoteStyle,
	stripTrailingWhitespace,
} from "../src/editUtils.js";
import {
	convertLeadingTabsToSpaces,
	findSimilarFile,
	readFileSyncWithMetadata,
	writeTextContent,
} from "../src/file.js";
import {
	replaceAllMessage,
	singleEditMessage,
} from "../src/prompt.js";
import {
	fileStateToolName,
	readStateClear,
	readStateSet,
} from "../src/readState.js";

describe("editUtils", () => {
	it("applyEditToFile replaces first occurrence with a function callback", () => {
		const out = applyEditToFile("a $& b", "a", "x", false);
		expect(out).toBe("x $& b");
	});

	it("applyEditToFile replaceAll replaces every occurrence", () => {
		const out = applyEditToFile("foo bar foo", "foo", "baz", true);
		expect(out).toBe("baz bar baz");
	});

	it("applyEditToFile strips a trailing newline when deleting a line", () => {
		const out = applyEditToFile("keep1\ndrop\nkeep3", "drop", "", false);
		expect(out).toBe("keep1\nkeep3");
	});

	it("findActualString matches exact text", () => {
		expect(findActualString("hello world", "world")).toBe("world");
	});

	it("findActualString matches curly quotes via normalization", () => {
		const file = "The \u201cquoted\u201d text";
		const found = findActualString(file, '"quoted"');
		expect(found).toBe("\u201cquoted\u201d");
	});

	it("preserveQuoteStyle turns straight quotes curly when the file uses them", () => {
		const out = preserveQuoteStyle('"a"', "\u201ca\u201d", '"b" "c"');
		expect(out).toBe("\u201cb\u201d \u201cc\u201d");
	});

	it("stripTrailingWhitespace removes trailing spaces on each line", () => {
		expect(stripTrailingWhitespace("a  \nb\t\n")).toBe("a\nb\n");
	});
});

describe("file helpers", () => {
	it("convertLeadingTabsToSpaces turns leading tabs into two spaces", () => {
		expect(convertLeadingTabsToSpaces("\ta\nb")).toBe("  a\nb");
	});

	it("writeTextContent writes verbatim with LF", async () => {
		const dir = await mkdtemp(join(tmpdir(), "picc-edit-"));
		const file = join(dir, "lf.txt");
		writeTextContent(file, "a\r\nb\n", "utf8", "LF");
		expect(await readFile(file, "utf8")).toBe("a\r\nb\n");
	});

	it("findSimilarFile suggests a file with the same base name", async () => {
		const dir = await mkdtemp(join(tmpdir(), "picc-edit-similar-"));
		await writeFile(join(dir, "main.ts"), "");
		expect(findSimilarFile(join(dir, "main.js"))).toBe("main.ts");
	});
});

describe("prompt messages", () => {
	it("formats success messages", () => {
		expect(singleEditMessage("/a.txt")).toBe(
			"The file /a.txt has been updated successfully.",
		);
		expect(replaceAllMessage("/a.txt")).toBe(
			"The file /a.txt has been updated. All occurrences were successfully replaced.",
		);
	});
});

describe("editSummaryText", () => {
	it("formats additions only", () => {
		expect(editSummaryText(1, 0)).toBe("Added 1 line");
		expect(editSummaryText(3, 0)).toBe("Added 3 lines");
	});

	it("formats removals only (capitalized verb)", () => {
		expect(editSummaryText(0, 1)).toBe("Removed 1 line");
		expect(editSummaryText(0, 5)).toBe("Removed 5 lines");
	});

	it("formats both (lowercase removal verb, comma-joined)", () => {
		expect(editSummaryText(1, 2)).toBe("Added 1 line, removed 2 lines");
		expect(editSummaryText(4, 7)).toBe("Added 4 lines, removed 7 lines");
	});

	it("falls back to Applied when nothing changed", () => {
		expect(editSummaryText(0, 0)).toBe("Applied");
	});
});

describe("fileStateToolName", () => {
	it("treats read/write/edit (both cases) as file-state tools", () => {
		expect(fileStateToolName("read")).toBe(true);
		expect(fileStateToolName("Read")).toBe(true);
		expect(fileStateToolName("write")).toBe(true);
		expect(fileStateToolName("Write")).toBe(true);
		expect(fileStateToolName("edit")).toBe(true);
		expect(fileStateToolName("Edit")).toBe(true);
	});

	it("rejects unrelated tool names", () => {
		expect(fileStateToolName("bash")).toBe(false);
		expect(fileStateToolName("grep")).toBe(false);
		expect(fileStateToolName("")).toBe(false);
	});
});

describe("editOutcome", () => {
	let cwd: string;
	beforeEach(async () => {
		readStateClear();
		cwd = await mkdtemp(join(tmpdir(), "picc-edit-orch-"));
	});

	it("rejects old_string === new_string", async () => {
		const file = join(cwd, "same.txt");
		await writeFile(file, "x");
		readStateSet(file, {
			content: "x",
			timestamp: Math.floor((await stat(file)).mtimeMs),
		});
		await expect(
			editOutcome({ file_path: file, old_string: "x", new_string: "x" }, cwd),
		).rejects.toMatchObject({
			message:
				"No changes to make: old_string and new_string are exactly the same.",
		});
	});

	it("creates a new file when old_string is empty and file is missing", async () => {
		const file = join(cwd, "new.txt");
		const outcome = await editOutcome(
			{ file_path: file, old_string: "", new_string: "created" },
			cwd,
		);
		expect(outcome.originalFile).toBe("");
		expect(outcome.newFile).toBe("created");
		expect(await readFile(file, "utf8")).toBe("created");
	});

	it("rejects editing an unread existing file", async () => {
		const file = join(cwd, "unread.txt");
		await writeFile(file, "old");
		await expect(
			editOutcome({ file_path: file, old_string: "old", new_string: "new" }, cwd),
		).rejects.toMatchObject({ message: FILE_NOT_READ_ERROR });
	});

	it("allows editing a file the agent just wrote (no re-read needed)", async () => {
		// Simulates the write→edit flow: a `write` result seeds read-state with a
		// fresh full-read entry (what recordRead now does for write/edit too), so
		// the follow-up edit must NOT throw FILE_NOT_READ_ERROR — matching Claude
		// Code, where FileWriteTool refreshes the shared `readFileState`.
		const file = join(cwd, "written.txt");
		await writeFile(file, "one\ntwo\nthree");
		readStateSet(file, {
			content: "one\ntwo\nthree",
			timestamp: Math.floor((await stat(file)).mtimeMs),
			offset: undefined,
			limit: undefined,
		});
		const outcome = await editOutcome(
			{ file_path: file, old_string: "two", new_string: "TWO" },
			cwd,
		);
		expect(outcome.newFile).toBe("one\nTWO\nthree");
		expect(await readFile(file, "utf8")).toBe("one\nTWO\nthree");
	});

	it("rejects editing a file modified since it was read", async () => {
		const file = join(cwd, "changed.txt");
		await writeFile(file, "current");
		readStateSet(file, {
			content: "STALE",
			timestamp: Math.floor((await stat(file)).mtimeMs) - 100_000,
		});
		await expect(
			editOutcome({ file_path: file, old_string: "current", new_string: "x" }, cwd),
		).rejects.toMatchObject({ message: FILE_MODIFIED_SINCE_READ_ERROR });
	});

	it("rejects a non-existent file with a non-empty old_string", async () => {
		const file = join(cwd, "missing.txt");
		await expect(
			editOutcome({ file_path: file, old_string: "abc", new_string: "x" }, cwd),
		).rejects.toThrow(/File does not exist/);
	});

	it("updates a unique old_string and records the patch", async () => {
		const file = join(cwd, "edit.txt");
		const original = "one\ntwo\nthree";
		await writeFile(file, original);
		readStateSet(file, {
			content: original,
			timestamp: Math.floor((await stat(file)).mtimeMs),
		});
		const outcome = await editOutcome(
			{ file_path: file, old_string: "two", new_string: "TWO" },
			cwd,
		);
		expect(outcome.replaceAll).toBe(false);
		expect(outcome.originalFile).toBe(original);
		expect(outcome.newFile).toBe("one\nTWO\nthree");
		expect(await readFile(file, "utf8")).toBe("one\nTWO\nthree");
		expect(outcome.structuredPatch.length).toBeGreaterThan(0);
	});

	it("rejects an ambiguous old_string unless replace_all is set", async () => {
		const file = join(cwd, "dup.txt");
		const original = "a\nb\na";
		await writeFile(file, original);
		readStateSet(file, {
			content: original,
			timestamp: Math.floor((await stat(file)).mtimeMs),
		});
		await expect(
			editOutcome({ file_path: file, old_string: "a", new_string: "A" }, cwd),
		).rejects.toThrow(/Found 2 matches/);

		const outcome = await editOutcome(
			{ file_path: file, old_string: "a", new_string: "A", replace_all: true },
			cwd,
		);
		expect(outcome.replaceAll).toBe(true);
		expect(await readFile(file, "utf8")).toBe("A\nb\nA");
	});

	it("throws EditGuardError for guard failures", async () => {
		const file = join(cwd, "g.txt");
		await writeFile(file, "old");
		try {
			await editOutcome(
				{ file_path: file, old_string: "old", new_string: "new" },
				cwd,
			);
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(EditGuardError);
		}
	});

	// The modified-since-read guard must still fire when the file changes
	// after the recorded read (defense against stale writes). This is the
	// remaining safety net after recordRead was simplified to always store
	// full-read entries.
	it("blocks edit when file is modified after the recorded read", async () => {
		const file = join(cwd, "stale.txt");
		await writeFile(file, "first content\n");
		const entry = readFileSyncWithMetadata(file);
		readStateSet(file, {
			content: entry.content,
			timestamp: Date.now() - 10_000, // pretend we read 10s ago
			offset: undefined,
			limit: undefined,
		});
		// Give the file a fresh mtime so it looks modified-since-read.
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(file, "first content\nsecond line\n");
		await expect(
			editOutcome(
				{ file_path: file, old_string: "first content", new_string: "X" },
				cwd,
			),
		).rejects.toBeInstanceOf(EditGuardError);
	});
});
