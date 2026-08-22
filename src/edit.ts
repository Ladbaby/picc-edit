// =============================================================================
// picc-edit — src/edit.ts
//
// Orchestrator: a faithful port of claude-code's `FileEditTool.ts`
// `validateInput()` + `call()` (the permission / secrets / team-memory /
// settings-file checks are omitted — pi handles permissions separately).
//
// Behavior:
//   - Existing file: must have been read this session (readState) and not
//     modified since that read. `old_string` is matched (with quote
//     normalization), must be unique unless `replace_all`.
//   - `old_string === ''` on a missing file = create; on a non-empty existing
//     file = error.
//   - Writes with explicit LF handling (the model's sent line endings are
//     respected as-is — no repo resampling).
//   - Returns an `EditOutcome` with a structured patch (leading tabs → 2
//     spaces, for display only) + `originalFile`.
// =============================================================================

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  FILE_MODIFIED_SINCE_READ_ERROR,
  FILE_NOT_READ_ERROR,
} from "./constants.js";
import { getPatchFromContents, type Hunk } from "./diff.js";
import {
  applyEditToFile,
  findActualString,
  preserveQuoteStyle,
} from "./editUtils.js";
import {
  convertLeadingTabsToSpaces,
  findSimilarFile,
  getFileModificationTime,
  type LineEndingType,
  readFileSyncWithMetadata,
  writeTextContent,
} from "./file.js";
import { expandPath } from "./path.js";
import { readStateGet, readStateSet } from "./readState.js";

export type EditInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export type EditOutcome = {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch: Hunk[];
  replaceAll: boolean;
};

/** Thrown for read-guard / edit-validation failures with a model-facing msg. */
export class EditGuardError extends Error {
  // biome-ignore lint/complexity/noUselessConstructor: kept for `instanceof` semantics.
  constructor(message: string) {
    super(message);
  }
}

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Read the current file state for editing. Returns `fileExists: false` with
 * empty content for a missing file; rethrows non-ENOENT errors.
 */
function readFileForEdit(
  absoluteFilePath: string,
): {
  content: string;
  fileExists: boolean;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
} {
  try {
    const meta = readFileSyncWithMetadata(absoluteFilePath);
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    };
  } catch (e) {
    if (isEnoent(e)) {
      return {
        content: "",
        fileExists: false,
        encoding: "utf8",
        lineEndings: "LF",
      };
    }
    throw e;
  }
}

/**
 * Execute an edit, enforcing the read-first / modified-since-read guards and
 * the string-match rules. Returns an `EditOutcome` (the write already
 * performed), or throws `EditGuardError` (guards / match errors) / a plain
 * `Error` (filesystem / OS errors).
 */
export async function editOutcome(
  input: EditInput,
  cwd: string,
): Promise<EditOutcome> {
  const { old_string, new_string, replace_all = false } = input;

  const fullFilePath = expandPath(input.file_path, cwd);
  const dir = dirname(fullFilePath);

  // Ensure parent directory exists (outside the critical section).
  await mkdir(dir, { recursive: true });

  // SECURITY: skip filesystem ops for UNC paths to prevent NTLM credential
  // leaks (permission layer would otherwise handle them).
  if (fullFilePath.startsWith("\\\\") || fullFilePath.startsWith("//")) {
    throw new EditGuardError(
      `Cannot edit network path: ${fullFilePath}`,
    );
  }

  if (old_string === new_string) {
    throw new EditGuardError(
      "No changes to make: old_string and new_string are exactly the same.",
    );
  }

  const { content: originalContent, fileExists, encoding } =
    readFileForEdit(fullFilePath);

  // File doesn't exist:
  //   - empty old_string → new file creation (valid)
  //   - else → error, with a similar-file suggestion
  if (!fileExists) {
    if (old_string === "") {
      const updatedFile = applyEditToFile(
        originalContent,
        old_string,
        new_string,
        replace_all,
      );
      writeTextContent(fullFilePath, updatedFile, encoding, "LF");
      readStateSet(fullFilePath, {
        content: updatedFile,
        timestamp: getFileModificationTime(fullFilePath),
      });
      const patch = getPatchFromContents({
        filePath: fullFilePath,
        oldContent: convertLeadingTabsToSpaces(originalContent),
        newContent: convertLeadingTabsToSpaces(updatedFile),
      });
      return {
        filePath: input.file_path,
        oldString: old_string,
        newString: new_string,
        originalFile: originalContent,
        structuredPatch: patch,
        replaceAll: replace_all,
      };
    }
    const similar = findSimilarFile(fullFilePath);
    let message = `File does not exist. Note: your current working directory is ${cwd}.`;
    if (similar) {
      message += ` Did you mean ${similar}?`;
    }
    throw new EditGuardError(message);
  }

  // File exists with empty old_string — only valid if the file is empty.
  if (old_string === "") {
    if (originalContent.trim() !== "") {
      throw new EditGuardError(
        "Cannot create new file - file already exists.",
      );
    }
  }

  // Read guard (existing file).
  const lastRead = readStateGet(fullFilePath);
  if (!lastRead || lastRead.offset !== undefined || lastRead.limit !== undefined) {
    throw new EditGuardError(FILE_NOT_READ_ERROR);
  }
  const lastWriteTime = getFileModificationTime(fullFilePath);
  if (
    lastWriteTime > lastRead.timestamp &&
    originalContent !== lastRead.content
  ) {
    throw new EditGuardError(FILE_MODIFIED_SINCE_READ_ERROR);
  }

  // Match the string (with quote normalization).
  const actualOldString = findActualString(originalContent, old_string);
  if (!actualOldString) {
    throw new EditGuardError(
      `String to replace not found in file.\nString: ${old_string}`,
    );
  }

  const matches = originalContent.split(actualOldString).length - 1;
  if (matches > 1 && !replace_all) {
    throw new EditGuardError(
      `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
    );
  }

  // Apply the edit (preserving the file's curly-quote style).
  const actualNewString = preserveQuoteStyle(
    old_string,
    actualOldString,
    new_string,
  );
  const updatedFile = applyEditToFile(
    originalContent,
    actualOldString,
    actualNewString,
    replace_all,
  );

  if (updatedFile === originalContent) {
    throw new EditGuardError(
      "Original and edited file match exactly. Failed to apply edit.",
    );
  }

  // Write to disk with LF handling.
  writeTextContent(fullFilePath, updatedFile, encoding, "LF");

  // Record this edit as a fresh full read (invalidates stale re-edits).
  readStateSet(fullFilePath, {
    content: updatedFile,
    timestamp: getFileModificationTime(fullFilePath),
  });

  const structuredPatch = getPatchFromContents({
    filePath: fullFilePath,
    oldContent: convertLeadingTabsToSpaces(originalContent),
    newContent: convertLeadingTabsToSpaces(updatedFile),
  });

  return {
    filePath: input.file_path,
    oldString: actualOldString,
    newString: actualNewString,
    originalFile: originalContent,
    structuredPatch,
    replaceAll: replace_all,
  };
}
