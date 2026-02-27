/**
 * bookLookup.js
 *
 * For Kindle books that couldn't be matched to an existing Zotero item,
 * this module queries external APIs to retrieve proper bibliographic metadata.
 *
 * Strategy:
 *   1. Try Google Books API (title + author search)
 *   2. If no confident result, try Google Books (title only)
 *   3. If still no result, try Open Library API
 *   4. If all fail, return a minimal record so the book can still be added
 *      with whatever Kindle data we have
 *
 * No API keys required. Both APIs are free for low-volume use.
 *
 * Output shape (BookMetadata):
 * {
 *   title:       string,
 *   authors:     string[],       // ["First Last", ...]
 *   publisher:   string|null,
 *   year:        string|null,
 *   isbn:        string|null,    // ISBN-13 preferred, ISBN-10 fallback
 *   language:    string|null,
 *   numPages:    number|null,
 *   source:      "google"|"openlibrary"|"kindle",  // where metadata came from
 *   confidence:  number,         // 0–1, how well the result matched the query
 * }
 */

"use strict";

// ─── Config ───────────────────────────────────────────────────────────────────

const GOOGLE_BOOKS_API   = "https://www.googleapis.com/books/v1/volumes";
const OPEN_LIBRARY_API   = "https://openlibrary.org/search.json";

// Minimum title similarity score to accept an API result as a match.
// Below this we fall back to the next API or return a kindle-sourced record.
const CONFIDENCE_THRESHOLD = 0.55;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up metadata for a single parsed Kindle book.
 *
 * @param {Book} parsedBook   - A book object from parser.js
 * @param {object} [fetchFn]  - Optional fetch override for testing (defaults to global fetch)
 * @returns {Promise<BookMetadata>}
 */
async function lookupBook(parsedBook, fetchFn) {
  const http = fetchFn || fetch;
  const { title, authors } = parsedBook;
  const authorStr = authors[0] || ""; // use first author for search

  // ── 1. Google Books: title + author ────────────────────────────────────────
  let result = await searchGoogleBooks(title, authorStr, http);
  if (result && result.confidence >= CONFIDENCE_THRESHOLD) return result;

  // ── 2. Google Books: title only (author string might be confusing it) ──────
  if (authorStr) {
    result = await searchGoogleBooks(title, "", http);
    if (result && result.confidence >= CONFIDENCE_THRESHOLD) return result;
  }

  // ── 3. Open Library fallback ────────────────────────────────────────────────
  result = await searchOpenLibrary(title, authorStr, http);
  if (result && result.confidence >= CONFIDENCE_THRESHOLD) return result;

  // ── 4. Give up gracefully — return what Kindle gave us ─────────────────────
  return kindleFallback(parsedBook);
}

/**
 * Look up metadata for all unmatched books from the matcher's output.
 * Runs with a small delay between requests to be polite to the APIs.
 *
 * @param {Array<{parsedBook}>} unmatchedBooks  - From matchBooksToZotero().unmatched
 * @param {object} [fetchFn]                    - Optional fetch override for testing
 * @param {function} [onProgress]               - Called after each lookup: (done, total, title)
 * @returns {Promise<Array<{parsedBook, metadata, needsReview}>>}
 */
async function lookupAllUnmatched(unmatchedBooks, fetchFn, onProgress) {
  const results = [];
  const total = unmatchedBooks.length;

  for (let i = 0; i < total; i++) {
    const { parsedBook } = unmatchedBooks[i];
    const metadata = await lookupBook(parsedBook, fetchFn);

    results.push({
      parsedBook,
      metadata,
      // Flag for UI review if we fell back to Kindle data or confidence is low
      needsReview: metadata.source === "kindle" || metadata.confidence < 0.75,
    });

    if (onProgress) onProgress(i + 1, total, parsedBook.title);

    // Polite delay between requests (skip after last one)
    if (i < total - 1) await sleep(300);
  }

  return results;
}

/**
 * Human-readable summary of lookup results.
 */
function summarizeLookupResults(results) {
  const fromGoogle  = results.filter(r => r.metadata.source === "google").length;
  const fromOL      = results.filter(r => r.metadata.source === "openlibrary").length;
  const fromKindle  = results.filter(r => r.metadata.source === "kindle").length;
  const needsReview = results.filter(r => r.needsReview).length;

  const lines = [
    `🔍 Looked up:       ${results.length} books`,
    `✅ Google Books:    ${fromGoogle}`,
    `✅ Open Library:    ${fromOL}`,
    `⚠️  Kindle only:     ${fromKindle} (limited metadata, needs review)`,
    `👀 Needs review:    ${needsReview}`,
  ];

  if (fromKindle > 0) {
    lines.push("\n── Limited metadata (could not find online) ────────────");
    for (const { parsedBook, metadata } of results.filter(r => r.metadata.source === "kindle")) {
      lines.push(`  ? "${parsedBook.title}" by ${parsedBook.authors.join(", ") || "(unknown)"}`);
    }
  }

  return lines.join("\n");
}

// ─── Google Books ─────────────────────────────────────────────────────────────

async function searchGoogleBooks(title, author, http) {
  try {
    let query = `intitle:${encodeURIComponent(title)}`;
    if (author) query += `+inauthor:${encodeURIComponent(author)}`;

    const url = `${GOOGLE_BOOKS_API}?q=${query}&maxResults=5&printType=books&langRestrict=en`;
    const res  = await http(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.items || data.items.length === 0) return null;

    // Score each result and pick the best one
    const scored = data.items
      .map(item => ({
        item,
        score: scoreTitleMatch(title, item.volumeInfo?.title || ""),
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best.score < CONFIDENCE_THRESHOLD) return null;

    return extractGoogleBooksMetadata(best.item, best.score);
  } catch {
    return null;
  }
}

function extractGoogleBooksMetadata(item, confidence) {
  const info = item.volumeInfo || {};

  const authors = (info.authors || []);
  const isbn13  = (info.industryIdentifiers || []).find(id => id.type === "ISBN_13")?.identifier || null;
  const isbn10  = (info.industryIdentifiers || []).find(id => id.type === "ISBN_10")?.identifier || null;

  return {
    title:      info.title || "",
    authors,
    publisher:  info.publisher || null,
    year:       info.publishedDate ? info.publishedDate.slice(0, 4) : null,
    isbn:       isbn13 || isbn10,
    language:   info.language || null,
    numPages:   info.pageCount || null,
    source:     "google",
    confidence,
  };
}

// ─── Open Library ─────────────────────────────────────────────────────────────

async function searchOpenLibrary(title, author, http) {
  try {
    let url = `${OPEN_LIBRARY_API}?title=${encodeURIComponent(title)}&limit=5`;
    if (author) url += `&author=${encodeURIComponent(author)}`;

    const res  = await http(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.docs || data.docs.length === 0) return null;

    const scored = data.docs
      .map(doc => ({
        doc,
        score: scoreTitleMatch(title, doc.title || ""),
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best.score < CONFIDENCE_THRESHOLD) return null;

    return extractOpenLibraryMetadata(best.doc, best.score);
  } catch {
    return null;
  }
}

function extractOpenLibraryMetadata(doc, confidence) {
  const authors = (doc.author_name || []);
  const isbn    = (doc.isbn || [])[0] || null;
  const year    = doc.first_publish_year
    ? String(doc.first_publish_year)
    : null;
  const publisher = (doc.publisher || [])[0] || null;

  return {
    title:      doc.title || "",
    authors,
    publisher,
    year,
    isbn,
    language:   (doc.language || [])[0] || null,
    numPages:   doc.number_of_pages_median || null,
    source:     "openlibrary",
    confidence,
  };
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

/** When no API finds the book, return a minimal record from Kindle data. */
function kindleFallback(parsedBook) {
  return {
    title:      parsedBook.title,
    authors:    parsedBook.authors,
    publisher:  null,
    year:       null,
    isbn:       null,
    language:   null,
    numPages:   null,
    source:     "kindle",
    confidence: 0,
  };
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

/**
 * Score how well an API result title matches the query title.
 * Reuses the same bigram + containment approach from matcher.js,
 * inlined here so bookLookup.js has no dependencies.
 */
function scoreTitleMatch(queryTitle, resultTitle) {
  const a = tokenize(queryTitle);
  const b = tokenize(resultTitle);

  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  // Dice coefficient
  let intersection = 0;
  for (const t of a) { if (b.has(t)) intersection++; }
  const dice = (2 * intersection) / (a.size + b.size);

  // Containment (smaller set within larger)
  const smaller = a.size <= b.size ? a : b;
  const larger  = a.size <= b.size ? b : a;
  let contained = 0;
  for (const t of smaller) { if (larger.has(t)) contained++; }
  const containment = smaller.size === 0 ? 0 : (contained / smaller.size) * 0.9;

  return Math.max(dice, containment);
}

const STOP_WORDS = new Set([
  "a","an","the","of","in","on","at","to","for","and","or",
  "with","by","from","as","is","its","it","be","was","are",
]);

function tokenize(str) {
  if (!str) return new Set();
  const words = str
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));

  const bigrams = new Set();
  for (const word of words) {
    bigrams.add(word);
    for (let i = 0; i < word.length - 1; i++) {
      bigrams.add(word.slice(i, i + 2));
    }
  }
  return bigrams;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

var KindleBookLookup = {
  lookupBook,
  lookupAllUnmatched,
  summarizeLookupResults,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = KindleBookLookup;
}
