// =============================================================================
// picc-edit — src/constants.ts
//
// Port of claude-code's `tools/FileEditTool/constants.ts` plus the read-guard
// error strings (from `FileReadTool`/`FileEditTool`).
// =============================================================================

export const FILE_EDIT_TOOL_NAME = "Edit";

/**
 * Error strings returned by the edit orchestrator when the read-first /
 * modified-since-read guards fire.
 */
export const FILE_NOT_READ_ERROR =
  "File has not been read yet. Read it first before writing to it.";

export const FILE_MODIFIED_SINCE_READ_ERROR =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
