// =============================================================================
// picc-edit — src/renderDiff.ts
//
// Local port of pi's built-in `renderDiff`
// (`modes/interactive/components/diff.js`) with one difference: added lines
// are drawn in a fixed truecolor green (#207c36) instead of the theme's
// `toolDiffAdded` color (see `renderAddedLine`). Everything else — line
// parsing, tab replacement, intra-line word diff with inverse highlighting —
// mirrors the built-in so the TUI output matches pi's standard diff viewer.
// =============================================================================

import { type Change, diffWords } from "diff";

/** Fixed truecolor for newly added lines (overrides the theme color). */
const ADDED_LINE_FG = "\x1b[38;2;32;124;54m";
/** Reset only the foreground color — same convention as `Theme.fg`. */
const FG_RESET = "\x1b[39m";

type RenderDiffTheme = {
	fg: (color: "toolDiffRemoved" | "toolDiffContext", text: string) => string;
	inverse: (text: string) => string;
};

/** Render an added line in the fixed #207c36 color. */
function renderAddedLine(line: string): string {
	return `${ADDED_LINE_FG}${line}${FG_RESET}`;
}

/** Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..." */
function parseDiffLine(line: string): {
	prefix: string;
	lineNum: string;
	content: string;
} | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/** Replace tabs with spaces for consistent rendering. */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Removed parts use the theme's inverse; added parts use the theme's inverse
 * wrapped in the fixed added-line color (the inverse flips fg/bg, so the
 * inverse spans still read as the #207c36 swap).
 */
function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	theme: RenderDiffTheme,
): { removedLine: string; addedLine: string } {
	const wordDiff: Change[] = diffWords(oldContent, newContent);
	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;
	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}
	return { removedLine, addedLine };
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: fixed #207c36, with inverse on changed tokens
 */
export function renderDiff(
	diffText: string,
	theme: RenderDiffTheme,
): string {
	const lines = diffText.split("\n");
	const result: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);
		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}
		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}
			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}
			// Only do intra-line diffing when there's exactly one removed and
			// one added line (indicating a single line modification).
			// Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];
				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
					theme,
				);
				result.push(
					theme.fg(
						"toolDiffRemoved",
						`-${removed.lineNum} ${removedLine}`,
					),
				);
				result.push(renderAddedLine(`+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(
						theme.fg(
							"toolDiffRemoved",
							`-${removed.lineNum} ${replaceTabs(removed.content)}`,
						),
					);
				}
				for (const added of addedLines) {
					result.push(
						renderAddedLine(`+${added.lineNum} ${replaceTabs(added.content)}`),
					);
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(
				renderAddedLine(`+${parsed.lineNum} ${replaceTabs(parsed.content)}`),
			);
			i++;
		} else {
			// Context line
			result.push(
				theme.fg(
					"toolDiffContext",
					` ${parsed.lineNum} ${replaceTabs(parsed.content)}`,
				),
			);
			i++;
		}
	}
	return result.join("\n");
}
