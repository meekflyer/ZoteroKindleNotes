# Kindle Highlights → Zotero Importer

A Zotero 7 plugin that imports your Kindle highlights and notes from `My Clippings.txt` directly into your Zotero library — matching them to existing items and creating new ones as needed.

![Zotero 7](https://img.shields.io/badge/Zotero-7.x-red) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- Parses `My Clippings.txt` from any Kindle device
- Fuzzy-matches Kindle books against your existing Zotero library by title and author
- Wizard UI with 5 steps: Load → Preview → Review → Import → Done
- Handles subtitle variations (e.g. "Four Thousand Weeks" matches "Four thousand weeks: Time Management for Mortals")
- Lets you manually resolve uncertain matches or mark books as new
- "Mark all as new books" bulk action for quick processing
- Adds highlights and notes as child note items in Zotero
- Looks up new books via Google Books and Open Library APIs to create proper Zotero entries

---

## Requirements

- **Zotero 7.0+** (not compatible with Zotero 6)
- macOS, Windows, or Linux

---

## Installation

1. Download the latest `kindle-importer.xpi` from the [Releases](../../releases) page
2. In Zotero, go to **Tools → Add-ons**
3. Click the gear icon → **Install Add-on From File...**
4. Select the downloaded `.xpi` file
5. Restart Zotero when prompted

---

## Usage

1. Connect your Kindle and locate `My Clippings.txt` (usually in the `documents/` folder on the Kindle drive)
2. In Zotero, go to **Tools → Import Kindle Highlights**
3. Follow the 5-step wizard:
   - **Load File** — select your `My Clippings.txt`
   - **Preview** — review how your books matched against your Zotero library
   - **Review** — resolve uncertain matches, or mark books as new
   - **Import** — highlights are added as notes to each book
   - **Done** — summary of what was imported

---

## How It Works

### Parsing
`src/parser.js` reads `My Clippings.txt` and groups highlights and notes by book. It handles the quirky Kindle format — entries separated by `==========`, with metadata lines like `- Your Highlight on page 12 | location 150-155 | Added on Monday, January 1, 2024`.

### Matching
`src/matcher.js` compares each Kindle book title and author against every item in your Zotero library using a combination of:
- **Dice coefficient** on word tokens (case-insensitive, stop words removed)
- **Containment score** to handle subtitle mismatches
- **Author verification** — when both sides have author data, it must agree

Short titles (3 words or fewer) require a stricter threshold since they're more likely to false-match.

### Book Lookup
`src/bookLookup.js` fetches metadata for books not in your Zotero library so they can be created as proper Zotero items with ISBN, publisher, etc. It tries three sources in order: [Google Books API](https://developers.google.com/books) (title + author), Google Books (title only), then [Open Library API](https://openlibrary.org/developers/api) as a fallback. If all three fail, it creates a minimal record from whatever Kindle data is available.

### Importing
`src/importer.js` creates Zotero note items as children of each matched book, formatted with the highlight text, location, and date.

---

## Development

No build step required. The plugin is a plain XPI (zip file) of the source files.

```
kindle-zotero-plugin/
├── manifest.json          # WebExtension-style plugin metadata
├── bootstrap.js           # Zotero 7 lifecycle hooks (startup/shutdown)
├── chrome/
│   └── content/
│       ├── dialog.xhtml   # Plugin UI (5-screen wizard)
│       └── dialog.js      # UI logic
├── src/
│   ├── parser.js          # My Clippings.txt parser
│   ├── matcher.js         # Fuzzy book matching against Zotero library
│   ├── bookLookup.js      # Google Books + Open Library API integration
│   └── importer.js        # Zotero note creation
├── *.test.js              # Node.js test files (run with: node matcher.test.js)
└── kindle-importer.xpi    # Built plugin (zip of the above)
```

To build the XPI yourself:
```bash
zip -r kindle-importer.xpi manifest.json bootstrap.js src/ chrome/ --exclude "*.test.js"
```

To run the tests (requires Node.js):
```bash
node matcher.test.js
node parser.test.js
```

---

## Built With Claude

This plugin was built entirely through a conversation with **Claude Sonnet 4.6** (Anthropic) using the [Claude in Chrome](https://claude.ai) browser extension, which gave Claude the ability to read screenshots of Zotero as the plugin was being debugged in real time.

The development process was iterative and conversational — describing what was broken, sharing screenshots, and letting Claude write, debug, and refine the code across many turns. No separate IDE or build environment was used; Claude wrote directly to files in a container and packaged each iteration as an installable `.xpi`.

Notable challenges solved along the way:
- Zotero 7's breaking changes from v6 (no `chrome.manifest`, new `aomStartup` API)
- XUL dialog context scoping (`Zotero` global not available in child windows)
- XUL's non-standard flex/scroll behavior requiring fixed pixel heights
- Native radio inputs scoping globally in XUL, requiring custom selection logic
- Dark mode compatibility (Zotero's UI is dark; the plugin was initially designed with hardcoded light colors)
- Fuzzy title matching — bigrams hurt more than they helped; plain word tokens with a containment score worked better

---

## Known Limitations

- Very short book titles (1–2 words) may still occasionally false-match; use the Review screen to correct these
- Book metadata fetched from external APIs occasionally returns incomplete data (missing ISBN, publisher, etc.) — the import will still succeed with whatever fields are available

---

## License

MIT — do whatever you like with it.

---

## Contributing

Issues and PRs welcome. This is a first release and there's plenty of room to improve the matching logic, add duplicate detection, and support other highlight export formats.
