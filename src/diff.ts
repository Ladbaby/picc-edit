// =============================================================================
// picc-write — src/diff.ts
//
// Port of claude-code's `utils/diff.ts:getPatchFromContents` /
// `countLinesChanged`, using the `diff` npm package's `structuredPatch`.
//
// Adaptors vs upstream:
//   - `countLinesChanged` is made pure (returns `{ added, removed }`) — no
//     analytics / LOC counters / logging.
//   - A local structural `Hunk` type stands in for `diff`'s
//     `StructuredPatchHunk` (avoid importing from `diff`'s internal types).
// =============================================================================

import { diffLines, structuredPatch } from "diff";

export const CONTEXT_LINES = 3;

/** Structural type matching `diff`'s `StructuredPatchHunk`. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  [key: string]: unknown;
}

// For some reason, & confuses the diff library, so we replace it with a token,
// then substitute it back in after the diff is computed.
const AMPERSAND_TOKEN = "<<:AMPERSAND_TOKEN:>>";
const DOLLAR_TOKEN = "<<:DOLLAR_TOKEN:>>";

function escapeForDiff(s: string): string {
  return s.replaceAll("&", AMPERSAND_TOKEN).replaceAll("$", DOLLAR_TOKEN);
}

function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, "&").replaceAll(DOLLAR_TOKEN, "$");
}

/**
 * Count lines added and removed in a patch. For new files, pass the content
 * string as the second parameter (all lines count as additions).
 */
export function countLinesChanged(
  patch: Hunk[],
  newFileContent?: string,
): { added: number; removed: number } {
  let numAdditions = 0;
  let numRemovals = 0;

  if (patch.length === 0 && newFileContent) {
    numAdditions = newFileContent.split(/\r?\n/).length;
  } else {
    for (const hunk of patch) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) numAdditions++;
        else if (line.startsWith("-")) numRemovals++;
      }
    }
  }

  return { added: numAdditions, removed: numRemovals };
}

/**
 * Generate a display-oriented diff string using a **unified** line-number
 * counter (the new file's line number for all lines).
 *
 * Numbering rules:
 *   - Context: ` NNN content`, counter advances
 *   - Added:   `+NNN content`, counter advances
 *   - Removed: `-NNN content`, counter does NOT advance
 *
 * Context collapsing mirrors pi's `generateDiffString`: only up to
 * `contextLines` lines are shown before/after a change; larger gaps are
 * replaced with a ` ...` marker.
 */
export function generateDisplayDiff(
  oldContent: string,
  newContent: string,
  contextLines: number = CONTEXT_LINES,
): string {
  const parts = diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let newLineNum = 1;
  let lastWasChange = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }

    if (part.added || part.removed) {
      for (const line of raw) {
        const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
        if (part.added) {
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${lineNum} ${line}`);
        }
      }
      lastWasChange = true;
    } else {
      // Context lines — collapse large gaps
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            newLineNum++;
          }
        } else {
          const leading = raw.slice(0, contextLines);
          const trailing = raw.slice(raw.length - contextLines);
          const skipped = raw.length - leading.length - trailing.length;
          for (const line of leading) {
            const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            newLineNum++;
          }
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          newLineNum += skipped;
          for (const line of trailing) {
            const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shown = raw.slice(0, contextLines);
        const skipped = raw.length - shown.length;
        for (const line of shown) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          newLineNum++;
        }
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          newLineNum += skipped;
        }
      } else if (hasTrailingChange) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          newLineNum += skipped;
        }
        for (const line of raw.slice(skipped)) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          newLineNum++;
        }
      } else {
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return output.join("\n");
}

/**
 * Compute a structured patch between two contents, with `&`/`$` escaped
 * through the diff algorithm and unescaped on the returned lines.
 */
export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
}: {
  filePath: string;
  oldContent: string;
  newContent: string;
  ignoreWhitespace?: boolean;
}): Hunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      context: CONTEXT_LINES,
    },
  );
  if (!result) {
    return [];
  }
  return result.hunks.map((h) => ({
    ...h,
    lines: h.lines.map(unescapeFromDiff),
  }));
}
