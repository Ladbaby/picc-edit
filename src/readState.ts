// =============================================================================
// picc-edit — src/readState.ts
//
// Session-scoped "has this file been read (and when)" map, mirroring Claude
// Code's `readFileState`. pi has no shared read-state, so each of picc-write
// and picc-edit owns its own: the entry point populates it from `tool_result`
// events for any file tool that establishes known contents (read/write/edit)
// and clears it on session start.
// =============================================================================

/** A recorded read of a file. `offset`/`limit` present ⇒ partial view. */
export type ReadEntry = {
  content: string;
  timestamp: number;
  offset?: number;
  limit?: number;
};

/**
 * Tool names whose successful `tool_result` means the file's contents are
 * known and can seed the read-state. Mirrors Claude Code, where Read, Write,
 * and Edit each refresh the shared `readFileState` — so a file the agent just
 * wrote (or edited) is immediately editable/writable without a redundant
 * re-read. Both pi's lowercase built-ins and the capitalized picc ports are
 * accepted, since the active name depends on each extension's config.
 */
const KNOWN_FILE_TOOL_NAMES = new Set([
  "read",
  "Read",
  "write",
  "Write",
  "edit",
  "Edit",
]);

export function fileStateToolName(name: string): boolean {
  return KNOWN_FILE_TOOL_NAMES.has(name);
}

const state = new Map<string, ReadEntry>();

export function readStateGet(filePath: string): ReadEntry | undefined {
  return state.get(filePath);
}

export function readStateSet(filePath: string, entry: ReadEntry): void {
  state.set(filePath, entry);
}

export function readStateClear(): void {
  state.clear();
}
