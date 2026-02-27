/**
 * parser.js
 * Parses a Kindle "My Clippings.txt" file into structured JavaScript objects.
 *
 * Output shape:
 * {
 *   books: Map<string, Book>   // keyed by a normalized "title::author" string
 * }
 *
 * Book shape:
 * {
 *   title: string,
 *   authors: string[],         // normalized to "First Last" order
 *   rawTitle: string,          // original title string from Kindle, unmodified
 *   highlights: Highlight[],
 *   notes: Note[]
 * }
 *
 * Highlight shape:
 * {
 *   type: "highlight",
 *   page: number|null,
 *   locationStart: number|null,
 *   locationEnd: number|null,
 *   dateAdded: Date|null,
 *   text: string
 * }
 *
 * Note shape:
 * {
 *   type: "note",
 *   page: number|null,
 *   locationStart: number|null,
 *   dateAdded: Date|null,
 *   text: string
 * }
 */

"use strict";

// ─── Constants ───────────────────────────────────────────────────────────────

const ENTRY_SEPARATOR = "==========";

// Matches the metadata line, e.g.:
//   "- Your Highlight on page 23 | Location 342-344 | Added on Sunday, January 5, 2025 9:14:32 AM"
//   "- Your Note on page 23 | Location 342 | Added on ..."
//   "- Your Bookmark on Location 100 | Added on ..."
const METADATA_REGEX =
  /^-\s+Your\s+(Highlight|Note|Bookmark)(?:\s+on\s+page\s+(\d+))?(?:\s+\|\s+)?(?:Location\s+(\d+)(?:-(\d+))?(?:\s+\|\s+)?)?(?:Added\s+on\s+(.+))?$/i;

// Matches the title/author line, e.g.:
//   "The Pragmatic Programmer (David Thomas;Andrew Hunt)"
//   "Thinking, Fast and Slow (Kahneman, Daniel)"
//   "A Book With No Author Shown"
const TITLE_AUTHOR_REGEX = /^(.*?)\s*\(([^)]+)\)\s*$/;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse the full text content of a My Clippings.txt file.
 *
 * @param {string} fileContent - Raw text content of the file
 * @returns {{ books: Map<string, Book>, skipped: number, errors: string[] }}
 */
function parseClippings(fileContent) {
  // Kindle sometimes writes a UTF-8 BOM at the start — strip it.
  const cleaned = fileContent.replace(/^\uFEFF/, "");

  const rawEntries = cleaned.split(ENTRY_SEPARATOR);

  const books = new Map();
  let skipped = 0;
  const errors = [];

  for (const rawEntry of rawEntries) {
    const trimmed = rawEntry.trim();
    if (!trimmed) continue; // blank block at end of file

    try {
      const result = parseEntry(trimmed);

      if (!result) {
        skipped++;
        continue;
      }

      const { bookKey, book: entryBook, clip } = result;

      if (!books.has(bookKey)) {
        books.set(bookKey, {
          title: entryBook.title,
          rawTitle: entryBook.rawTitle,
          authors: entryBook.authors,
          highlights: [],
          notes: [],
        });
      }

      const book = books.get(bookKey);

      if (clip.type === "highlight") {
        book.highlights.push(clip);
      } else if (clip.type === "note") {
        book.notes.push(clip);
      }
      // Bookmarks are intentionally dropped
    } catch (err) {
      errors.push(`Failed to parse entry: ${err.message}\nEntry was:\n${trimmed.slice(0, 200)}`);
    }
  }

  // Sort highlights within each book by location for cleaner note output
  for (const book of books.values()) {
    book.highlights.sort(compareByLocation);
    book.notes.sort(compareByLocation);
  }

  return { books, skipped, errors };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Parse a single clipping entry block (the text between two "==========" lines).
 * Returns null if the entry should be skipped (bookmark, restricted, empty).
 */
function parseEntry(entryText) {
  // Split into lines, drop empty lines at top/bottom
  const lines = entryText.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = lines.filter((l) => l.length > 0);

  if (nonEmpty.length < 2) return null; // malformed — need at least title + metadata

  const titleLine = nonEmpty[0];
  const metaLine = nonEmpty[1];

  // ── Parse title/author ──────────────────────────────────────────────────
  const { title, rawTitle, authors } = parseTitleLine(titleLine);

  // ── Parse metadata line ─────────────────────────────────────────────────
  const meta = parseMetaLine(metaLine);
  if (!meta) return null; // couldn't parse metadata — skip

  // Skip bookmarks entirely
  if (meta.type === "bookmark") return null;

  // ── Parse highlight/note text ───────────────────────────────────────────
  // Everything after the metadata line and the blank line following it
  const textLines = nonEmpty.slice(2); // skip title + meta; blank line already filtered
  const text = textLines.join(" ").trim();

  // Kindle exports a placeholder when publisher restricts copying
  if (isRestrictedPlaceholder(text)) return null;

  // Skip if no actual text (e.g., empty note)
  if (!text) return null;

  // ── Build clip object ───────────────────────────────────────────────────
  const clip = {
    type: meta.type,
    page: meta.page,
    locationStart: meta.locationStart,
    locationEnd: meta.locationEnd,
    dateAdded: meta.dateAdded,
    text,
  };

  const bookKey = makeBookKey(title, authors);

  return { bookKey, book: { title, rawTitle, authors }, clip };
}

/**
 * Parse the first line of a clipping entry to extract title and authors.
 */
function parseTitleLine(line) {
  const rawTitle = line;

  const match = line.match(TITLE_AUTHOR_REGEX);
  if (!match) {
    // No author info — just a title
    return { title: normalizeTitle(line), rawTitle, authors: [] };
  }

  const titlePart = match[1].trim();
  const authorPart = match[2].trim();

  const title = normalizeTitle(titlePart);
  const authors = parseAuthors(authorPart);

  return { title, rawTitle, authors };
}

/**
 * Parse the metadata line (second line of a clipping entry).
 * Returns null if the line doesn't match the expected format.
 */
function parseMetaLine(line) {
  const match = line.match(METADATA_REGEX);
  if (!match) return null;

  const [, typeStr, pageStr, locStartStr, locEndStr, dateStr] = match;

  return {
    type: typeStr.toLowerCase(), // "highlight", "note", or "bookmark"
    page: pageStr ? parseInt(pageStr, 10) : null,
    locationStart: locStartStr ? parseInt(locStartStr, 10) : null,
    locationEnd: locEndStr ? parseInt(locEndStr, 10) : null,
    dateAdded: dateStr ? parseDateString(dateStr.trim()) : null,
  };
}

/**
 * Parse the author string from inside the parentheses.
 * Handles:
 *   "David Thomas;Andrew Hunt"          → ["David Thomas", "Andrew Hunt"]
 *   "Kahneman, Daniel"                  → ["Daniel Kahneman"]
 *   "Kahneman, Daniel;Thaler, Richard"  → ["Daniel Kahneman", "Richard Thaler"]
 */
function parseAuthors(authorStr) {
  const rawAuthors = authorStr.split(";").map((a) => a.trim()).filter(Boolean);
  return rawAuthors.map(normalizeAuthorName);
}

/**
 * Convert "Last, First" to "First Last". Pass through "First Last" unchanged.
 */
function normalizeAuthorName(name) {
  const commaIndex = name.indexOf(",");
  if (commaIndex === -1) return name.trim();

  const last = name.slice(0, commaIndex).trim();
  const first = name.slice(commaIndex + 1).trim();
  return first ? `${first} ${last}` : last;
}

/**
 * Light normalization of a book title:
 * - Trim whitespace
 * - Collapse internal whitespace
 * - Remove trailing punctuation artifacts Kindle sometimes adds
 */
function normalizeTitle(title) {
  return title
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[：﹕]/, ":") // normalize full-width colons
    .trim();
}

/**
 * Build a stable, lowercase key for deduplicating books.
 * Uses "title::author1,author2" to avoid collisions between different books
 * by different authors that happen to share a title.
 */
function makeBookKey(title, authors) {
  const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
  const authorKey = authors.map((a) => a.toLowerCase()).sort().join(",");
  return `${titleKey}::${authorKey}`;
}

/**
 * Parse Kindle's date string format:
 *   "Sunday, January 5, 2025 9:14:32 AM"
 * Returns a Date object, or null if parsing fails.
 */
function parseDateString(dateStr) {
  // Remove the day-of-week prefix ("Sunday, ") since Date.parse doesn't need it
  const withoutDayOfWeek = dateStr.replace(/^[A-Za-z]+,\s*/, "");
  const parsed = new Date(withoutDayOfWeek);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Kindle uses this exact string when a publisher has restricted copying.
 */
function isRestrictedPlaceholder(text) {
  return /your\s+kindle\s+account[^.]*content\s+limit/i.test(text) ||
    /you\s+have\s+reached\s+the\s+clipping\s+limit/i.test(text);
}

/**
 * Comparator for sorting clips by location within a book.
 */
function compareByLocation(a, b) {
  const aLoc = a.locationStart ?? a.page ?? 0;
  const bLoc = b.locationStart ?? b.page ?? 0;
  return aLoc - bLoc;
}

// ─── Utility: Summary ────────────────────────────────────────────────────────

/**
 * Returns a human-readable summary of a parse result.
 * Useful for logging and the UI confirmation step.
 *
 * @param {{ books: Map, skipped: number, errors: string[] }} parseResult
 * @returns {string}
 */
function summarizeParseResult({ books, skipped, errors }) {
  let totalHighlights = 0;
  let totalNotes = 0;

  for (const book of books.values()) {
    totalHighlights += book.highlights.length;
    totalNotes += book.notes.length;
  }

  const lines = [
    `📚 Books found:       ${books.size}`,
    `🖊  Highlights found:  ${totalHighlights}`,
    `📝 Notes found:       ${totalNotes}`,
    `⏭  Skipped entries:   ${skipped} (bookmarks, restricted, empty)`,
  ];

  if (errors.length > 0) {
    lines.push(`⚠️  Parse errors:      ${errors.length}`);
  }

  return lines.join("\n");
}

// ─── Exports ─────────────────────────────────────────────────────────────────

// In Zotero plugin context these will be accessed as module properties.
// The bootstrap.js will import this file and expose these functions.
var KindleParser = { parseClippings, summarizeParseResult };

// CommonJS export for testing outside Zotero (node parser.test.js)
if (typeof module !== "undefined" && module.exports) {
  module.exports = KindleParser;
}
