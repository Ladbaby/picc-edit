import { describe, expect, it } from "vitest";
import { renderDiff } from "../src/renderDiff.js";

// Theme stub matching the subset of the real `Theme` used by renderDiff.
const theme = {
	fg: (color: "toolDiffRemoved" | "toolDiffContext", text: string) =>
		`<${color}>${text}</>`,
	inverse: (text: string) => `<inv>${text}</inv>`,
};

describe("renderDiff", () => {
	it("colors added lines with fixed truecolor #207c36 (38;2;32;124;54)", () => {
		const out = renderDiff(" 1 keep\n+2 added", theme);
		expect(out).toContain("\x1b[38;2;32;124;54m+2 added\x1b[39m");
	});

	it("colors removed lines via the theme", () => {
		const out = renderDiff("-1 gone", theme);
		expect(out).toContain("<toolDiffRemoved>-1 gone</>");
	});

	it("colors context lines via the theme", () => {
		const out = renderDiff(" 1 keep", theme);
		expect(out).toContain("<toolDiffContext> 1 keep</>");
	});

	it("applies intra-line inverse highlighting on single-line changes", () => {
		const out = renderDiff("-1 old text\n+2 new text", theme);
		const addedLine = out.split("\n")[1];
		// Whole added line is wrapped in the fixed color; changed word is
		// inverse-highlighted inside it (like the built-in renderDiff).
		expect(addedLine.startsWith("\x1b[38;2;32;124;54m")).toBe(true);
		expect(addedLine.endsWith("\x1b[39m")).toBe(true);
		expect(addedLine).toContain("<inv>");
	});

	it("replaces tabs with spaces in line content", () => {
		const out = renderDiff("+1 a\tb", theme);
		expect(out).toContain("+1 a   b");
	});

	it("leaves unparseable lines dimmed as context", () => {
		const out = renderDiff("...skipped", theme);
		expect(out).toContain("<toolDiffContext>...skipped</>");
	});
});
