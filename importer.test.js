/**
 * importer.test.js
 *
 * Run with: node importer.test.js
 */

"use strict";

const {
  importAll,
  attachNoteToExisting,
  createBookAndNote,
  buildNoteHTML,
  summarizeImportReport,
  KINDLE_NOTE_TAG,
  IMPORT_COLLECTION_NAME,
} = require("./src/importer.js");

// ─── Test Infrastructure ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  ✅ ${message}`); passed++; }
  else           { console.error(`  ❌ ${message}`); failed++; }
}

function test(name, fn) {
  console.log(`\n🧪 ${name}`);
  return Promise.resolve().then(fn);
}

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

let nextID = 1;

/**
 * Build a mock Zotero API that stores created items/notes in memory.
 * Lets us verify what was written without needing real Zotero.
 */
function buildMockAPI(opts = {}) {
  const notes   = new Map(); // itemID → [{ html, tags }]
  const books   = [];
  const collections = new Map();

  return {
    // State inspection helpers (not part of real API)
    _notes:       notes,
    _books:       books,
    _collections: collections,

    getItemID(item) {
      return item.id;
    },

    async hasKindleNote(itemID) {
      if (opts.existingNoteOnItem === itemID) return true;
      const existing = notes.get(itemID) || [];
      return existing.some(n => n.tags.includes(KINDLE_NOTE_TAG));
    },

    async createNote(parentItemID, html, tags = []) {
      const id = nextID++;
      const list = notes.get(parentItemID) || [];
      list.push({ id, html, tags });
      notes.set(parentItemID, list);
      return id;
    },

    async createBook({ title, authors, publisher, year, isbn, language, numPages, collectionID }) {
      const id = nextID++;
      books.push({ id, title, authors, publisher, year, isbn, collectionID });
      return id;
    },

    _getOrCreateCollection(name) {
      if (!collections.has(name)) collections.set(name, nextID++);
      return collections.get(name);
    },
  };
}

/** Minimal parsedBook */
function parsedBook(title, authors = [], highlightCount = 3, noteCount = 1) {
  const highlights = Array.from({ length: highlightCount }, (_, i) => ({
    type: "highlight",
    text: `Highlight number ${i + 1} — some interesting passage from the book.`,
    page: i + 1,
    locationStart: (i + 1) * 10,
    locationEnd:   (i + 1) * 10 + 2,
    dateAdded: new Date("2025-01-05"),
  }));
  const notes = Array.from({ length: noteCount }, (_, i) => ({
    type: "note",
    text: `My note ${i + 1} — a personal observation.`,
    page: i + 1,
    locationStart: (i + 1) * 10 + 1,
    locationEnd: null,
    dateAdded: new Date("2025-01-05"),
  }));
  return { title, rawTitle: title, authors, highlights, notes };
}

/** Minimal zoteroItem mock */
function zoteroItem(id, title) {
  return { id, title };
}

/** Minimal BookMetadata (from bookLookup) */
function metadata(overrides = {}) {
  return {
    title:      "Test Book",
    authors:    ["Test Author"],
    publisher:  "Test Publisher",
    year:       "2020",
    isbn:       "9781234567890",
    language:   "en",
    numPages:   300,
    source:     "google",
    confidence: 0.95,
    ...overrides,
  };
}

// ─── Tests: Note HTML Builder ─────────────────────────────────────────────────

async function runTests() {

await test("buildNoteHTML: contains book title as h1", async () => {
  const book = parsedBook("Thinking, Fast and Slow");
  const html = buildNoteHTML(book);
  assert(html.includes("<h1>Thinking, Fast and Slow</h1>"), "h1 title present");
});

await test("buildNoteHTML: highlights rendered as blockquotes", async () => {
  const book = parsedBook("Test Book", [], 2, 0);
  const html = buildNoteHTML(book);
  const count = (html.match(/<blockquote>/g) || []).length;
  assert(count === 2, `2 blockquotes for 2 highlights (got ${count})`);
});

await test("buildNoteHTML: notes rendered with Note label", async () => {
  const book = parsedBook("Test Book", [], 0, 2);
  const html = buildNoteHTML(book);
  const count = (html.match(/📝 Note:/g) || []).length;
  assert(count === 2, `2 note labels (got ${count})`);
});

await test("buildNoteHTML: location info included", async () => {
  const book = parsedBook("Test Book", [], 1, 0);
  const html = buildNoteHTML(book);
  assert(html.includes("Page 1"), "page number present");
  assert(html.includes("Location"), "location present");
});

await test("buildNoteHTML: HTML special chars escaped", async () => {
  const book = parsedBook('A Book with <script> & "quotes"', []);
  book.highlights[0] = {
    type: "highlight",
    text: 'Text with <b>tags</b> & "quotes" and \'apostrophes\'',
    page: 1, locationStart: 10, locationEnd: 12, dateAdded: new Date(),
  };
  const html = buildNoteHTML(book);
  assert(!html.includes("<b>tags</b>"), "HTML tags escaped in highlight text");
  assert(html.includes("&lt;b&gt;"), "angle brackets escaped");
  assert(html.includes("&amp;"), "ampersand escaped");
});

await test("buildNoteHTML: import metadata line present", async () => {
  const book = parsedBook("Test Book", [], 3, 1);
  const html = buildNoteHTML(book);
  assert(html.includes("3 highlights"), "highlight count in metadata");
  assert(html.includes("1 note"), "note count in metadata");
  assert(html.includes("Kindle highlights imported"), "import label present");
});

// ─── Tests: attachNoteToExisting ─────────────────────────────────────────────

await test("attachNoteToExisting: creates note on a matched item", async () => {
  const api  = buildMockAPI();
  const book = parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"]);
  const item = zoteroItem(42, "Thinking, Fast and Slow");

  const skipped = await attachNoteToExisting(book, item, api);

  assert(skipped === false, "not skipped");
  const notes = api._notes.get(42);
  assert(notes && notes.length === 1, "one note created");
  assert(notes[0].tags.includes(KINDLE_NOTE_TAG), "kindle-import tag present");
  assert(notes[0].html.includes("<h1>"), "note has HTML content");
});

await test("attachNoteToExisting: skips if Kindle note already exists", async () => {
  const api  = buildMockAPI({ existingNoteOnItem: 99 });
  const book = parsedBook("Some Book", []);
  const item = zoteroItem(99, "Some Book");

  const skipped = await attachNoteToExisting(book, item, api);

  assert(skipped === true, "skipped due to existing note");
  assert(!api._notes.has(99), "no new note created");
});

// ─── Tests: createBookAndNote ─────────────────────────────────────────────────

await test("createBookAndNote: creates a book item with correct fields", async () => {
  const api  = buildMockAPI();
  const book = parsedBook("The Lean Startup", ["Eric Ries"]);
  const meta = metadata({ title: "The Lean Startup", authors: ["Eric Ries"], isbn: "9780307887894", year: "2011" });

  await createBookAndNote(book, meta, "collection-1", api);

  assert(api._books.length === 1, "one book created");
  const created = api._books[0];
  assert(created.title === "The Lean Startup", `title correct (got ${created.title})`);
  assert(created.authors.includes("Eric Ries"), "author correct");
  assert(created.isbn === "9780307887894", `isbn correct (got ${created.isbn})`);
  assert(created.year === "2011", `year correct (got ${created.year})`);
  assert(created.collectionID === "collection-1", "placed in correct collection");
});

await test("createBookAndNote: note is attached to new book", async () => {
  const api  = buildMockAPI();
  const book = parsedBook("The Lean Startup", ["Eric Ries"]);
  const meta = metadata();

  await createBookAndNote(book, meta, "collection-1", api);

  const bookID = api._books[0].id;
  const notes  = api._notes.get(bookID);
  assert(notes && notes.length === 1, "note attached to new book");
  assert(notes[0].tags.includes(KINDLE_NOTE_TAG), "kindle-import tag on note");
});

await test("createBookAndNote: falls back to Kindle authors if metadata has none", async () => {
  const api  = buildMockAPI();
  const book = parsedBook("Obscure Book", ["Kindle Author"]);
  const meta = metadata({ authors: [] }); // empty from API

  await createBookAndNote(book, meta, "col", api);

  assert(api._books[0].authors.includes("Kindle Author"), "fell back to Kindle author");
});

// ─── Tests: importAll ─────────────────────────────────────────────────────────

await test("importAll: processes matched + lookup results", async () => {
  const api = buildMockAPI();

  const matchedBook = parsedBook("Matched Book", ["Author A"]);
  const newBook     = parsedBook("New Book",     ["Author B"]);

  const report = await importAll({
    matched: [{ parsedBook: matchedBook, zoteroItem: zoteroItem(10, "Matched Book") }],
    confirmed: [],
    lookupResults: [{ parsedBook: newBook, metadata: metadata({ title: "New Book" }) }],
  }, api);

  assert(report.notesAdded === 2,   `2 notes added (got ${report.notesAdded})`);
  assert(report.booksCreated === 1, `1 book created (got ${report.booksCreated})`);
  assert(report.skipped === 0,      `0 skipped (got ${report.skipped})`);
  assert(report.failed.length === 0, "no failures");
});

await test("importAll: counts skipped items correctly", async () => {
  const api = buildMockAPI({ existingNoteOnItem: 10 });

  const report = await importAll({
    matched: [{ parsedBook: parsedBook("Already Done"), zoteroItem: zoteroItem(10, "Already Done") }],
    confirmed: [],
    lookupResults: [],
  }, api);

  assert(report.skipped === 1,    `1 skipped (got ${report.skipped})`);
  assert(report.notesAdded === 0, `0 notes added (got ${report.notesAdded})`);
});

await test("importAll: one failure doesn't abort the rest", async () => {
  const api = buildMockAPI();
  // Make createNote throw on item 10 only
  const origCreate = api.createNote.bind(api);
  api.createNote = async (parentID, html, tags) => {
    if (parentID === 10) throw new Error("Simulated write error");
    return origCreate(parentID, html, tags);
  };

  const report = await importAll({
    matched: [
      { parsedBook: parsedBook("Failing Book"), zoteroItem: zoteroItem(10, "Failing Book") },
      { parsedBook: parsedBook("Good Book"),    zoteroItem: zoteroItem(11, "Good Book") },
    ],
    confirmed: [],
    lookupResults: [],
  }, api);

  assert(report.failed.length === 1,  "1 failure recorded");
  assert(report.notesAdded === 1,     "other book still processed");
  assert(report.failed[0].title === "Failing Book", "correct book in failure log");
});

await test("importAll: confirmed ambiguous books treated same as matched", async () => {
  const api = buildMockAPI();

  const report = await importAll({
    matched: [],
    confirmed: [{ parsedBook: parsedBook("Confirmed Book"), zoteroItem: zoteroItem(20, "Confirmed Book") }],
    lookupResults: [],
  }, api);

  assert(report.notesAdded === 1, "confirmed book got a note");
  assert(api._notes.has(20), "note is on the right item");
});

await test("importAll: progress callback is called", async () => {
  const api = buildMockAPI();
  const calls = [];

  await importAll({
    matched: [{ parsedBook: parsedBook("Book A"), zoteroItem: zoteroItem(1, "Book A") }],
    confirmed: [],
    lookupResults: [{ parsedBook: parsedBook("Book B"), metadata: metadata() }],
  }, api, (done, total, title) => calls.push({ done, total, title }));

  assert(calls.length === 2, `progress called twice (got ${calls.length})`);
  assert(calls[1].done === 2, "final call shows done=2");
  assert(calls[0].total === 2, "total is always 2");
});

// ─── Tests: summarizeImportReport ────────────────────────────────────────────

await test("summarizeImportReport: well-formed output", async () => {
  const report = { notesAdded: 10, booksCreated: 3, skipped: 2, failed: [
    { title: "Problem Book", reason: "save failed" },
  ]};
  const summary = summarizeImportReport(report);
  assert(summary.includes("10"), "notes count present");
  assert(summary.includes("3"),  "books count present");
  assert(summary.includes("2"),  "skipped count present");
  assert(summary.includes("Problem Book"), "failed book mentioned");
  console.log("\n" + summary.split("\n").map(l => "    " + l).join("\n"));
});

// ─── Final results ────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
