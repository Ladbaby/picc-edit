import { describe, expect, it } from "vitest";
import { generateDisplayDiff } from "../src/diff.js";

describe("generateDisplayDiff", () => {
	it("numbers added lines with their new-file line number (marker right)", () => {
		const old = "a\nb\nc";
		const newC = "a\nb\nNEW\nc";
		const diff = generateDisplayDiff(old, newC);
		const lines = diff.split("\n");
		expect(lines).toContain(" 1   a");
		expect(lines).toContain(" 2   b");
		expect(lines).toContain(" 3 + NEW");
		expect(lines).toContain(" 4   c");
	});

	it("numbers removed lines with their old-file line number (multi-deletion)", () => {
		// old `a,b,c,d,e` → new `a,c,e` removes `b` (old 2) and `d` (old 4).
		const old = "a\nb\nc\nd\ne";
		const newC = "a\nc\ne";
		const diff = generateDisplayDiff(old, newC);
		const lines = diff.split("\n");
		expect(lines).toContain(" 1   a");
		expect(lines).toContain(" 2 - b");
		expect(lines).toContain(" 2   c");
		expect(lines).toContain(" 4 - d");
		expect(lines).toContain(" 3   e");
	});

	it("line replacement shows the same number for the - and + lines", () => {
		const old = "a\nb\nc";
		const newC = "a\nX\nc";
		const diff = generateDisplayDiff(old, newC);
		const lines = diff.split("\n");
		expect(lines).toContain(" 1   a");
		expect(lines).toContain(" 2 - b");
		expect(lines).toContain(" 2 + X");
		expect(lines).toContain(" 3   c");
	});

	it("collapses large context gaps with ...", () => {
		const oldLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
		const old = oldLines.join("\n");
		const newLines = [
			...oldLines.slice(0, 3),
			"CHANGED3",
			...oldLines.slice(4, 16),
			"CHANGED17",
			...oldLines.slice(17),
		];
		const newC = newLines.join("\n");
		const diff = generateDisplayDiff(old, newC, 3);
		expect(diff).toContain(" ...");
	});

	it("keeps added and context numbers non-decreasing (new-file counter)", () => {
		const old = "a\nb\nc\nd\ne";
		const newC = "a\nX\nc\nd\ne";
		const diff = generateDisplayDiff(old, newC);
		// Extract (marker, number); removed ("-") lines use the old-file
		// counter and are excluded — only added/context (new-file counter) must
		// be non-decreasing.
		const nums: number[] = [];
		for (const l of diff.split("\n")) {
			const m = l.match(/^ (\s*\d+) ([-+ ]) /);
			if (m && m[2] !== "-") nums.push(parseInt(m[1], 10));
		}
		expect(nums.length).toBeGreaterThan(0);
		for (let i = 1; i < nums.length; i++) {
			expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
		}
	});
});
