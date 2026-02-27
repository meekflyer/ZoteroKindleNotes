/**
 * test_matcher_real.js
 *
 * Runs your real Kindle clippings against your real Zotero library export.
 *
 * Usage:
 *   node test_matcher_real.js
 *
 * Expects in the same folder:
 *   - My Clippings.txt
 *   - My_Library.csv   (exported from Zotero: File → Export Library → CSV)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const { parseClippings }       = require("./src/parser.js");
const { matchBooksToZotero, summarizeMatchResult } = require("./src/matcher.js");

// ─── Load & parse Kindle clippings ───────────────────────────────────────────

const clippingsPath = path.join(__dirname, "My Clippings.txt");
if (!fs.existsSync(clippingsPath)) {
  console.error('❌ Could not find "My Clippings.txt" in this folder.');
  process.exit(1);
}

const clippingsText = fs.readFileSync(clippingsPath, "utf8");
const { books: kindleBooks, skipped, errors } = parseClippings(clippingsText);

console.log("── Kindle clippings ─────────────────────────────────────");
console.log(`📚 Books:       ${kindleBooks.size}`);
console.log(`🖊  Highlights:  ${[...kindleBooks.values()].reduce((n, b) => n + b.highlights.length, 0)}`);
console.log(`⏭  Skipped:     ${skipped}`);
if (errors.length) console.log(`⚠️  Errors:      ${errors.length}`);

// ─── Load & parse Zotero CSV ──────────────────────────────────────────────────

const csvPath = path.join(__dirname, "My_Library.csv");
if (!fs.existsSync(csvPath)) {
  console.error('❌ Could not find "My_Library.csv" in this folder.');
  process.exit(1);
}

const csvText = fs.readFileSync(csvPath, "utf8");
const zoteroItems = parseZoteroCSV(csvText);

console.log("\n── Zotero library ───────────────────────────────────────");
console.log(`📖 Total items:  ${zoteroItems.length}`);
const bookItems = zoteroItems.filter(i => i.itemType === "book" || i.itemType === "bookSection");
console.log(`📗 Books only:   ${bookItems.length}`);

// ─── Run matcher ──────────────────────────────────────────────────────────────

// Build a mock library that the matcher can query
const mockLib = { getItems: () => bookItems };

const result = matchBooksToZotero(kindleBooks, mockLib);

console.log("\n── Match results ────────────────────────────────────────");
console.log(summarizeMatchResult(result));

// ─── Detailed unmatched list (most actionable output) ────────────────────────

if (result.unmatched.length > 0) {
  console.log("\n── Unmatched Kindle books (will be auto-added to Zotero) ──");
  for (const { parsedBook } of result.unmatched) {
    const authors = parsedBook.authors.join(", ") || "(no author)";
    const count   = parsedBook.highlights.length;
    console.log(`  + "${parsedBook.title}" — ${authors} [${count} highlights]`);
  }
}

// ─── Simple CSV parser ────────────────────────────────────────────────────────
// Handles quoted fields with commas and embedded newlines.

function parseZoteroCSV(text) {
  // Strip BOM
  const clean = text.replace(/^\uFEFF/, "");
  const rows  = splitCSVRows(clean);
  if (rows.length < 2) return [];

  const headers = parseCSVRow(rows[0]).map(h => h.trim());
  const idxType   = headers.indexOf("Item Type");
  const idxTitle  = headers.indexOf("Title");
  const idxAuthor = headers.indexOf("Author");

  const items = [];

  for (let i = 1; i < rows.length; i++) {
    if (!rows[i].trim()) continue;
    const cols = parseCSVRow(rows[i]);

    const itemType = (cols[idxType]  || "").trim().toLowerCase();
    const title    = (cols[idxTitle] || "").trim();
    const authorRaw= (cols[idxAuthor]|| "").trim();

    if (!title) continue;

    // Zotero CSV author format: "Last, First || Last2, First2"
    const creators = authorRaw
      .split("||")
      .map(a => a.trim())
      .filter(Boolean)
      .map(a => {
        const comma = a.indexOf(",");
        if (comma === -1) return { firstName: "", lastName: a.trim() };
        return {
          firstName: a.slice(comma + 1).trim(),
          lastName:  a.slice(0, comma).trim(),
        };
      });

    items.push({ itemType, title, creators });
  }

  return items;
}

/**
 * Split CSV text into rows, respecting quoted fields that may contain newlines.
 */
function splitCSVRows(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // Check for escaped quote ""
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++; // CRLF
      rows.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) rows.push(current);
  return rows;
}

/**
 * Parse a single CSV row into an array of field strings.
 */
function parseCSVRow(row) {
  const fields = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}
