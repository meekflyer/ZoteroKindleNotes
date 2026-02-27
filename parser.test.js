/**
 * parser.test.js
 *
 * Run with: node parser.test.js
 * No test framework needed — just plain Node.js.
 */

"use strict";

// Import the parser module
const { parseClippings, summarizeParseResult } = require("./src/parser.js");

// ─── Sample Clippings ────────────────────────────────────────────────────────

const SAMPLE_CLIPPINGS = `\uFEFFThe Pragmatic Programmer (Thomas, David;Hunt, Andrew)
- Your Highlight on page 23 | Location 342-344 | Added on Sunday, January 5, 2025 9:14:32 AM

You Can't Write Perfect Software. Did that hurt? It shouldn't. Accept it as an axiom of life.
==========
The Pragmatic Programmer (Thomas, David;Hunt, Andrew)
- Your Note on page 23 | Location 344 | Added on Sunday, January 5, 2025 9:16:00 AM

Great reminder — revisit during code review
==========
The Pragmatic Programmer (Thomas, David;Hunt, Andrew)
- Your Bookmark on Location 400 | Added on Monday, January 6, 2025 10:00:00 AM

==========
Thinking, Fast and Slow (Kahneman, Daniel)
- Your Highlight on page 5 | Location 72-74 | Added on Monday, March 3, 2025 7:45:00 AM

The confidence people have in their beliefs is not a measure of the quality of evidence but of the coherence of the story that the mind has managed to construct.
==========
Thinking, Fast and Slow (Kahneman, Daniel)
- Your Highlight on page 10 | Location 140-142 | Added on Monday, March 3, 2025 8:00:00 AM

Nothing in life is as important as you think it is, while you are thinking about it.
==========
A Book With No Author
- Your Highlight on page 1 | Location 10-12 | Added on Tuesday, April 1, 2025 6:00:00 AM

Opening line from a mystery book.
==========
Restricted Book (Some Publisher)
- Your Highlight on page 50 | Location 700-702 | Added on Wednesday, April 2, 2025 6:00:00 AM

<You have reached the clipping limit for this item>
==========
`;

// ─── Run Tests ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
  }
}

function test(name, fn) {
  console.log(`\n🧪 ${name}`);
  fn();
}

// ── Run ──────────────────────────────────────────────────────────────────────

const { books, skipped, errors } = parseClippings(SAMPLE_CLIPPINGS);

test("Correct number of books parsed", () => {
  // Pragmatic Programmer, Thinking Fast and Slow, A Book With No Author
  // Restricted book should be dropped
  assert(books.size === 3, `Expected 3 books, got ${books.size}`);
});

test("Pragmatic Programmer: highlights and notes", () => {
  const [key, book] = [...books.entries()].find(([k]) => k.includes("pragmatic")) || [];
  assert(!!book, "Found Pragmatic Programmer entry");
  assert(book.highlights.length === 1, `Expected 1 highlight, got ${book.highlights.length}`);
  assert(book.notes.length === 1, `Expected 1 note, got ${book.notes.length}`);
});

test("Pragmatic Programmer: author normalization (Last, First → First Last)", () => {
  const book = [...books.values()].find((b) => b.title.includes("Pragmatic"));
  assert(book.authors.includes("David Thomas"), `Authors: ${JSON.stringify(book.authors)}`);
  assert(book.authors.includes("Andrew Hunt"), `Authors: ${JSON.stringify(book.authors)}`);
});

test("Pragmatic Programmer: highlight content", () => {
  const book = [...books.values()].find((b) => b.title.includes("Pragmatic"));
  const hl = book.highlights[0];
  assert(hl.page === 23, `Expected page 23, got ${hl.page}`);
  assert(hl.locationStart === 342, `Expected locationStart 342, got ${hl.locationStart}`);
  assert(hl.locationEnd === 344, `Expected locationEnd 344, got ${hl.locationEnd}`);
  assert(hl.text.includes("You Can't Write Perfect Software"), "Highlight text correct");
  assert(hl.dateAdded instanceof Date, "dateAdded is a Date");
});

test("Thinking, Fast and Slow: multiple highlights sorted by location", () => {
  const book = [...books.values()].find((b) => b.title.includes("Thinking"));
  assert(book.highlights.length === 2, `Expected 2 highlights, got ${book.highlights.length}`);
  assert(
    book.highlights[0].locationStart < book.highlights[1].locationStart,
    "Highlights are sorted by location"
  );
});

test("Book with no author in parentheses", () => {
  const book = [...books.values()].find((b) => b.title.includes("No Author"));
  assert(!!book, "Found book with no author");
  assert(Array.isArray(book.authors) && book.authors.length === 0, "Authors array is empty");
});

test("Bookmarks are skipped", () => {
  // Pragmatic Programmer had a bookmark — it should not appear in highlights or notes
  const book = [...books.values()].find((b) => b.title.includes("Pragmatic"));
  const allClips = [...book.highlights, ...book.notes];
  const hasBookmark = allClips.some((c) => c.type === "bookmark");
  assert(!hasBookmark, "No bookmarks in output");
  assert(skipped >= 1, `At least 1 entry skipped (bookmarks/restricted), got ${skipped}`);
});

test("Publisher-restricted highlights are dropped", () => {
  const hasRestricted = [...books.values()].some((b) =>
    b.highlights.some((h) => h.text.includes("clipping limit"))
  );
  assert(!hasRestricted, "No restricted placeholder text in output");
});

test("UTF-8 BOM is stripped", () => {
  // If BOM wasn't stripped, the first book key would start with \uFEFF
  const firstKey = [...books.keys()][0];
  assert(!firstKey.startsWith("\uFEFF"), "BOM stripped from first entry");
});

test("No parse errors on well-formed input", () => {
  assert(errors.length === 0, `Expected 0 errors, got ${errors.length}: ${errors.join(", ")}`);
});

test("Summary output", () => {
  const summary = summarizeParseResult({ books, skipped, errors });
  assert(typeof summary === "string" && summary.length > 0, "Summary is non-empty string");
  console.log("\n" + summary.split("\n").map((l) => "    " + l).join("\n"));
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
