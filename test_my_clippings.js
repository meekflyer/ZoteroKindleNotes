const { parseClippings, summarizeParseResult } = require("./src/parser.js");
const fs = require("fs");

const content = fs.readFileSync("./My Clippings.txt", "utf8");
const result = parseClippings(content);

console.log(summarizeParseResult(result));
console.log("\n--- First book sample ---");
const [key, book] = [...result.books.entries()][0];
console.log("Title:", book.title);
console.log("Authors:", book.authors);
console.log("First highlight:", book.highlights[0]?.text?.slice(0, 100));

// Print all book titles and author counts
for (const [key, book] of result.books.entries()) {
  console.log(`${book.title} — ${book.authors.join(", ") || "(no author)"} — ${book.highlights.length} highlights`);
}