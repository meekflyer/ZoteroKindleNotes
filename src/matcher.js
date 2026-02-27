/**
 * matcher.js
 *
 * Takes the parsed book map from parser.js and attempts to match each book
 * against items already in the user's Zotero library.
 *
 * Returns three buckets:
 *   matched   — confident 1:1 match found, safe to auto-pair
 *   ambiguous — multiple plausible matches, user must choose in UI
 *   unmatched — no match found, book needs to be added to Zotero
 *
 * Designed to run inside Zotero (uses Zotero global) but accepts an optional
 * zoteroLib injection for testing outside Zotero.
 */

"use strict";

// ─── Thresholds ───────────────────────────────────────────────────────────────

// Title similarity score (0–1) above which a match is considered confident.
const CONFIDENT_TITLE_THRESHOLD = 0.85;

// Title similarity score above which a match is considered a candidate at all.
const CANDIDATE_TITLE_THRESHOLD = 0.60;

// When a title is confident AND author score clears this, it's a sure match.
const AUTHOR_BOOST_THRESHOLD = 0.50;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Match all parsed books against the Zotero library.
 *
 * @param {Map<string, Book>} parsedBooks  - Output from parseClippings()
 * @param {object} [zoteroLib]             - Optional: injected Zotero API for testing
 * @returns {MatchResult}
 *
 * MatchResult shape:
 * {
 *   matched:   Array<{ parsedBook, zoteroItem, titleScore, authorScore }>,
 *   ambiguous: Array<{ parsedBook, candidates: Array<{ zoteroItem, titleScore, authorScore }> }>,
 *   unmatched: Array<{ parsedBook }>
 * }
 */
function matchBooksToZotero(parsedBooks, zoteroLib) {
  const zoteroItems = getZoteroBookItems(zoteroLib);

  // Pre-compute normalized fingerprints for every Zotero item once,
  // so we're not re-normalizing on every comparison.
  const zoteroFingerprints = zoteroItems.map((item) => ({
    item,
    titleTokens: tokenize(getZoteroTitle(item)),
    authorTokens: tokenize(getZoteroAuthors(item).join(" ")),
  }));

  const matched = [];
  const ambiguous = [];
  const unmatched = [];

  for (const [, parsedBook] of parsedBooks) {
    const kindleTitleTokens = tokenize(parsedBook.title);
    const kindleAuthorTokens = tokenize(parsedBook.authors.join(" "));

    // Score every Zotero item against this Kindle book
    const scored = zoteroFingerprints
      .map(({ item, titleTokens, authorTokens }) => {
        const titleScore = titleSimilarity(kindleTitleTokens, titleTokens);
        const authorScore = kindleAuthorTokens.size === 0
          ? 0 // can't score authors if Kindle has none
          : diceCoefficient(kindleAuthorTokens, authorTokens);
        return { zoteroItem: item, titleScore, authorScore };
      })
      .filter((s) => s.titleScore >= CANDIDATE_TITLE_THRESHOLD)
      .sort((a, b) => {
        // Primary sort: title score. Secondary: author score as tiebreaker.
        const titleDiff = b.titleScore - a.titleScore;
        return titleDiff !== 0 ? titleDiff : b.authorScore - a.authorScore;
      });

    if (scored.length === 0) {
      unmatched.push({ parsedBook });
      continue;
    }

    const best = scored[0];

    // Confident match: high title score, and either we have no author data
    // to compare OR the author also matches reasonably well.
    const authorOk =
      kindleAuthorTokens.size === 0 || best.authorScore >= AUTHOR_BOOST_THRESHOLD;

    if (best.titleScore >= CONFIDENT_TITLE_THRESHOLD && authorOk) {
      matched.push({
        parsedBook,
        zoteroItem: best.zoteroItem,
        titleScore: best.titleScore,
        authorScore: best.authorScore,
      });
    } else if (scored.length === 1) {
      // Only one candidate but not confident enough — flag as ambiguous
      // so the user can confirm.
      ambiguous.push({ parsedBook, candidates: scored });
    } else {
      // Multiple candidates, none dominant enough — let user pick.
      ambiguous.push({ parsedBook, candidates: scored.slice(0, 5) });
    }
  }

  return { matched, ambiguous, unmatched };
}

/**
 * Human-readable summary of a match result for logging / UI display.
 *
 * @param {MatchResult} result
 * @returns {string}
 */
function summarizeMatchResult({ matched, ambiguous, unmatched }) {
  const lines = [
    `✅ Confident matches:  ${matched.length}`,
    `⚠️  Needs your review:  ${ambiguous.length}`,
    `➕ New books to add:   ${unmatched.length}`,
  ];

  if (matched.length > 0) {
    lines.push("\n── Matched books ──────────────────────────────");
    for (const { parsedBook, zoteroItem, titleScore } of matched) {
      const zTitle = getZoteroTitle(zoteroItem);
      const pct = Math.round(titleScore * 100);
      lines.push(`  "${parsedBook.title}"\n    → "${zTitle}" (${pct}% match)`);
    }
  }

  if (ambiguous.length > 0) {
    lines.push("\n── Needs review ────────────────────────────────");
    for (const { parsedBook, candidates } of ambiguous) {
      lines.push(`  "${parsedBook.title}"`);
      for (const { zoteroItem, titleScore } of candidates) {
        const pct = Math.round(titleScore * 100);
        lines.push(`    ? "${getZoteroTitle(zoteroItem)}" (${pct}%)`);
      }
    }
  }

  if (unmatched.length > 0) {
    lines.push("\n── New books ───────────────────────────────────");
    for (const { parsedBook } of unmatched) {
      lines.push(`  + "${parsedBook.title}" by ${parsedBook.authors.join(", ") || "(unknown author)"}`);
    }
  }

  return lines.join("\n");
}

// ─── Zotero API Helpers ───────────────────────────────────────────────────────

/**
 * Fetch all book-type items from the user's Zotero library.
 * When running inside Zotero, uses the global Zotero object.
 * When testing, accepts an injected mock.
 */
function getZoteroBookItems(zoteroLib) {
  // Running inside Zotero plugin
  if (typeof Zotero !== "undefined" && !zoteroLib) {
    const libraryID = Zotero.Libraries.userLibraryID;
    return Zotero.Items.getAll(libraryID, false, false, true).filter((item) => {
      // Only top-level items that are books or book sections
      return (
        item.isRegularItem() &&
        (item.itemType === "book" || item.itemType === "bookSection")
      );
    });
  }

  // Injected mock for testing
  if (zoteroLib) {
    return zoteroLib.getItems();
  }

  return [];
}

/**
 * Get the title string from a Zotero item.
 * Handles both real Zotero items and mock objects used in tests.
 */
function getZoteroTitle(item) {
  if (typeof item.getField === "function") {
    return item.getField("title") || "";
  }
  return item.title || "";
}

/**
 * Get a flat list of author name strings from a Zotero item.
 */
function getZoteroAuthors(item) {
  if (typeof item.getCreators === "function") {
    return item.getCreators()
      .filter((c) => c.creatorType === "author")
      .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" "));
  }
  // Mock format: item.creators = [{ firstName, lastName }]
  return (item.creators || []).map((c) =>
    [c.firstName, c.lastName].filter(Boolean).join(" ")
  );
}

// ─── String Similarity ────────────────────────────────────────────────────────

/**
 * Tokenize a string for comparison:
 *   - Lowercase
 *   - Remove punctuation
 *   - Remove common English articles and noise words that differ between
 *     Kindle/Zotero representations of the same title
 *   - Split into a Set of tokens (bigrams for better sensitivity)
 */
function tokenize(str) {
  if (!str) return new Set();

  const STOP_WORDS = new Set([
    "a", "an", "the", "of", "in", "on", "at", "to", "for", "and", "or",
    "with", "by", "from", "as", "is", "its", "it", "be", "was", "are",
  ]);

  const words = str
    .toLowerCase()
    .replace(/['']/g, "") // smart apostrophes
    .replace(/[^a-z0-9\s]/g, " ") // everything else → space
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  // Use character bigrams of each word for fuzziness (handles typos, plurals)
  const bigrams = new Set();
  for (const word of words) {
    bigrams.add(word); // whole word
    for (let i = 0; i < word.length - 1; i++) {
      bigrams.add(word.slice(i, i + 2)); // bigram
    }
  }

  return bigrams;
}

/**
 * Sørensen–Dice coefficient between two token sets.
 * Returns a value between 0 (no overlap) and 1 (identical).
 */
function diceCoefficient(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  return (2 * intersection) / (setA.size + setB.size);
}

/**
 * Title similarity score that handles the common case where a short Kindle
 * title (e.g. "Clean Code") matches a longer Zotero title that includes a
 * subtitle (e.g. "Clean Code: A Handbook of Agile Software Craftsmanship").
 *
 * Uses the max of:
 *   - Dice coefficient (symmetric, penalizes length difference)
 *   - Containment score (how much of the shorter title is in the longer one)
 *
 * The containment score is dampened slightly (×0.9) so a pure subset match
 * doesn't score as high as a near-identical match.
 */
function titleSimilarity(tokensA, tokensB) {
  const dice = diceCoefficient(tokensA, tokensB);

  // Containment: what fraction of the smaller set is in the larger set?
  const smaller = tokensA.size <= tokensB.size ? tokensA : tokensB;
  const larger  = tokensA.size <= tokensB.size ? tokensB : tokensA;

  let contained = 0;
  for (const token of smaller) {
    if (larger.has(token)) contained++;
  }
  const containment = smaller.size === 0 ? 0 : (contained / smaller.size) * 0.9;

  return Math.max(dice, containment);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

var KindleMatcher = {
  matchBooksToZotero,
  summarizeMatchResult,
  // Exported for testing
  _tokenize: tokenize,
  _diceCoefficient: diceCoefficient,
  _titleSimilarity: titleSimilarity,
  _getZoteroTitle: getZoteroTitle,
  _getZoteroAuthors: getZoteroAuthors,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = KindleMatcher;
}
