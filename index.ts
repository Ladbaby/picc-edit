/**
 * picc-edit: Claude Code-style Edit tool for pi.
 *
 * A faithful port of Claude Code's `Edit` tool
 * (`tools/FileEditTool/FileEditTool.ts`), registering a tool named
 * `edit`/`Edit` that **overrides pi's built-in `edit`** tool (same-name,
 * last-write-wins — see `core/tools/index.js`).
 *
 * Differences from pi's built-in `edit`:
 *   - Input is Claude Code's single-edit shape: `file_path` (absolute),
 *     `old_string`, `new_string`, optional `replace_all` (not pi's
 *     `edits: [{oldText, newText}]` array).
 *   - Enforces Claude Code's read-first guard: an existing file must have been
 *     read this session, and must not have been modified since that read.
 *     Read-state is tracked from `tool_result` events for any file tool that
 *     establishes known contents (read/write/edit) — mirroring Claude Code,
 *     where a file the agent just wrote or edited is immediately editable.
 *     The same mechanism picc-write uses.
 *   - Quote normalization: `old_string`/`new_string` may use straight quotes
 *     to match a file that contains curly quotes, preserving the file's
 *     typography.
 *   - Returns a structured patch + `originalFile` in `details`, with faithful
 *     success messages (including the `replace_all` variant).
 *   - Writes with explicit LF handling (the model's sent line endings are
 *     respected as-is — no repo resampling).
 *
 * Omitted from the live source (no pi equivalent):
 *   - permission checks (`checkWritePermissionForTool`, `matchingRuleForInput`
 *     — pi's permission system handles edits separately)
 *   - `checkTeamMemSecrets`, `validateInputForSettingsFileEdit`, team-memory
 *     guards, skill discovery, `diagnosticTracker`, `fileHistory`
 *   - LSP `didChange`/`didSave`, `notifyVscodeFileUpdated`, `fetchSingleFileGitDiff`
 *   - analytics (`logEvent`, `logFileOperation`), GrowthBook, UI.tsx render
 *
 * Tool name configuration:
 *   - Default: `"edit"` (lowercase; pi's built-in tool name).
 *   - Set `config.json` `toolName` to `"Edit"` (default location
 *     `~/.pi/agent/extensions/picc-edit/config.json`), or set
 *     `PICC_EDIT_TOOL_NAME=Edit`. Valid values: `"edit"`, `"Edit"`.
 *
 * References:
 * - Claude Code Edit tool: tools/FileEditTool/FileEditTool.ts (+ prompt.ts, utils.ts)
 * - Claude Code helpers: utils/file.ts, utils/fileRead.ts, utils/diff.ts, utils/path.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	generateDiffString,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { countLinesChanged } from "./src/diff.js";
import {
	type EditInput,
	type EditOutcome,
	editOutcome,
} from "./src/edit.js";
import {
	convertLeadingTabsToSpaces,
	getFileModificationTime,
	readFileSyncWithMetadata,
} from "./src/file.js";
import { expandPath } from "./src/path.js";
import {
	getEditToolDescription,
	replaceAllMessage,
	singleEditMessage,
} from "./src/prompt.js";
import {
	fileStateToolName,
	type ReadEntry,
	readStateClear,
	readStateSet,
} from "./src/readState.js";
import { renderDiff } from "./src/renderDiff.js";

// ============================================================================
// Config (mirrors picc-write)
// ============================================================================

const VALID_TOOL_NAMES = ["edit", "Edit"] as const;
type ToolName = (typeof VALID_TOOL_NAMES)[number];

function resolveConfigPath(): string {
	const env = process.env.PICC_EDIT_CONFIG_PATH;
	if (env) return env;
	return join(
		homedir(),
		".pi",
		"agent",
		"extensions",
		"picc-edit",
		"config.json",
	);
}

function readToolNameFromConfig(): ToolName | undefined {
	const configPath = resolveConfigPath();
	if (!existsSync(configPath)) return undefined;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as { toolName?: unknown };
		const val = parsed?.toolName;
		if (
			typeof val === "string" &&
			(VALID_TOOL_NAMES as readonly string[]).includes(val)
		) {
			return val as ToolName;
		}
		if (val !== undefined) {
			console.warn(
				`[picc-edit] config.json: invalid toolName "${val}" — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "edit".`,
			);
		}
	} catch {
		// unreadable / malformed — fall through to default
	}
	return undefined;
}

function loadToolName(): ToolName {
	const envVal = process.env.PICC_EDIT_TOOL_NAME;
	if (typeof envVal === "string") {
		if ((VALID_TOOL_NAMES as readonly string[]).includes(envVal)) {
			return envVal as ToolName;
		}
		console.warn(
			`[picc-edit] PICC_EDIT_TOOL_NAME="${envVal}" is invalid — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "edit".`,
		);
	}
	return readToolNameFromConfig() ?? "edit";
}

// ============================================================================
// Schema
// ============================================================================

const EDIT_SCHEMA = Type.Object({
	file_path: Type.String({
		description: "The absolute path to the file to modify",
	}),
    new_string: Type.String({
        description:
            "The text to replace it with (must be different from old_string)",
    }),
	old_string: Type.String({
		description: "The text to replace",
	}),
	replace_all: Type.Optional(
		Type.Boolean({ description: "Replace all occurrences of old_string (default false)" }),
	),
});

// ============================================================================
// Read-state tracking (populates the edit guard across read tools)
// ============================================================================

function recordRead(input: Record<string, unknown>, cwd: string): void {
	// Reads are reported under different key names depending on the active
	// read tool: pi's built-in `read` uses `path`, while picc-read (the
	// Claude Code port) uses `file_path`. Accept both so the read guard is
	// satisfied no matter which read tool the session is using.
	const rawPath =
		(typeof input.file_path === "string" && input.file_path) ||
		(typeof input.path === "string" && input.path);
	if (typeof rawPath !== "string" || !rawPath) return;

	let fullPath: string;
	try {
		fullPath = expandPath(rawPath, cwd);
	} catch {
		return;
	}

	try {
		const meta = readFileSyncWithMetadata(fullPath);
		const timestamp = getFileModificationTime(fullPath);
		// Always store as a full read (`offset: undefined`, `limit: undefined`).
		// We cannot reliably distinguish a full read from a partial read from
		// the `tool_result` event alone (no read-output content / truncation
		// info is exposed), and being too strict here causes false positives
		// when models default `offset: 1` or when a read tool injects `path`
		// defaults. The `modified-since-read` check in `editOutcome` still
		// guards against stale edits; sacrificing the partial-read guard is
		// the right trade-off (defense-in-depth, not correctness).
		const entry: ReadEntry = {
			content: meta.content,
			timestamp,
			offset: undefined,
			limit: undefined,
		};
		readStateSet(fullPath, entry);
	} catch {
		// file gone or unreadable — nothing to record
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	const toolName = loadToolName();

	// Clear any stale read-state on a fresh/reloaded session.
	pi.on("session_start", () => {
		readStateClear();
	});

	// Observe successful file tools (read/write/edit) to feed the edit guard.
	// Claude Code refreshes its shared `readFileState` from all three, so a file
	// the agent just wrote or edited is immediately editable without a redundant
	// re-read. `tool_result` events carry no cwd of their own; use the process
	// cwd.
	pi.on("tool_result", (event) => {
		if (!fileStateToolName(event.toolName)) return;
		if (event.isError) return;
		recordRead(event.input, process.cwd());
	});

	pi.registerTool({
		name: toolName,
		label: toolName,
		description: getEditToolDescription(),
		promptSnippet: "Make precise string replacements in files",
		promptGuidelines: [],
		parameters: EDIT_SCHEMA,
		// Rely on the framework's default background shell (colored Box) rather
		// than self-framing. This overrides the built-in `edit`, whose `renderShell:
		// "self"` we do NOT want to inherit — in "self" mode the framework would
		// skip the background unless we supplied our own Box. "default" gives the
		// standard pending/success/error background for free (see tool-execution).
		renderShell: "default",
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const input = params as EditInput;
			const cwd = ctx.cwd;

			try {
				const outcome: EditOutcome = await editOutcome(input, cwd);
				const message = outcome.replaceAll
					? replaceAllMessage(outcome.filePath)
					: singleEditMessage(outcome.filePath);
				// Display-oriented, line-numbered diff in the exact format the
				// built-in diff viewer (`renderDiff`) expects. Both sides are put
				// in the same display space (leading tabs → 2 spaces): `newFile`
				// is already tab-converted by editOutcome, so the old side must
				// be too — otherwise every tab-indented line looks changed and
				// the diff balloons to the whole file. Mirrors how
				// `structuredPatch` is computed (tab-convert both sides). Lives
				// only in `details` (TUI channel) — the model sees just `content`.
				const { diff } = generateDiffString(
					convertLeadingTabsToSpaces(outcome.originalFile),
					outcome.newFile,
				);
				const { added, removed } = countLinesChanged(
					outcome.structuredPatch,
					outcome.newFile,
				);
				return {
					content: [{ type: "text", text: message }],
					details: { ...outcome, diff, additions: added, removals: removed },
				};
			} catch (err) {
				// pi's agent loop only flags a tool result as errored when
				// execute() rejects — a resolved `{ isError: true }` is dropped
				// because AgentToolResult has no such field. Throw so the
				// guard / validation failure is surfaced as a real tool error
				// (matching pi's built-in `edit`, which also throws).
				throw err instanceof Error ? err : new Error(String(err));
			}
		},
		renderCall(args, theme, context) {
			const path =
				typeof args.file_path === "string" ? args.file_path : "";
			let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
			text += theme.fg("accent", path);
			const t =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			t.setText(text);
			return t;
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Editing..."), 0, 0);
			}
			const t =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			// On error, details is undefined. Show the error message in red.
			if (context.isError) {
				const errorMsg = result.content
					.filter(
						(c): c is { type: "text"; text: string } => c.type === "text",
					)
					.map((c) => c.text)
					.join("\n");
				t.setText(theme.fg("error", errorMsg || "Edit failed"));
				return t;
			}
			const details = result.details as
				| (EditOutcome & {
						diff?: string;
						additions: number;
						removals: number;
					})
				| undefined;
			// Summary line above the diff ("Added N, removed M"), matching
			// Claude Code's FileEditToolUpdatedMessage. Counts come from
			// details (set in execute); the leading blank line separates the
			// summary from the call header. Styled like picc-write's
			// createPreviewText header: muted text with the counts bolded.
			if (details?.diff) {
				const summaryParts: string[] = [];
				if (details.additions > 0) {
					summaryParts.push(
						`Added ${theme.bold(String(details.additions))} line${details.additions === 1 ? "" : "s"}`,
					);
				}
				if (details.removals > 0) {
					summaryParts.push(
						`${details.additions > 0 ? "removed" : "Removed"} ${theme.bold(String(details.removals))} line${details.removals === 1 ? "" : "s"}`,
					);
				}
				const summary =
					summaryParts.length > 0
						? summaryParts.join(", ")
						: "Applied";
				t.setText(
						theme.fg("muted", summary) +
						renderDiff(details.diff, theme),
				);
			} else {
				t.setText(theme.fg("success", "Applied"));
			}
			return t;
		},
	});
}
