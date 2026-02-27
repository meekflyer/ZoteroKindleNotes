/**
 * importer.js
 *
 * Writes Kindle highlights into Zotero.
 *
 * Three operations:
 *   1. attachNoteToExisting  — adds a highlights note to an already-matched Zotero item
 *   2. createBookAndNote     — creates a new Zotero book item from lookup metadata,
 *                              places it in the "Kindle Imports" collection,
 *                              then attaches a highlights note
 *   3. importAll             — orchestrates the full import from matcher + lookup output
 *
 * Safety:
 *   - Checks for an existing Kindle note before creating a new one (duplicate guard)
 *   - All Zotero writes are wrapped in try/catch — one failure won't abort the whole import
 *   - Returns a detailed result log so the UI can show exactly what happened
 *
 * Note format:
 *   Zotero notes are stored as HTML. We generate clean, readable HTML with
 *   the book title as an <h1>, each highlight in a <blockquote>, and
 *   your own notes in a styled <p>.
 */

"use strict";

// Tag added to every note we create — used for duplicate detection
const KINDLE_NOTE_TAG = "kindle-import";

// Name of the collection new books are placed in
const IMPORT_COLLECTION_NAME = "Kindle Imports";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the full import.
 *
 * @param {object} importInput
 * @param {Array}  importInput.matched      - From matchBooksToZotero().matched
 * @param {Array}  importInput.confirmed    - Ambiguous books the user confirmed in UI
 * @param {Array}  importInput.lookupResults - From lookupAllUnmatched()
 * @param {object} [zoteroAPI]              - Injected Zotero API for testing
 * @param {function} [onProgress]           - Called after each book: (done, total, title)
 * @returns {Promise<ImportReport>}
 *
 * ImportReport shape:
 * {
 *   notesAdded:    number,
 *   booksCreated:  number,
 *   skipped:       number,   // already had a Kindle note
 *   failed:        Array<{title, reason}>
 * }
 */
async function importAll(importInput, zoteroAPI, onProgress) {
  const api    = zoteroAPI || buildZoteroAPI();
  const report = { notesAdded: 0, booksCreated: 0, skipped: 0, failed: [] };

  const { matched = [], confirmed = [], lookupResults = [] } = importInput;

  // Ensure the "Kindle Imports" collection exists once up front
  const importCollectionID = await getOrCreateCollection(IMPORT_COLLECTION_NAME, api);

  const totalWork = matched.length + confirmed.length + lookupResults.length;
  let done = 0;

  // ── 1. Attach notes to already-matched Zotero items ────────────────────────
  for (const { parsedBook, zoteroItem } of [...matched, ...confirmed]) {
    try {
      const skipped = await attachNoteToExisting(parsedBook, zoteroItem, api);
      if (skipped) report.skipped++;
      else         report.notesAdded++;
    } catch (err) {
      report.failed.push({ title: parsedBook.title, reason: err.message });
    }
    done++;
    if (onProgress) onProgress(done, totalWork, parsedBook.title);
  }

  // ── 2. Create new items + notes for unmatched books ────────────────────────
  for (const { parsedBook, metadata } of lookupResults) {
    try {
      await createBookAndNote(parsedBook, metadata, importCollectionID, api);
      report.booksCreated++;
      report.notesAdded++;
    } catch (err) {
      report.failed.push({ title: parsedBook.title, reason: err.message });
    }
    done++;
    if (onProgress) onProgress(done, totalWork, parsedBook.title);
  }

  return report;
}

/**
 * Attach a Kindle highlights note to an existing Zotero item.
 * Returns true if skipped (note already exists), false if note was created.
 *
 * @param {Book}   parsedBook
 * @param {object} zoteroItem  - Real Zotero item or mock
 * @param {object} api         - Zotero API adapter
 * @returns {Promise<boolean>}  true = skipped, false = note created
 */
async function attachNoteToExisting(parsedBook, zoteroItem, api) {
  const itemID = api.getItemID(zoteroItem);

  // Duplicate guard: check if a Kindle note already exists
  if (await api.hasKindleNote(itemID)) {
    return true; // skip
  }

  const html = buildNoteHTML(parsedBook);
  await api.createNote(itemID, html, [KINDLE_NOTE_TAG]);
  return false;
}

/**
 * Create a new Zotero book item from lookup metadata, add it to the
 * Kindle Imports collection, then attach a highlights note.
 *
 * @param {Book}           parsedBook
 * @param {BookMetadata}   metadata       - From bookLookup.js
 * @param {number|string}  collectionID   - ID of the "Kindle Imports" collection
 * @param {object}         api            - Zotero API adapter
 */
async function createBookAndNote(parsedBook, metadata, collectionID, api) {
  const itemID = await api.createBook({
    title:       metadata.title     || parsedBook.title,
    authors:     metadata.authors.length ? metadata.authors : parsedBook.authors,
    publisher:   metadata.publisher || "",
    year:        metadata.year      || "",
    isbn:        metadata.isbn      || "",
    language:    metadata.language  || "",
    numPages:    metadata.numPages  || "",
    collectionID,
  });

  const html = buildNoteHTML(parsedBook);
  await api.createNote(itemID, html, [KINDLE_NOTE_TAG]);
}

/**
 * Human-readable summary of an import report.
 */
function summarizeImportReport(report) {
  const lines = [
    `✅ Notes added:    ${report.notesAdded}`,
    `📗 Books created:  ${report.booksCreated}`,
    `⏭  Already done:   ${report.skipped} (had existing Kindle note)`,
  ];
  if (report.failed.length > 0) {
    lines.push(`❌ Failed:         ${report.failed.length}`);
    for (const { title, reason } of report.failed) {
      lines.push(`   "${title}": ${reason}`);
    }
  }
  return lines.join("\n");
}

// ─── Note HTML Builder ────────────────────────────────────────────────────────

/**
 * Build the HTML content for a Kindle highlights note.
 *
 * Format:
 *   <h1>Book Title</h1>
 *   <p><em>Imported from Kindle — N highlights, M notes</em></p>
 *   --- for each highlight ---
 *   <blockquote>Highlight text</blockquote>
 *   <p class="location">📍 Page 23 · Location 342–344 · Jan 5, 2025</p>
 *   --- for each note ---
 *   <p class="kindle-note"><strong>Note:</strong> your note text</p>
 *   <p class="location">📍 Page 23 · Jan 5, 2025</p>
 */
function buildNoteHTML(parsedBook) {
  const { title, highlights, notes } = parsedBook;
  const totalClips = highlights.length + notes.length;
  const importDate = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  const lines = [
    `<h1>${escapeHTML(title)}</h1>`,
    `<p><em>Kindle highlights imported on ${importDate} — ` +
      `${highlights.length} highlight${highlights.length !== 1 ? "s" : ""}, ` +
      `${notes.length} note${notes.length !== 1 ? "s" : ""}</em></p>`,
    `<hr/>`,
  ];

  // Merge highlights and notes, sorted by location
  const allClips = [...highlights, ...notes].sort(compareByLocation);

  for (const clip of allClips) {
    if (clip.type === "highlight") {
      lines.push(`<blockquote>${escapeHTML(clip.text)}</blockquote>`);
    } else {
      lines.push(
        `<p><strong>📝 Note:</strong> ${escapeHTML(clip.text)}</p>`
      );
    }
    lines.push(`<p><small>${formatLocation(clip)}</small></p>`);
    lines.push(`<p></p>`); // breathing room between clips
  }

  return lines.join("\n");
}

// ─── Zotero API Adapter ───────────────────────────────────────────────────────

/**
 * Builds an adapter that wraps the real Zotero global API.
 * This indirection lets us inject a mock in tests.
 */
function buildZoteroAPI() {
  return {
    /** Get the numeric ID of a Zotero item */
    getItemID(item) {
      return item.id;
    },

    /** Check if an item already has a Kindle import note attached */
    async hasKindleNote(itemID) {
      const item = Zotero.Items.get(itemID);
      const noteIDs = item.getNotes();
      for (const noteID of noteIDs) {
        const note = Zotero.Items.get(noteID);
        const tags = note.getTags().map(t => t.tag);
        if (tags.includes(KINDLE_NOTE_TAG)) return true;
      }
      return false;
    },

    /** Create a child note on an existing item */
    async createNote(parentItemID, html, tags = []) {
      const note = new Zotero.Item("note");
      note.libraryID  = Zotero.Libraries.userLibraryID;
      note.parentID   = parentItemID;
      note.setNote(html);
      for (const tag of tags) note.addTag(tag);
      await note.saveTx();
      return note.id;
    },

    /** Create a new book item and return its ID */
    async createBook({ title, authors, publisher, year, isbn, language, numPages, collectionID }) {
      const item = new Zotero.Item("book");
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField("title",     title);
      item.setField("publisher", publisher);
      item.setField("date",      year);
      item.setField("ISBN",      isbn);
      item.setField("language",  language);
      item.setField("numPages",  numPages ? String(numPages) : "");

      // Add authors as creators
      const creators = authors.map(name => {
        const parts = name.trim().split(/\s+/);
        const lastName  = parts.length > 1 ? parts.pop() : parts[0];
        const firstName = parts.join(" ");
        return { creatorType: "author", firstName, lastName };
      });
      item.setCreators(creators);

      // Add to collection
      if (collectionID) item.addToCollection(collectionID);

      await item.saveTx();
      return item.id;
    },

    /** Get or create a collection by name, return its ID */
    async getOrCreateCollection(name) {
      return getOrCreateCollection(name, this);
    },
  };
}

// ─── Collection Helper ────────────────────────────────────────────────────────

async function getOrCreateCollection(name, api) {
  // When running inside Zotero
  if (typeof Zotero !== "undefined") {
    const libraryID = Zotero.Libraries.userLibraryID;
    const collections = Zotero.Collections.getByLibrary(libraryID);
    const existing = collections.find(c => c.name === name);
    if (existing) return existing.id;

    // Create it
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = name;
    await collection.saveTx();
    return collection.id;
  }

  // Mock path for testing
  if (api && api._getOrCreateCollection) {
    return api._getOrCreateCollection(name);
  }

  return "mock-collection-id";
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

function formatLocation(clip) {
  const parts = [];
  if (clip.page)          parts.push(`Page ${clip.page}`);
  if (clip.locationStart) {
    const loc = clip.locationEnd && clip.locationEnd !== clip.locationStart
      ? `Location ${clip.locationStart}–${clip.locationEnd}`
      : `Location ${clip.locationStart}`;
    parts.push(loc);
  }
  if (clip.dateAdded) {
    parts.push(clip.dateAdded.toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    }));
  }
  return parts.join(" · ") || "No location data";
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

function compareByLocation(a, b) {
  const aLoc = a.locationStart ?? a.page ?? 0;
  const bLoc = b.locationStart ?? b.page ?? 0;
  return aLoc - bLoc;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

var KindleImporter = {
  importAll,
  attachNoteToExisting,
  createBookAndNote,
  buildNoteHTML,
  summarizeImportReport,
  KINDLE_NOTE_TAG,
  IMPORT_COLLECTION_NAME,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = KindleImporter;
}
