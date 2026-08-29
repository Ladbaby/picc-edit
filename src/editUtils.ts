// Claude can't output curly quotes, so we define them as constants here for
// Claude to use in the code. We normalize curly quotes to straight quotes
// when applying edits.
export const LEFT_SINGLE_CURLY_QUOTE = "\u2018";
export const RIGHT_SINGLE_CURLY_QUOTE = "\u2019";
export const LEFT_DOUBLE_CURLY_QUOTE = "\u201c";
export const RIGHT_DOUBLE_CURLY_QUOTE = "\u201d";

/**
 * Normalizes quotes in a string by converting curly quotes to straight quotes.
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/**
 * Strips trailing whitespace from each line in a string while preserving line
 * endings.
 */
export function stripTrailingWhitespace(str: string): string {
  const lines = str.split(/(\r\n|\n|\r)/);

  let result = "";
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    if (part !== undefined) {
      if (i % 2 === 0) {
        // Even indices are line content
        result += part.replace(/\s+$/, "");
      } else {
        // Odd indices are line endings
        result += part;
      }
    }
  }

  return result;
}

/**
 * Finds the actual string in the file content that matches the search string,
 * accounting for quote normalization.
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // First try exact match
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // Try with normalized quotes
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);

  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    // Find the actual string in the file that matches
    return fileContent.substring(searchIndex, searchIndex + searchString.length);
  }

  return null;
}

/**
 * When old_string matched via quote normalization (curly quotes in file,
 * straight quotes from model), apply the same curly quote style to new_string
 * so the edit preserves the file's typography.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  // If they're the same, no normalization happened
  if (oldString === actualOldString) {
    return newString;
  }

  // Detect which curly quote types were in the file
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);

  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString;
  }

  let result = newString;

  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result);
  }

  return result;
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true;
  }
  const prev = chars[index - 1];
  return (
    prev === " " ||
    prev === "\t" ||
    prev === "\n" ||
    prev === "\r" ||
    prev === "(" ||
    prev === "[" ||
    prev === "{" ||
    prev === "\u2014" || // em dash
    prev === "\u2013" // en dash
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      );
    } else {
      result.push(chars[i]!);
    }
  }
  return result.join("");
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // Don't convert apostrophes in contractions (e.g., "don't", "it's")
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i < chars.length - 1 ? chars[i + 1] : undefined;
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (prevIsLetter && nextIsLetter) {
        // Apostrophe in a contraction — use right single curly quote
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(
          isOpeningContext(chars, i)
            ? LEFT_SINGLE_CURLY_QUOTE
            : RIGHT_SINGLE_CURLY_QUOTE,
        );
      }
    } else {
      result.push(chars[i]!);
    }
  }
  return result.join("");
}

/**
 * Applies a single edit to `originalContent`, returning the updated content.
 *
 * The replace callback uses the function form (`() => replace`) so that
 * special `$` sequences in `newString` (`$&`, `$1`, ...) are treated
 * literally rather than as replacement patterns.
 *
 * When deleting a line (`newString === ''`), a trailing newline is stripped
 * from the removed region so we don't leave a blank line behind.
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace);

  if (newString !== "") {
    return f(originalContent, oldString, newString);
  }

  const stripTrailingNewline =
    !oldString.endsWith("\n") && originalContent.includes(oldString + "\n");

  return stripTrailingNewline
    ? f(originalContent, oldString + "\n", newString)
    : f(originalContent, oldString, newString);
}
