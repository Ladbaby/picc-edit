import { describe, expect, it } from "vitest";
import { generateDisplayDiff } from "../src/diff.js";

describe("generateDisplayDiff", () => {
	it("uses unified new-file line numbers for additions", () => {
		const old = "a\nb\nc";
		const newC = "a\nb\nNEW\nc";
		const diff = generateDisplayDiff(old, newC);
		const lines = diff.split("\n");
		expect(lines).toContain(" 1 a");
		expect(lines).toContain(" 2 b");
		expect(lines).toContain("+3 NEW");
		expect(lines).toContain(" 4 c");
	});

	it("removed lines share the new-file line number of the following line", () => {
		const old = "a\nb\nc";
		const newC = "a\nc";
		const diff = generateDisplayDiff(old, newC);
		const lines = diff.split("\n");
		// "b" is removed; it gets line 2 (the number "c" will have after removal)
		expect(lines).toContain(" 1 a");
		expect(lines).toContain("-2 b");
		expect(lines).toContain(" 2 c");
	});

	it("line replacement shows same number for - and +", () => {
		const old = "a\nb\nc";
		const newC = "a\nX\nc";
		const diff = generateDisplayDiff(old, newC);
		const lines = diff.split("\n");
		expect(lines).toContain(" 1 a");
		expect(lines).toContain("-2 b");
		expect(lines).toContain("+2 X");
		expect(lines).toContain(" 3 c");
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

	it("numbers are sequential and non-decreasing in the new file", () => {
		const old = "a\nb\nc\nd\ne";
		const newC = "a\nX\nc\nd\ne";
		const diff = generateDisplayDiff(old, newC);
		const lines = diff.split("\n");
		// Extract numbers in order
		const nums = lines
			.map((l) => {
				const m = l.match(/^[+\-\s](\d+)\s/);
				return m ? parseInt(m[1], 10) : null;
			})
			.filter((n): n is number => n !== null);
		// Numbers should be non-decreasing
		for (let i = 1; i < nums.length; i++) {
			expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
		}
	});
});
