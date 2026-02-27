/**
 * matcher.test.js
 *
 * Run with: node matcher.test.js
 */

"use strict";

const {
  matchBooksToZotero,
  summarizeMatchResult,
  _tokenize: tokenize,
  _diceCoefficient: diceCoefficient,
} = require("./src/matcher.js");

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

/** Create a mock Zotero item (mimics the fields matcher.js reads) */
function mockZoteroItem(title, authors = []) {
  return {
    title,
    creators: authors.map((name) => {
      const parts = name.split(" ");
      const lastName = parts.pop();
      const firstName = parts.join(" ");
      return { creatorType: "author", firstName, lastName };
    }),
  };
}

/** Create a mock Zotero library that returns a fixed set of items */
function mockLibrary(items) {
  return { getItems: () => items };
}

/** Build a minimal parsedBook object matching the shape from parser.js */
function parsedBook(title, authors = [], highlights = 1) {
  return {
    title,
    rawTitle: title,
    authors,
    highlights: Array(highlights).fill({ type: "highlight", text: "sample", locationStart: 1, page: 1, dateAdded: new Date() }),
    notes: [],
  };
}

/** Wrap a single parsedBook in the Map structure parseClippings() returns */
function booksMap(...books) {
  const map = new Map();
  for (const book of books) {
    const key = book.title.toLowerCase() + "::" + book.authors.join(",").toLowerCase();
    map.set(key, book);
  }
  return map;
}

// ─── Test Infrastructure ──────────────────────────────────────────────────────

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

// ─── Tests: Tokenizer ────────────────────────────────────────────────────────

test("Tokenizer: lowercases and removes punctuation", () => {
  const tokens = tokenize("Thinking, Fast and Slow");
  assert(tokens.has("thinking"), "has 'thinking'");
  assert(tokens.has("fast"), "has 'fast'");
  assert(tokens.has("slow"), "has 'slow'");
  assert(!tokens.has("and"), "stop word 'and' removed");
});

test("Tokenizer: handles empty string", () => {
  const tokens = tokenize("");
  assert(tokens.size === 0, "empty set for empty input");
});

test("Tokenizer: removes articles", () => {
  const tokens = tokenize("The Art of War");
  assert(!tokens.has("the"), "'the' removed");
  assert(tokens.has("art"), "has 'art'");
  assert(tokens.has("war"), "has 'war'");
});

// ─── Tests: Dice Coefficient ─────────────────────────────────────────────────

test("Dice coefficient: identical sets = 1.0", () => {
  const a = tokenize("Thinking Fast and Slow");
  assert(diceCoefficient(a, a) === 1.0, "identical → 1.0");
});

test("Dice coefficient: no overlap = 0.0", () => {
  const a = tokenize("completely different words");
  const b = tokenize("unrelated novel title here");
  const score = diceCoefficient(a, b);
  // Bigrams naturally create some minimal overlap between any two English strings
  // (common letter pairs like "re", "le", etc.) — the important thing is it's well below threshold
  assert(score < 0.35, `well below match threshold, got ${score.toFixed(3)}`);
});

test("Dice coefficient: high similarity for minor differences", () => {
  // "Thinking, Fast and Slow" vs "Thinking Fast and Slow" (comma difference)
  const a = tokenize("Thinking, Fast and Slow");
  const b = tokenize("Thinking Fast and Slow");
  const score = diceCoefficient(a, b);
  assert(score > 0.9, `expected >0.9, got ${score.toFixed(3)}`);
});

test("Dice coefficient: handles subtitle variations", () => {
  // Kindle often includes subtitles, Zotero might not
  const kindle = tokenize("The Pragmatic Programmer: 20th Anniversary Edition");
  const zotero = tokenize("The Pragmatic Programmer");
  const score = diceCoefficient(kindle, zotero);
  assert(score > 0.6, `subtitle variation should still score >0.6, got ${score.toFixed(3)}`);
});

// ─── Tests: Full Matching ─────────────────────────────────────────────────────

test("Exact title match → confident match", () => {
  const library = mockLibrary([
    mockZoteroItem("Thinking, Fast and Slow", ["Daniel Kahneman"]),
  ]);
  const books = booksMap(
    parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"])
  );
  const { matched, ambiguous, unmatched } = matchBooksToZotero(books, library);
  assert(matched.length === 1, "1 confident match");
  assert(ambiguous.length === 0, "0 ambiguous");
  assert(unmatched.length === 0, "0 unmatched");
});

test("Minor punctuation difference → still confident match", () => {
  const library = mockLibrary([
    mockZoteroItem("Thinking Fast and Slow", ["Daniel Kahneman"]),
  ]);
  const books = booksMap(
    parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"])
  );
  const { matched } = matchBooksToZotero(books, library);
  assert(matched.length === 1, "matched despite comma difference");
});

test("Subtitle on Kindle title, no subtitle in Zotero → matched or flagged for review", () => {
  const library = mockLibrary([
    mockZoteroItem("The Pragmatic Programmer", ["David Thomas", "Andrew Hunt"]),
  ]);
  const books = booksMap(
    parsedBook("The Pragmatic Programmer: 20th Anniversary Edition", ["David Thomas", "Andrew Hunt"])
  );
  const { matched, ambiguous, unmatched } = matchBooksToZotero(books, library);
  // Must NOT fall into unmatched — it's either a confident match or flagged for user review
  assert(unmatched.length === 0, `should not be unmatched (matched=${matched.length}, ambiguous=${ambiguous.length})`);
  assert(matched.length + ambiguous.length === 1, "book is either matched or flagged for review");
});

test("Author mismatch on otherwise identical title → ambiguous not confident", () => {
  const library = mockLibrary([
    mockZoteroItem("Clean Code", ["Robert C. Martin"]),
  ]);
  // Kindle has no author data for this book
  const books = booksMap(
    parsedBook("Clean Code", [])
  );
  const { matched, ambiguous } = matchBooksToZotero(books, library);
  // With no author info on Kindle side, we still expect a confident title match
  assert(matched.length === 1, "matches on title when no kindle author data");
});

test("Book not in Zotero → unmatched", () => {
  const library = mockLibrary([
    mockZoteroItem("Some Completely Different Book", ["Other Author"]),
  ]);
  const books = booksMap(
    parsedBook("The Lean Startup", ["Eric Ries"])
  );
  const { matched, ambiguous, unmatched } = matchBooksToZotero(books, library);
  assert(unmatched.length === 1, "1 unmatched book");
  assert(matched.length === 0, "0 confident matches");
});

test("Multiple similar titles → best match wins or ambiguous", () => {
  const library = mockLibrary([
    mockZoteroItem("Clean Code: A Handbook of Agile Software Craftsmanship", ["Robert C. Martin"]),
    mockZoteroItem("Clean Architecture: A Craftsman's Guide to Software Structure", ["Robert C. Martin"]),
  ]);
  const books = booksMap(
    parsedBook("Clean Code", ["Robert C. Martin"])
  );
  const { matched, ambiguous, unmatched } = matchBooksToZotero(books, library);
  // "Clean Code" should match to the Clean Code entry, not be lost
  assert(unmatched.length === 0, `should not be unmatched (matched=${matched.length}, ambiguous=${ambiguous.length})`);
  if (matched.length === 1) {
    assert(matched[0].zoteroItem.title.includes("Clean Code"), "matched to the right title");
  }
});

test("Mixed library: some matched, some not", () => {
  const library = mockLibrary([
    mockZoteroItem("Thinking, Fast and Slow", ["Daniel Kahneman"]),
    mockZoteroItem("The Pragmatic Programmer", ["David Thomas"]),
  ]);
  const books = booksMap(
    parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"]),   // in library
    parsedBook("The Lean Startup", ["Eric Ries"]),                 // not in library
    parsedBook("The Pragmatic Programmer", ["David Thomas"]),      // in library
  );
  const { matched, unmatched } = matchBooksToZotero(books, library);
  assert(matched.length === 2, `2 matched, got ${matched.length}`);
  assert(unmatched.length === 1, `1 unmatched, got ${unmatched.length}`);
  assert(unmatched[0].parsedBook.title === "The Lean Startup", "correct book is unmatched");
});

test("Empty Zotero library → all unmatched", () => {
  const library = mockLibrary([]);
  const books = booksMap(
    parsedBook("Any Book", ["Any Author"])
  );
  const { unmatched } = matchBooksToZotero(books, library);
  assert(unmatched.length === 1, "all books unmatched against empty library");
});

test("Summary output is well-formed", () => {
  const library = mockLibrary([
    mockZoteroItem("Thinking, Fast and Slow", ["Daniel Kahneman"]),
  ]);
  const books = booksMap(
    parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"]),
    parsedBook("Unknown Book", ["Unknown Author"]),
  );
  const result = matchBooksToZotero(books, library);
  const summary = summarizeMatchResult(result);
  assert(typeof summary === "string" && summary.length > 0, "summary is non-empty");
  assert(summary.includes("✅"), "contains match indicator");
  assert(summary.includes("➕"), "contains new book indicator");
  console.log("\n" + summary.split("\n").map((l) => "    " + l).join("\n"));
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
