// =============================================================================
// picc-write — src/diff.ts
//
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
 * Generate a display-oriented diff string matching Claude Code's `Edit`
 * output format:
 *   - The line number is right-aligned, then the `+`/`-` marker sits to its
 *     right (context lines leave the marker column blank).
 *   - Line numbering uses **two independent counters**:
 *       - Added:   new-file line number (counter advances)
 *       - Removed: old-file line number (old counter advances; the new counter
 *                  does NOT advance for removed lines)
 *       - Context: new-file line number (both counters advance)
 *
 * Example (old = `a,b,c,d,e`; new = `a,c,e` — removes `b` and `d`):
 *   ` 1   a`, ` 2 - b`, ` 2   c`, ` 4 - d`, ` 3   e`
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

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;

  // Emit one diff line. `marker` is "+", "-" or " " (blank column for
  // context). Layout: `<gutter-space><right-aligned num><space><marker><space><content>`,
  // so changed/context columns align and the marker sits to the right of the
  // line number (matching Claude Code's `7 +` / `10 -` rendering).
  const emitLine = (num: number, marker: string, line: string) => {
    const lineNum = String(num).padStart(lineNumWidth, " ");
    output.push(` ${lineNum} ${marker} ${line}`);
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }

    if (part.added || part.removed) {
      for (const line of raw) {
        if (part.added) {
          emitLine(newLineNum, "+", line);
          newLineNum++;
        } else {
          emitLine(oldLineNum, "-", line);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      // Context lines — collapse large gaps
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      const emitContext = (lines: string[]) => {
        for (const line of lines) {
          emitLine(newLineNum, " ", line);
          oldLineNum++;
          newLineNum++;
        }
      };
      const emitEllipsis = (skipped: number) => {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      };

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          emitContext(raw);
        } else {
          const leading = raw.slice(0, contextLines);
          const trailing = raw.slice(raw.length - contextLines);
          const skipped = raw.length - leading.length - trailing.length;
          emitContext(leading);
          emitEllipsis(skipped);
          emitContext(trailing);
        }
      } else if (hasLeadingChange) {
        const shown = raw.slice(0, contextLines);
        const skipped = raw.length - shown.length;
        emitContext(shown);
        if (skipped > 0) emitEllipsis(skipped);
      } else if (hasTrailingChange) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) emitEllipsis(skipped);
        emitContext(raw.slice(skipped));
      } else {
        oldLineNum += raw.length;
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
