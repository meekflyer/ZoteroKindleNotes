/**
 * importer.js
 *
 * Writes Kindle highlights into Zotero.
 *
 * Three operations:
 *   1. attachNoteToExisting  — adds a highlights note to an already-matched Zotero item
 *                              and ensures the item appears in "Kindle Imports"
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

// Legacy tag that older notes may carry — used only for backward-compat detection.
// New notes are NOT tagged; they are identified by the fingerprint comment instead.
const LEGACY_KINDLE_TAG = "kindle-import";

// HTML comment embedded in every generated note for fingerprint comparison.
// Used to detect and re-identify Kindle notes without polluting the user's tags.
const FINGERPRINT_COMMENT_RE = /<!--\s*kindle-import-meta:\s*(\{[^}]+\})\s*-->/;

// Name of the collection all imported books are placed in
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
 *   notesUpdated:  number,   // note replaced because new highlights were found
 *   booksCreated:  number,
 *   skipped:       number,   // no new highlights since last import
 *   failed:        Array<{title, reason}>
 * }
 */
async function importAll(importInput, zoteroAPI, onProgress) {
  const api    = zoteroAPI || buildZoteroAPI();
  const report = { notesAdded: 0, notesUpdated: 0, booksCreated: 0, skipped: 0, failed: [] };

  const { matched = [], confirmed = [], lookupResults = [] } = importInput;

  // Ensure the "Kindle Imports" collection exists once up front
  const importCollectionID = await getOrCreateCollection(IMPORT_COLLECTION_NAME, api);

  const totalWork = matched.length + confirmed.length + lookupResults.length;
  let done = 0;

  // ── 1. Attach notes to already-matched Zotero items ────────────────────────
  for (const { parsedBook, zoteroItem } of [...matched, ...confirmed]) {
    try {
      const result = await attachNoteToExisting(parsedBook, zoteroItem, api, importCollectionID);
      if (result === "skipped")       report.skipped++;
      else if (result === "updated")  report.notesUpdated++;
      else                            report.notesAdded++;
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
 * Attach a Kindle highlights note to an existing Zotero item, and ensure
 * the item is in the "Kindle Imports" collection.
 *
 * Compares a fingerprint embedded in the existing note (if any) against a
 * freshly-computed fingerprint of the current parsed book. If nothing has
 * changed, the note is left alone. If the clippings have changed (or no note
 * exists yet), the old note is replaced (or a new one created).
 *
 * Also cleans up any legacy "kindle-import" tag from pre-tag-removal notes.
 *
 * @param {Book}           parsedBook
 * @param {object}         zoteroItem    - Real Zotero item or mock
 * @param {object}         api           - Zotero API adapter
 * @param {number|string}  collectionID  - ID of the "Kindle Imports" collection
 * @returns {Promise<"added"|"updated"|"skipped">}
 */
async function attachNoteToExisting(parsedBook, zoteroItem, api, collectionID) {
  const itemID = api.getItemID(zoteroItem);

  // Always ensure the item appears in "Kindle Imports", regardless of note state
  if (collectionID) {
    await api.addToCollection(itemID, collectionID);
  }

  const existingNote = await api.getKindleNote(itemID);

  if (!existingNote) {
    // No previous Kindle note — create one fresh (no tag)
    const html = buildNoteHTML(parsedBook);
    await api.createNote(itemID, html);
    return "added";
  }

  // Compare fingerprints to decide whether anything has changed
  const currentFP = computeFingerprint(parsedBook);
  const storedFP  = parseNoteFingerprint(existingNote.html);

  if (storedFP && storedFP.hash === currentFP.hash) {
    return "skipped"; // no new highlights
  }

  // Fingerprints differ (or note predates fingerprinting) — replace with fresh note
  await api.deleteNote(existingNote.id);
  const html = buildNoteHTML(parsedBook);
  await api.createNote(itemID, html);
  return "updated";
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
  await api.createNote(itemID, html); // no tag
}

/**
 * Human-readable summary of an import report.
 */
function summarizeImportReport(report) {
  const lines = [
    `✅ Notes added:    ${report.notesAdded}`,
    `🔄 Notes updated:  ${report.notesUpdated}`,
    `📗 Books created:  ${report.booksCreated}`,
    `⏭  Already done:   ${report.skipped} (no new highlights)`,
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
 *   <!-- kindle-import-meta: {...} -->   ← machine-readable fingerprint
 *   <h1>Kindle Notes</h1>
 *   <p><strong>Book Title</strong></p>
 *   <p><em>Imported on DATE — N highlights, M notes</em></p>
 *   --- for each highlight ---
 *   <blockquote>Highlight text</blockquote>
 *   <p><small>📍 Page 23 · Location 342–344 · Jan 5, 2025</small></p>
 *   --- for each note ---
 *   <p><strong>📝 Note:</strong> your note text</p>
 *   <p><small>📍 Page 23 · Jan 5, 2025</small></p>
 */
function buildNoteHTML(parsedBook) {
  const { title, highlights, notes } = parsedBook;
  const importDate = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  // Embed a machine-readable fingerprint so future imports can detect changes
  // and re-identify this note without relying on tags.
  const fp = computeFingerprint(parsedBook);
  const metaComment = `<!-- kindle-import-meta: ${JSON.stringify(fp)} -->`;

  const lines = [
    metaComment,
    `<h1>Kindle Notes</h1>`,
    `<p><strong>${escapeHTML(title)}</strong></p>`,
    `<p><em>Imported on ${importDate} — ` +
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

// ─── Fingerprint Helpers ──────────────────────────────────────────────────────

/**
 * Compute a fingerprint for a parsed book's current set of clips.
 * Uses a djb2 hash over the sorted location:text pairs so that any change —
 * addition, removal, or edit — produces a different hash.
 *
 * @param {Book} parsedBook
 * @returns {{ count: number, hash: string, kindleKey: string }}
 */
function computeFingerprint(parsedBook) {
  const allClips = [...parsedBook.highlights, ...parsedBook.notes]
    .sort((a, b) => (a.locationStart ?? a.page ?? 0) - (b.locationStart ?? b.page ?? 0));

  const count = allClips.length;
  const hashInput = allClips
    .map(c => `${c.locationStart ?? c.page ?? 0}:${c.text}`)
    .join("|");

  // kindleKey is the stable identifier used to re-find this book's note on future
  // imports — same format as makeBookKey() in parser.js so it matches the Map key.
  const kindleKey =
    parsedBook.title.toLowerCase().replace(/\s+/g, " ").trim() +
    "::" +
    parsedBook.authors.map(a => a.toLowerCase()).sort().join(",");

  return { count, hash: djb2Hash(hashInput), kindleKey };
}

/**
 * Parse the fingerprint stored in an existing note's HTML.
 * Returns null if the comment is absent or malformed (e.g. pre-fingerprint notes).
 *
 * @param {string} html
 * @returns {{ count: number, hash: string, kindleKey: string }|null}
 */
function parseNoteFingerprint(html) {
  const match = html.match(FINGERPRINT_COMMENT_RE);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

/**
 * djb2 hash — fast, dependency-free, consistent across JS engines.
 * Returns an unsigned 32-bit value as a hex string.
 *
 * @param {string} str
 * @returns {string}
 */
function djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
    h = h & h; // keep 32-bit
  }
  return (h >>> 0).toString(16);
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

    /**
     * Return the existing Kindle import note (id + html) if one exists, else null.
     * Detection strategy (in order):
     *   1. Note HTML contains the fingerprint comment (current format, no tag)
     *   2. Note carries the legacy "kindle-import" tag (pre-tag-removal format)
     */
    async getKindleNote(itemID) {
      const item = Zotero.Items.get(itemID);
      const noteIDs = item.getNotes();
      for (const noteID of noteIDs) {
        const note = Zotero.Items.get(noteID);
        const html = note.getNote();
        // Current: identified by embedded fingerprint comment
        if (html.includes("kindle-import-meta")) {
          return { id: note.id, html };
        }
        // Legacy: identified by tag (notes created before tag removal)
        const tags = note.getTags().map(t => t.tag);
        if (tags.includes(LEGACY_KINDLE_TAG)) {
          return { id: note.id, html };
        }
      }
      return null;
    },

    /** Delete a note item by ID */
    async deleteNote(noteID) {
      const note = Zotero.Items.get(noteID);
      await note.eraseTx();
    },

    /** Create a child note on an existing item (no tag) */
    async createNote(parentItemID, html) {
      const note = new Zotero.Item("note");
      note.libraryID  = Zotero.Libraries.userLibraryID;
      note.parentID   = parentItemID;
      note.setNote(html);
      await note.saveTx();
      return note.id;
    },

    /**
     * Add an item to a collection if it isn't already a member.
     * Safe to call multiple times — no-ops if already in the collection.
     */
    async addToCollection(itemID, collectionID) {
      const item = Zotero.Items.get(itemID);
      const currentCollections = item.getCollections();
      if (!currentCollections.includes(collectionID)) {
        item.addToCollection(collectionID);
        await item.saveTx();
      }
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
  IMPORT_COLLECTION_NAME,
  // Exported for testing and use by dialog.js
  _computeFingerprint:    computeFingerprint,
  _parseNoteFingerprint:  parseNoteFingerprint,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = KindleImporter;
}
