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

    // Run the matcher against the live Zotero library
    const { Matcher } = Zotero.KindleImporter;
    this._matchResult = Matcher.matchBooksToZotero(this._parsedBooks);

    const { matched, ambiguous, unmatched } = this._matchResult;
    const total = matched.length + ambiguous.length + unmatched.length;

    document.getElementById("match-count").textContent = matched.length;
    document.getElementById("ambig-count").textContent = ambiguous.length;
    document.getElementById("new-count").textContent   = unmatched.length;
    document.getElementById("total-count").textContent = total;

    // Update next button label based on whether review is needed
    const btn = document.getElementById("btn-next-2");
    if (ambiguous.length > 0) {
      btn.textContent = `Review ${ambiguous.length} Uncertain Match${ambiguous.length !== 1 ? "es" : ""} →`;
    } else {
      btn.textContent = "Start Import →";
    }

    this._renderPreviewList(matched, ambiguous, unmatched);
  },

  _renderPreviewList(matched, ambiguous, unmatched) {
    const list = document.getElementById("preview-list");
    list.innerHTML = "";

    const addSection = (label, items, badgeClass, badgeText) => {
      if (items.length === 0) return;

      const header = document.createElement("div");
      header.className = "section-label";
      header.style.cssText = "padding: 6px 10px; background: #f9f9f9; border-bottom: 1px solid #eee; margin: 0;";
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
      const groupName = `ambig-${i}`;

      const card = document.createElement("div");
      card.className = "ambig-card";

      const authorStr = parsedBook.authors.join(", ") || "unknown author";
      const hlCount   = parsedBook.highlights.length + parsedBook.notes.length;

      card.innerHTML = `
        <div class="ambig-kindle">
          ${this._esc(parsedBook.title)}
          <span>${this._esc(authorStr)} · ${hlCount} clips</span>
        </div>
        <div class="ambig-options" id="options-${i}"></div>
        <span class="ambig-add-new" onclick="KindleDialog._selectAddNew(${i})">
          + Add as new book instead
        </span>
      `;

      list.appendChild(card);

      // Add radio options for each candidate
      const optionsEl = document.getElementById(`options-${i}`);
      candidates.forEach((candidate, j) => {
        const zTitle = typeof candidate.zoteroItem.getField === "function"
          ? candidate.zoteroItem.getField("title")
          : candidate.zoteroItem.title;
        const pct = Math.round(candidate.titleScore * 100);

        const opt = document.createElement("label");
        opt.className = "ambig-option";
        opt.innerHTML = `
          <input type="radio" name="${groupName}" value="${j}" ${j === 0 ? "checked" : ""}
                 onchange="KindleDialog._onAmbigChoice(${i}, ${j})"/>
          <span class="ambig-option-title">${this._esc(zTitle)}</span>
          <span class="ambig-option-score">${pct}% match</span>
        `;
        optionsEl.appendChild(opt);
      });

      // Default to first candidate
      this._confirmed[i] = { type: "match", index: 0 };
    }
  },

  _onAmbigChoice(bookIndex, candidateIndex) {
    this._confirmed[bookIndex] = { type: "match", index: candidateIndex };
  },

  _selectAddNew(bookIndex) {
    this._confirmed[bookIndex] = { type: "new" };
    // Uncheck all radios for this group
    document.querySelectorAll(`input[name="ambig-${bookIndex}"]`)
      .forEach(r => r.checked = false);
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
