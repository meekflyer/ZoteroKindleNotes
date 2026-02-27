/**
 * bookLookup.test.js
 *
 * Run with: node bookLookup.test.js
 * Run live API test: node bookLookup.test.js --live
 */

"use strict";

const { lookupBook, lookupAllUnmatched, summarizeLookupResults } = require("./src/bookLookup.js");

const LIVE_MODE = process.argv.includes("--live");

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

// ─── Mock Fetch Helpers ───────────────────────────────────────────────────────

/** Wraps a JS object as a fake fetch response */
function mockResponse(data, ok = true) {
  return { ok, json: async () => data };
}

/** Returns a fetch function that serves pre-canned responses in order */
function mockFetchSequence(...responses) {
  let i = 0;
  return async (url) => {
    const resp = responses[i] || responses[responses.length - 1];
    i++;
    return resp;
  };
}

// ─── Sample API Response Fixtures ────────────────────────────────────────────

const GOOGLE_THINKING_FAST = {
  items: [{
    volumeInfo: {
      title: "Thinking, Fast and Slow",
      authors: ["Daniel Kahneman"],
      publisher: "Farrar, Straus and Giroux",
      publishedDate: "2011-10-25",
      pageCount: 499,
      language: "en",
      industryIdentifiers: [
        { type: "ISBN_13", identifier: "9780374275631" },
        { type: "ISBN_10", identifier: "0374275637" },
      ],
    },
  }],
};

const GOOGLE_NO_RESULTS = { items: [] };

const OPEN_LIBRARY_LEAN_STARTUP = {
  docs: [{
    title: "The Lean Startup",
    author_name: ["Eric Ries"],
    publisher: ["Crown Business"],
    first_publish_year: 2011,
    isbn: ["9780307887894"],
    language: ["eng"],
    number_of_pages_median: 299,
  }],
};

const OPEN_LIBRARY_NO_RESULTS = { docs: [] };

// ─── Mock parsedBook helper ───────────────────────────────────────────────────

function parsedBook(title, authors = []) {
  return { title, rawTitle: title, authors, highlights: [], notes: [] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {

  await test("Google Books: returns metadata on good match", async () => {
    const fetch = mockFetchSequence(mockResponse(GOOGLE_THINKING_FAST));
    const result = await lookupBook(parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"]), fetch);
    assert(result.source === "google", `source is google (got ${result.source})`);
    assert(result.title === "Thinking, Fast and Slow", "title correct");
    assert(result.authors.includes("Daniel Kahneman"), "author correct");
    assert(result.isbn === "9780374275631", `ISBN-13 preferred (got ${result.isbn})`);
    assert(result.year === "2011", `year extracted (got ${result.year})`);
    assert(result.publisher === "Farrar, Straus and Giroux", "publisher correct");
    assert(result.numPages === 499, "page count correct");
    assert(result.confidence > 0.8, `confidence high (got ${result.confidence.toFixed(2)})`);
  });

  await test("Falls back to Open Library when Google returns nothing", async () => {
    const fetch = mockFetchSequence(
      mockResponse(GOOGLE_NO_RESULTS),   // Google title+author
      mockResponse(GOOGLE_NO_RESULTS),   // Google title only
      mockResponse(OPEN_LIBRARY_LEAN_STARTUP), // Open Library
    );
    const result = await lookupBook(parsedBook("The Lean Startup", ["Eric Ries"]), fetch);
    assert(result.source === "openlibrary", `source is openlibrary (got ${result.source})`);
    assert(result.title === "The Lean Startup", `title correct (got ${result.title})`);
    assert(result.authors.includes("Eric Ries"), "author correct");
    assert(result.year === "2011", `year correct (got ${result.year})`);
  });

  await test("Falls back to Kindle data when all APIs fail", async () => {
    const fetch = mockFetchSequence(
      mockResponse(GOOGLE_NO_RESULTS),
      mockResponse(GOOGLE_NO_RESULTS),
      mockResponse(OPEN_LIBRARY_NO_RESULTS),
    );
    const result = await lookupBook(parsedBook("Some Very Obscure Book", ["Unknown Author"]), fetch);
    assert(result.source === "kindle", `source is kindle (got ${result.source})`);
    assert(result.title === "Some Very Obscure Book", "title preserved from Kindle");
    assert(result.authors.includes("Unknown Author"), "author preserved from Kindle");
    assert(result.isbn === null, "no ISBN");
    assert(result.confidence === 0, "confidence is 0");
  });

  await test("Falls back to Kindle data on network error", async () => {
    const fetch = async () => { throw new Error("Network error"); };
    const result = await lookupBook(parsedBook("Any Book", ["Any Author"]), fetch);
    assert(result.source === "kindle", "gracefully falls back on network error");
  });

  await test("ISBN-13 preferred over ISBN-10", async () => {
    const fetch = mockFetchSequence(mockResponse(GOOGLE_THINKING_FAST));
    const result = await lookupBook(parsedBook("Thinking, Fast and Slow", []), fetch);
    assert(result.isbn === "9780374275631", `ISBN-13 preferred (got ${result.isbn})`);
  });

  await test("Skips low-confidence Google result and tries next source", async () => {
    // Google returns something totally different
    const badGoogleResult = {
      items: [{
        volumeInfo: {
          title: "Completely Unrelated Book About Dogs",
          authors: ["Someone Else"],
          publishedDate: "2020",
          industryIdentifiers: [],
        },
      }],
    };
    const fetch = mockFetchSequence(
      mockResponse(badGoogleResult),
      mockResponse(GOOGLE_NO_RESULTS),
      mockResponse(OPEN_LIBRARY_LEAN_STARTUP),
    );
    const result = await lookupBook(parsedBook("The Lean Startup", ["Eric Ries"]), fetch);
    // Should NOT use the bad Google result
    assert(result.title !== "Completely Unrelated Book About Dogs", "rejected bad match");
  });

  await test("lookupAllUnmatched processes multiple books", async () => {
    const callCount = { n: 0 };
    const fetch = async () => {
      callCount.n++;
      // Alternate: first book hits Google, second falls back
      if (callCount.n <= 2) return mockResponse(GOOGLE_THINKING_FAST);
      return mockResponse(GOOGLE_NO_RESULTS);
    };

    const unmatched = [
      { parsedBook: parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"]) },
      { parsedBook: parsedBook("Unknown Book", ["Nobody"]) },
    ];

    const results = await lookupAllUnmatched(unmatched, fetch, null);
    assert(results.length === 2, `2 results returned (got ${results.length})`);
    assert(results[0].metadata.source === "google", "first book from Google");
    assert(results[1].needsReview === true, "low-confidence book flagged for review");
  });

  await test("needsReview is false for high-confidence Google result", async () => {
    const fetch = mockFetchSequence(mockResponse(GOOGLE_THINKING_FAST));
    const unmatched = [{ parsedBook: parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"]) }];
    const results = await lookupAllUnmatched(unmatched, fetch, null);
    assert(results[0].needsReview === false, `needsReview false for confident match (got ${results[0].needsReview})`);
  });

  await test("summarizeLookupResults output is well-formed", async () => {
    const mockResults = [
      { parsedBook: parsedBook("Book A", []), metadata: { source: "google",      confidence: 0.95 }, needsReview: false },
      { parsedBook: parsedBook("Book B", []), metadata: { source: "openlibrary", confidence: 0.80 }, needsReview: false },
      { parsedBook: parsedBook("Book C", []), metadata: { source: "kindle",      confidence: 0    }, needsReview: true  },
    ];
    const summary = summarizeLookupResults(mockResults);
    assert(typeof summary === "string" && summary.length > 0, "summary is non-empty");
    assert(summary.includes("Google Books:"), "mentions Google Books count");
    assert(summary.includes("Open Library:"), "mentions Open Library count");
    console.log("\n" + summary.split("\n").map(l => "    " + l).join("\n"));
  });

  // ── Optional live API test ───────────────────────────────────────────────────

  if (LIVE_MODE) {
    console.log("\n🌐 LIVE API TESTS (--live flag detected)");
    console.log("   These hit real network endpoints — results depend on API availability.\n");

    await test("[LIVE] Google Books: Thinking Fast and Slow", async () => {
      const result = await lookupBook(parsedBook("Thinking, Fast and Slow", ["Daniel Kahneman"]));
      assert(result.source !== "kindle", `got a real result (source: ${result.source})`);
      assert(result.title.toLowerCase().includes("thinking"), `title looks right: ${result.title}`);
      assert(result.isbn !== null, `has ISBN: ${result.isbn}`);
      console.log(`    📖 ${result.title} | ${result.year} | ${result.publisher} | ISBN: ${result.isbn}`);
    });

    await test("[LIVE] Open Library fallback for obscure title", async () => {
      // Use a real but less well-known book that Google might not return confidently
      const result = await lookupBook(parsedBook("Cybersecurity and Cyberwar", ["P.W. Singer"]));
      assert(result.source !== "kindle", `found in an API (source: ${result.source})`);
      console.log(`    📖 ${result.title} | ${result.year} | ISBN: ${result.isbn}`);
    });
  }

  // ─── Final results ──────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
