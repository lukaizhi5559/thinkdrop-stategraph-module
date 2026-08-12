/**
 * incrementalJsonParser.js — Incremental JSON array parser
 *
 * Accumulates text chunks from an LLM stream and detects complete top-level
 * JSON objects inside a JSON array. As each object completes, calls onObject
 * with the parsed step so the caller can emit it to the frontend immediately.
 *
 * Design:
 *   - Tracks brace depth to detect object boundaries (handles nested args objects)
 *   - Skips non-JSON text before the array (e.g. "Here's the plan: [...]")
 *   - Strips ```json ... ``` code fences
 *   - Tolerates malformed objects (skips bad ones, continues parsing)
 *   - Handles strings with escaped quotes and braces inside string values
 *   - Uses a persistent scan position to avoid re-scanning characters across feeds
 *
 * Usage:
 *   const parser = new IncrementalJsonArrayParser((step) => {
 *     console.log('Step revealed:', step);
 *   });
 *   for (const chunk of streamChunks) {
 *     parser.feed(chunk);
 *   }
 *   // parser.getFullText() returns the complete accumulated text for final parsing
 */

'use strict';

class IncrementalJsonArrayParser {
  /**
   * @param {function(object): void} onObject — called with each parsed top-level object
   */
  constructor(onObject) {
    this._onObject = onObject;
    this._buffer = '';
    this._fullText = '';
    this._arrayStarted = false;
    this._objectStart = -1; // index in _buffer where current object began
    this._depth = 0; // brace depth within current object
    this._inString = false;
    this._escape = false;
    this._objectCount = 0;
    this._scanPos = 0; // position to resume scanning from on next feed()
  }

  /**
   * Feed a chunk of text from the LLM stream.
   * Detects complete JSON objects and calls onObject for each.
   * @param {string} chunk
   */
  feed(chunk) {
    if (!chunk) return;
    this._buffer += chunk;
    this._fullText += chunk;
    this._scan();
  }

  /**
   * Scan the buffer from _scanPos to find complete JSON objects.
   * Updates _scanPos so we never re-scan characters across feed() calls.
   */
  _scan() {
    const len = this._buffer.length;
    let i = this._scanPos;

    while (i < len) {
      const ch = this._buffer[i];

      // If we're inside a string, only watch for end-of-string
      if (this._inString) {
        if (this._escape) {
          this._escape = false;
        } else if (ch === '\\') {
          this._escape = true;
        } else if (ch === '"') {
          this._inString = false;
        }
        i++;
        continue;
      }

      // Not in a string — look for array start, object boundaries, etc.
      if (ch === '"') {
        this._inString = true;
        i++;
        continue;
      }

      // Find the start of the JSON array (skip prose before it)
      if (!this._arrayStarted) {
        if (ch === '[') {
          this._arrayStarted = true;
        }
        i++;
        continue;
      }

      // Array has started — look for object boundaries
      if (this._objectStart === -1) {
        // Looking for the start of an object
        if (ch === '{') {
          this._objectStart = i;
          this._depth = 1;
          i++;
          continue;
        }
        if (ch === ']') {
          // End of array — we're done
          i++;
          this._scanPos = i;
          this._trimBuffer();
          return;
        }
        // Skip whitespace, commas, etc. between objects
        i++;
        continue;
      }

      // Inside an object — track brace depth
      if (ch === '{') {
        this._depth++;
      } else if (ch === '}') {
        this._depth--;
        if (this._depth === 0) {
          // Complete object found — extract and parse
          const objectText = this._buffer.slice(this._objectStart, i + 1);
          this._tryParseObject(objectText);
          // Reset for next object
          this._objectStart = -1;
          this._depth = 0;
        }
      }

      i++;
    }

    this._scanPos = i;
    this._trimBuffer();
  }

  /**
   * Trim processed characters from the buffer to keep memory bounded.
   * Keeps everything from _objectStart onward (if inside an object),
   * or trims everything up to _scanPos if between objects.
   */
  _trimBuffer() {
    if (this._objectStart >= 0) {
      // Inside an object — keep from object start onward
      const trimTo = this._objectStart;
      if (trimTo > 0) {
        this._buffer = this._buffer.slice(trimTo);
        this._objectStart -= trimTo;
        this._scanPos -= trimTo;
      }
    } else if (this._arrayStarted) {
      // Between objects in the array — trim processed chars
      if (this._scanPos > 0) {
        this._buffer = this._buffer.slice(this._scanPos);
        this._scanPos = 0;
      }
    } else {
      // Haven't found array yet — keep last few chars in case '[' is split
      // across chunks. Keep last 10 chars to be safe.
      if (this._buffer.length > 10) {
        this._buffer = this._buffer.slice(-10);
        this._scanPos = 0;
      }
    }
  }

  /**
   * Try to parse an object string. If valid, call onObject.
   * If invalid (malformed JSON), skip silently.
   * @param {string} objectText
   */
  _tryParseObject(objectText) {
    try {
      const parsed = JSON.parse(objectText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this._objectCount++;
        this._onObject(parsed);
      }
    } catch (_e) {
      // Malformed JSON — skip this object and continue
      // This can happen if the LLM emits trailing commas, missing quotes, etc.
    }
  }

  /**
   * Get the full accumulated text (for final parsing by the caller).
   * Strips code fences.
   * @returns {string}
   */
  getFullText() {
    return this._fullText
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```\s*$/i, '')
      .trim();
  }

  /**
   * Get the number of objects successfully parsed so far.
   * @returns {number}
   */
  getObjectCount() {
    return this._objectCount;
  }
}

module.exports = { IncrementalJsonArrayParser };
