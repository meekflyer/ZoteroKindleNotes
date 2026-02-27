/**
 * dialog.js
 *
 * All logic for the Kindle Highlights Import wizard.
 * Runs in the context of dialog.xhtml inside Zotero.
 *
 * Accesses the four modules via the Zotero.KindleImporter global
 * that bootstrap.js sets up.
 */

"use strict";

// Zotero lives on the main window — grab it from the opener.
// Cc/Ci/Services are available as globals in chrome dialog contexts.
var Zotero = window.opener
  ? window.opener.Zotero
  : Services.wm.getMostRecentWindow("navigator:browser").Zotero;

var KindleDialog = {

  // ── State ──────────────────────────────────────────────────────────────────

  _filePath:      null,   // path to My Clippings.txt
  _parsedBooks:   null,   // Map from parseClippings()
  _matchResult:   null,   // { matched, ambiguous, unmatched } from matcher
  _lookupResults: null,   // Array from lookupAllUnmatched()
  _confirmed:     [],     // Ambiguous books the user resolved
  _cancelled:     false,  // Set true if user cancels mid-import

  // ── Init ───────────────────────────────────────────────────────────────────

  init() {
    // Nothing async needed on open — wait for user to pick a file
  },

  // ── Screen Navigation ──────────────────────────────────────────────────────

  goToScreen(screenId) {
    document.querySelectorAll(".wizard-screen").forEach(s => s.classList.remove("active"));
    document.getElementById(screenId).classList.add("active");
  },

  // ── Screen 1: File Selection ───────────────────────────────────────────────

  browseForFile() {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window, "Select My Clippings.txt", Ci.nsIFilePicker.modeOpen);
    fp.appendFilter("Text files (*.txt)", "*.txt");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);

    fp.open(rv => {
      if (rv !== Ci.nsIFilePicker.returnOK) return;

      this._filePath = fp.file.path;
      this._loadAndParseFile(fp.file);
    });
  },

  _loadAndParseFile(file) {
    const errorEl = document.getElementById("file-error");
    errorEl.style.display = "none";

    try {
      // Read the file using Mozilla IO
      const stream = Cc["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Ci.nsIFileInputStream);
      stream.init(file, -1, 0, 0);

      const conv = Cc["@mozilla.org/intl/converter-input-stream;1"]
        .createInstance(Ci.nsIConverterInputStream);
      conv.init(stream, "UTF-8", 8192, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

      let content = "";
      let str = {};
      while (conv.readString(8192, str) !== 0) {
        content += str.value;
      }
      conv.close();
      stream.close();

      // Parse it
      const { Parser } = Zotero.KindleImporter;
      const result = Parser.parseClippings(content);

      if (result.books.size === 0) {
        this._showFileError("No highlights found in this file. Make sure you selected 'My Clippings.txt'.");
        return;
      }

      this._parsedBooks = result.books;
      this._showParseSummary(result);

    } catch (err) {
      this._showFileError(`Could not read file: ${err.message}`);
    }
  },

  _showParseSummary({ books, skipped, errors }) {
    // Update display
    const displayEl = document.getElementById("file-path-display");
    displayEl.classList.remove("placeholder");
    displayEl.textContent = this._filePath;

    let totalHighlights = 0, totalNotes = 0;
    for (const book of books.values()) {
      totalHighlights += book.highlights.length;
      totalNotes      += book.notes.length;
    }

    document.getElementById("stat-books").textContent      = books.size;
    document.getElementById("stat-highlights").textContent = totalHighlights;
    document.getElementById("stat-notes").textContent      = totalNotes;
    document.getElementById("stat-skipped").textContent    = skipped;

    if (errors.length > 0) {
      const hint = document.getElementById("parse-errors-hint");
      hint.textContent = `⚠️ ${errors.length} entries could not be parsed and were skipped.`;
      hint.style.display = "block";
    }

    document.getElementById("parse-summary").style.display = "block";
    document.getElementById("btn-next-1").disabled = false;
  },

  _showFileError(msg) {
    const el = document.getElementById("file-error");
    el.textContent = msg;
    el.style.display = "block";
    document.getElementById("btn-next-1").disabled = true;
  },

  // ── Screen 2: Preview ──────────────────────────────────────────────────────

  async goToPreview() {
    this.goToScreen("screen-preview");

    try {
      // Fetch all regular (non-attachment, non-note) items — don't filter by
      // book type only, since some entries may be stored as "document" etc.
      const libraryID = Zotero.Libraries.userLibraryID;
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition("noChildren", "true", "");
      const allIDs   = await s.search();
      const allItems = await Zotero.Items.getAsync(allIDs);
      const bookItems = allItems.filter(item =>
        item.isRegularItem() && !item.isAttachment() && !item.isNote()
      );

      // Debug: show count in subtitle so we know items were found
      document.getElementById("screen-preview")
        .querySelector(".screen-subtitle")
        .textContent = `Matching ${this._parsedBooks.size} Kindle books against ${bookItems.length} Zotero books…`;

      const liveLibrary = { getItems: () => bookItems };

      // Diagnostic: show sample Zotero titles to confirm getField works
      const sample = bookItems.slice(0, 3).map(i => {
        try { return i.getField("title"); } catch(e) { return "(err:" + e.message + ")"; }
      }).join(" | ");
      document.getElementById("screen-preview")
        .querySelector(".screen-subtitle")
        .textContent = `Found ${bookItems.length} Zotero books. e.g. ${sample}`;

      const { Matcher } = Zotero.KindleImporter;
      this._matchResult = Matcher.matchBooksToZotero(this._parsedBooks, liveLibrary);

      const { matched, ambiguous, unmatched } = this._matchResult;
      const total = matched.length + ambiguous.length + unmatched.length;

      document.getElementById("match-count").textContent = matched.length;
      document.getElementById("ambig-count").textContent = ambiguous.length;
      document.getElementById("new-count").textContent   = unmatched.length;
      document.getElementById("total-count").textContent = total;

      // Update subtitle with real result
      document.getElementById("screen-preview")
        .querySelector(".screen-subtitle")
        .textContent = "Review how your Kindle books matched against your Zotero library.";

      const btn = document.getElementById("btn-next-2");
      if (ambiguous.length > 0) {
        btn.textContent = `Review ${ambiguous.length} Uncertain Match${ambiguous.length !== 1 ? "es" : ""} →`;
      } else {
        btn.textContent = "Start Import →";
      }

      this._renderPreviewList(matched, ambiguous, unmatched);

    } catch (err) {
      // Show the actual error so we can diagnose it
      document.getElementById("screen-preview")
        .querySelector(".screen-subtitle")
        .textContent = `Error: ${err.message} — ${err.stack || "no stack"}`;
    }
  },

  _renderPreviewList(matched, ambiguous, unmatched) {
    const list = document.getElementById("preview-list");
    list.innerHTML = "";

    const addSection = (label, items, badgeClass, badgeText) => {
      if (items.length === 0) return;

      const header = document.createElement("div");
      header.className = "section-label";
      header.style.cssText = "padding: 6px 10px; background: rgba(255,255,255,0.07); border-bottom: 1px solid rgba(255,255,255,0.1); margin: 0; font-weight: bold; font-size: 12px;";
      header.textContent = label;
      list.appendChild(header);

      for (const entry of items) {
        const book    = entry.parsedBook;
        const hlCount = book.highlights.length + book.notes.length;
        const author  = book.authors[0] || "";
        const matchTo = entry.zoteroItem
          ? (typeof entry.zoteroItem.getField === "function"
              ? entry.zoteroItem.getField("title")
              : entry.zoteroItem.title)
          : null;

        const row = document.createElement("div");
        row.className = "book-row";
        row.innerHTML = `
          <span class="book-title" title="${this._esc(book.title)}">${this._esc(book.title)}</span>
          <span class="book-author" title="${this._esc(author)}">${this._esc(author)}</span>
          <span class="book-count">${hlCount} clip${hlCount !== 1 ? "s" : ""}</span>
          <span class="book-badge ${badgeClass}">${badgeText}</span>
        `;

        // For matched items, show what it matched to on hover
        if (matchTo && matchTo !== book.title) {
          const pct = Math.round((entry.titleScore || 0) * 100);
          row.title = `Matches: "${matchTo}" (${pct}%)`;
        }

        list.appendChild(row);
      }
    };

    addSection(`✅ Matched to existing Zotero items (${matched.length})`,
      matched, "badge-green", "matched");

    addSection(`⚠️ Uncertain — needs your review (${ambiguous.length})`,
      ambiguous, "badge-yellow", "review needed");

    addSection(`➕ New — will be added to Zotero (${unmatched.length})`,
      unmatched, "badge-blue", "new book");
  },

  // ── Screen 3: Ambiguous Review ─────────────────────────────────────────────

  async goToReview() {
    const { ambiguous, unmatched } = this._matchResult;

    // If no ambiguous books, skip straight to import
    if (ambiguous.length === 0) {
      await this.startImport();
      return;
    }

    this.goToScreen("screen-review");

    const subtitle = document.getElementById("review-subtitle");
    subtitle.textContent =
      `${ambiguous.length} Kindle book${ambiguous.length !== 1 ? "s" : ""} had uncertain matches. ` +
      `Choose the correct Zotero entry or add as a new book.`;

    this._renderAmbigList(ambiguous);
  },

  _renderAmbigList(ambiguous) {
    const list = document.getElementById("ambig-list");
    list.innerHTML = "";

    for (let i = 0; i < ambiguous.length; i++) {
      const { parsedBook, candidates } = ambiguous[i];

      const card = document.createElement("div");
      card.className = "ambig-card";
      card.dataset.index = i;

      // Title row
      const titleEl = document.createElement("div");
      titleEl.className = "ambig-kindle";
      titleEl.textContent = parsedBook.title;
      const metaSpan = document.createElement("span");
      metaSpan.textContent = `${parsedBook.authors.join(", ") || "unknown"} · ${parsedBook.highlights.length + parsedBook.notes.length} clips`;
      titleEl.appendChild(metaSpan);
      card.appendChild(titleEl);

      // Candidate options — custom single-select (not native radio, XUL scopes them globally)
      const optionsEl = document.createElement("div");
      optionsEl.className = "ambig-options";
      card.appendChild(optionsEl);

      candidates.forEach((candidate, j) => {
        const zTitle = typeof candidate.zoteroItem.getField === "function"
          ? candidate.zoteroItem.getField("title")
          : candidate.zoteroItem.title;
        const pct = Math.round(candidate.titleScore * 100);

        const opt = document.createElement("div");
        opt.className  = "ambig-option";
        opt.dataset.j  = j;
        opt.style.cursor = "pointer";
        if (j === 0) opt.classList.add("ambig-option-selected");

        const dot = document.createElement("span");
        dot.className = "ambig-dot";
        dot.textContent = j === 0 ? "●" : "○";
        dot.style.cssText = "font-size:14px; width:16px; flex-shrink:0; color:" + (j === 0 ? "#5b9dd9" : "#666");

        const titleSpan = document.createElement("span");
        titleSpan.className   = "ambig-option-title";
        titleSpan.textContent = zTitle;

        const scoreSpan = document.createElement("span");
        scoreSpan.className   = "ambig-option-score";
        scoreSpan.textContent = `${pct}%\nmatch`;
        scoreSpan.style.whiteSpace = "pre";

        opt.appendChild(dot);
        opt.appendChild(titleSpan);
        opt.appendChild(scoreSpan);

        opt.addEventListener("click", () => {
          // Deselect all options in this card
          optionsEl.querySelectorAll(".ambig-option").forEach(o => {
            o.classList.remove("ambig-option-selected");
            o.querySelector(".ambig-dot").textContent = "○";
            o.querySelector(".ambig-dot").style.color = "#666";
          });
          // Select this one
          opt.classList.add("ambig-option-selected");
          dot.textContent = "●";
          dot.style.color = "#5b9dd9";
          // Reset add-as-new link
          const link = card.querySelector(".ambig-add-new");
          if (link) { link.textContent = "+ Add as new book instead"; link.style.color = ""; }
          this._confirmed[i] = { type: "match", index: j };
        });

        optionsEl.appendChild(opt);
      });

      // "Add as new book" link
      const addNew = document.createElement("span");
      addNew.className   = "ambig-add-new";
      addNew.textContent = "+ Add as new book instead";
      addNew.addEventListener("click", () => {
        optionsEl.querySelectorAll(".ambig-option").forEach(o => {
          o.classList.remove("ambig-option-selected");
          o.querySelector(".ambig-dot").textContent = "○";
          o.querySelector(".ambig-dot").style.color = "#666";
        });
        addNew.textContent = "✓ Will be added as new book";
        addNew.style.color = "#81c784";
        this._confirmed[i] = { type: "new" };
      });
      card.appendChild(addNew);

      // Default
      this._confirmed[i] = candidates.length > 0 ? { type: "match", index: 0 } : { type: "new" };

      list.appendChild(card);
    }
  },

  /** Mark every uncertain book as "add as new" in one click */
  addAllAsNew() {
    const { ambiguous } = this._matchResult;
    for (let i = 0; i < ambiguous.length; i++) {
      this._confirmed[i] = { type: "new" };
    }
    // Update every card: deselect all option dots, mark link as confirmed
    document.querySelectorAll(".ambig-card").forEach(card => {
      card.querySelectorAll(".ambig-option").forEach(opt => {
        opt.classList.remove("ambig-option-selected");
        const dot = opt.querySelector(".ambig-dot");
        if (dot) { dot.textContent = "○"; dot.style.color = "#666"; }
      });
      const link = card.querySelector(".ambig-add-new");
      if (link) { link.textContent = "✓ Will be added as new book"; link.style.color = "#81c784"; }
    });
    const btn = document.getElementById("btn-add-all-new");
    if (btn) { btn.textContent = "✓ All marked as new books"; btn.disabled = true; }
  },


  // ── Screen 4: Import ───────────────────────────────────────────────────────

  async startImport() {
    this._cancelled = false;
    this.goToScreen("screen-progress");

    const { matched, ambiguous, unmatched } = this._matchResult;
    const { BookLookup, Importer } = Zotero.KindleImporter;

    // ── Phase 1: Book lookup for unmatched ──────────────────────────────────
    const totalPhase1 = unmatched.length;

    if (totalPhase1 > 0) {
      document.getElementById("progress-subtitle").textContent =
        `Looking up metadata for ${totalPhase1} new book${totalPhase1 !== 1 ? "s" : ""}…`;

      this._lookupResults = await BookLookup.lookupAllUnmatched(
        unmatched,
        null, // use real fetch
        (done, total, title) => {
          if (this._cancelled) return;
          this._setProgress(done, total * 2, `Looking up: ${title}`);
          this._logLine(`🔍 Found metadata: ${title}`);
        }
      );
    } else {
      this._lookupResults = [];
    }

    if (this._cancelled) return;

    // ── Phase 2: Build confirmed list from ambiguous resolutions ────────────
    const confirmedBooks = [];
    for (let i = 0; i < ambiguous.length; i++) {
      const decision = this._confirmed[i] || { type: "match", index: 0 };
      if (decision.type === "match") {
        const candidate = ambiguous[i].candidates[decision.index];
        confirmedBooks.push({
          parsedBook:  ambiguous[i].parsedBook,
          zoteroItem:  candidate.zoteroItem,
          titleScore:  candidate.titleScore,
          authorScore: candidate.authorScore,
        });
      } else {
        // User chose "add as new" — look up metadata for it
        this._logLine(`➕ Adding as new: ${ambiguous[i].parsedBook.title}`);
        const meta = await BookLookup.lookupBook(ambiguous[i].parsedBook);
        this._lookupResults.push({ parsedBook: ambiguous[i].parsedBook, metadata: meta });
      }
    }

    if (this._cancelled) return;

    // ── Phase 3: Run the importer ───────────────────────────────────────────
    document.getElementById("progress-subtitle").textContent = "Writing highlights to Zotero…";

    const totalPhase2 = matched.length + confirmedBooks.length + this._lookupResults.length;
    let importDone = 0;

    const report = await Importer.importAll(
      {
        matched:       matched,
        confirmed:     confirmedBooks,
        lookupResults: this._lookupResults,
      },
      null, // use real Zotero API
      (done, total, title) => {
        if (this._cancelled) return;
        importDone = done;
        const overallDone  = totalPhase1 + done;
        const overallTotal = totalPhase1 + total;
        this._setProgress(overallDone, overallTotal, `Importing: ${title}`);
        this._logLine(`✅ Added note: ${title}`);
      }
    );

    if (this._cancelled) return;

    // ── Done ────────────────────────────────────────────────────────────────
    this._showDone(report);
  },

  _setProgress(done, total, label) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById("progress-bar").style.width  = `${pct}%`;
    document.getElementById("progress-label").textContent = `${label} (${done}/${total})`;
  },

  _logLine(text) {
    const log = document.getElementById("progress-log");
    const line = document.createElement("div");
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  },

  // ── Screen 5: Done ─────────────────────────────────────────────────────────

  _showDone(report) {
    this.goToScreen("screen-done");

    const reportEl = document.getElementById("done-report");
    reportEl.innerHTML = `
      <p>📝 <span class="num">${report.notesAdded}</span> highlight note${report.notesAdded !== 1 ? "s" : ""} added to Zotero</p>
      <p>📗 <span class="num">${report.booksCreated}</span> new book${report.booksCreated !== 1 ? "s" : ""} created in <em>Kindle Imports</em></p>
      <p>⏭  <span class="num">${report.skipped}</span> book${report.skipped !== 1 ? "s" : ""} skipped — already had Kindle notes</p>
    `;

    if (report.failed.length > 0) {
      document.getElementById("done-failures").style.display = "block";
      const failList = document.getElementById("done-failures-list");
      for (const { title, reason } of report.failed) {
        const row = document.createElement("div");
        row.className = "book-row";
        row.innerHTML = `
          <span class="book-title">${this._esc(title)}</span>
          <span style="font-size:11px;color:#c62828;">${this._esc(reason)}</span>
        `;
        failList.appendChild(row);
      }
    }
  },

  // ── Utilities ──────────────────────────────────────────────────────────────

  onCancel() {
    this._cancelled = true;
    window.close();
  },

  close() {
    window.close();
  },

  /** Escape a string for safe insertion into innerHTML */
  _esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },
};
