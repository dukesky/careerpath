/**
 * Tolerant extraction of values out of a half-arrived JSON buffer.
 *
 * The streaming legs hand us whatever bytes the model has emitted so far, which
 * is almost never parseable JSON. These helpers pull the few fields the panel
 * can paint early — the score, a rationale, the rows of a matrix — out of that
 * prefix without waiting for the closing brace.
 *
 * Contract, shared by all three:
 * - First occurrence wins. The key is matched wherever it appears in the
 *   buffer, at any nesting depth, and only when it is used as an object key
 *   (a string that merely equals the key is skipped). The analyze and tailor
 *   shapes have unique enough key names for that to be unambiguous.
 * - Nothing throws, on any input: malformed, truncated, hostile or huge. A
 *   value that has not fully arrived reads as "not there yet" (null / []),
 *   never as a truncated guess.
 * - Pure: no I/O, no state, no logging.
 */

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** Characters that prove a number token has ended rather than paused. */
const NUMBER_TERMINATORS = new Set([",", "}", "]", " ", "\t", "\n", "\r"]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function skipWhitespace(buffer: string, from: number): number {
  let i = from;
  while (i < buffer.length && WHITESPACE.has(buffer.charAt(i))) i++;
  return i;
}

/**
 * Index just past the closing quote of the string that opens at `start`, or -1
 * when it never closes in this buffer. A backslash always consumes the next
 * character, so `\"` and `\\` inside the string do not end it.
 */
function scanStringEnd(buffer: string, start: number): number {
  for (let i = start + 1; i < buffer.length; i++) {
    const ch = buffer.charAt(i);
    if (ch === "\\") {
      i++; // skip the escaped character, whatever it is
      continue;
    }
    if (ch === '"') return i + 1;
  }
  return -1;
}

/** Decode a complete `"…"` token, or null when it is not valid JSON. */
function decodeString(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Index of the first character of the value of the first `"key":` pair, or -1
 * when the key has not arrived, is not used as a key, or its value has not
 * started streaming yet.
 *
 * The walk is string-aware: quoted text is stepped over whole, so a key name
 * quoted inside a rationale cannot be mistaken for the field itself.
 */
function findValueStart(buffer: string, key: string): number {
  let i = 0;
  while (i < buffer.length) {
    if (buffer.charAt(i) !== '"') {
      i++;
      continue;
    }
    const end = scanStringEnd(buffer, i);
    // The buffer ends inside a string: nothing complete can follow it.
    if (end < 0) return -1;
    if (decodeString(buffer.slice(i, end)) === key) {
      const colon = skipWhitespace(buffer, end);
      if (buffer.charAt(colon) === ":") {
        const value = skipWhitespace(buffer, colon + 1);
        return value < buffer.length ? value : -1;
      }
    }
    i = end;
  }
  return -1;
}

/** First occurrence of `"key": <number>` in the buffer, else null. */
export function extractNumber(buffer: string, key: string): number | null {
  const start = findValueStart(buffer, key);
  if (start < 0) return null;

  let i = start;
  if (buffer.charAt(i) === "-") i++;

  const intStart = i;
  while (isDigit(buffer.charAt(i))) i++;
  if (i === intStart) return null; // the value is not a number

  if (buffer.charAt(i) === ".") {
    i++;
    const fracStart = i;
    while (isDigit(buffer.charAt(i))) i++;
    if (i === fracStart) return null;
  }

  if (buffer.charAt(i) === "e" || buffer.charAt(i) === "E") {
    i++;
    if (buffer.charAt(i) === "+" || buffer.charAt(i) === "-") i++;
    const expStart = i;
    while (isDigit(buffer.charAt(i))) i++;
    if (i === expStart) return null;
  }

  // A number is only known to be complete once a character that cannot
  // continue it has arrived. `{"overall_match_score": 8` may still become 87,
  // and painting 8 for a frame is worse than painting nothing.
  if (i >= buffer.length || !NUMBER_TERMINATORS.has(buffer.charAt(i))) return null;

  const value = Number(buffer.slice(start, i));
  return Number.isFinite(value) ? value : null;
}

/** First complete `"key": "<string>"` value (handles escaped quotes), else null. */
export function extractString(buffer: string, key: string): string | null {
  const start = findValueStart(buffer, key);
  if (start < 0 || buffer.charAt(start) !== '"') return null;

  const end = scanStringEnd(buffer, start);
  if (end < 0) return null; // still open

  return decodeString(buffer.slice(start, end));
}

/**
 * Complete top-level objects of the array at `"key": [ … ]` — balanced-brace
 * scan, string-aware. Returns [] until the array opens; never throws.
 *
 * An element still being written contributes nothing; it appears on a later
 * call once its closing brace arrives. Elements that are not objects, and
 * elements that are brace-balanced but not valid JSON, are skipped.
 */
export function extractObjects(buffer: string, key: string): unknown[] {
  const start = findValueStart(buffer, key);
  if (start < 0 || buffer.charAt(start) !== "[") return [];

  const objects: unknown[] = [];
  let depth = 0;
  let objectStart = -1;

  for (let i = start + 1; i < buffer.length; i++) {
    const ch = buffer.charAt(i);

    if (ch === '"') {
      const end = scanStringEnd(buffer, i);
      if (end < 0) break; // the tail is an unfinished string
      i = end - 1; // -1: the loop's i++ lands on the character after it
      continue;
    }

    if (ch === "{") {
      if (depth === 0) objectStart = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) break; // malformed; stop rather than mis-slice
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          const parsed: unknown = JSON.parse(buffer.slice(objectStart, i + 1));
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            objects.push(parsed);
          }
        } catch {
          // A malformed element is dropped, not fatal to the ones around it.
        }
        objectStart = -1;
      }
      continue;
    }

    // Brackets only matter at the array's own level: inside an element they
    // are part of that element's JSON and the brace depth already covers them.
    if (ch === "]" && depth === 0) break;
  }

  return objects;
}
