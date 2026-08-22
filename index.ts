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
 *     Read-state is tracked from `tool_result` events (any read tool), the
 *     same mechanism picc-write uses.
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
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	EditGuardError,
	type EditInput,
	type EditOutcome,
	editOutcome,
} from "./src/edit.js";
import {
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
	type ReadEntry,
	readStateClear,
	readStateSet,
} from "./src/readState.js";

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
	const rawPath = input.file_path;
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
		const offset = typeof input.offset === "number" ? input.offset : undefined;
		const limit = typeof input.limit === "number" ? input.limit : undefined;
		const entry: ReadEntry = {
			content: meta.content,
			timestamp,
			offset,
			limit,
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

	// Observe successful reads (any read tool) to feed the edit guard.
	// `tool_result` events carry no cwd of their own; use the process cwd.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "read" && event.toolName !== "Read") return;
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
				return {
					content: [{ type: "text", text: message }],
					details: outcome,
				};
			} catch (err) {
				const message =
					err instanceof EditGuardError
						? err.message
						: err instanceof Error
							? err.message
							: String(err);
				return {
					content: [{ type: "text", text: message }],
					isError: true,
					details: { type: "error", path: input.file_path },
				};
			}
		},
	});
}
