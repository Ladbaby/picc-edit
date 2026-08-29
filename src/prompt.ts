// =============================================================================
// picc-edit — src/prompt.ts
//
// Adaptors vs upstream:
//   - `isCompactLinePrefixEnabled()` is hardcoded to `true` (picc-read always
//     uses the compact `line-number + tab` prefix).
//   - The `USER_TYPE === 'ant'` minimal-uniqueness hint is dropped.
//   - `FILE_READ_TOOL_NAME` is fixed to `Read` (the read tool is configured
//     independently of this extension).
// =============================================================================

function getPreReadInstruction(): string {
  return `\n- You must use your \`read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. `;
}

export function getEditToolDescription(): string {
  return getDefaultEditDescription();
}

function getDefaultEditDescription(): string {
  const prefixFormat = "line number + tab";
  return `Performs exact string replacements in files.

Usage:${getPreReadInstruction()}
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: ${prefixFormat}. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;
}

/** Faithful success messages (from Claude Code's `mapToolResultToToolResultBlockParam`). */
export function replaceAllMessage(filePath: string): string {
  return `The file ${filePath} has been updated. All occurrences were successfully replaced.`;
}

export function singleEditMessage(filePath: string): string {
  return `The file ${filePath} has been updated successfully.`;
}
