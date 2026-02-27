/**
 * bootstrap.js
 *
 * Zotero 7 Bootstrap-style plugin entry point.
 * Registers a "Import Kindle Highlights…" item under Zotero's Tools menu.
 *
 * Lifecycle hooks called by Zotero:
 *   install()   — called once when plugin is first installed
 *   startup()   — called each time Zotero starts with the plugin enabled
 *   shutdown()  — called when Zotero closes or plugin is disabled
 *   uninstall() — called when plugin is removed
 */

"use strict";

// Keep a reference to the menu item so we can remove it on shutdown
var _menuItem = null;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function install(data, reason) {
  // Nothing needed on first install
}

async function startup(data, reason) {
  // Wait for Zotero UI to be ready before touching the menu
  await Zotero.uiReadyPromise;

  // Load our source modules into the plugin's scope
  Services.scriptloader.loadSubScript(
    data.resourceURI.spec + "src/parser.js",   this
  );
  Services.scriptloader.loadSubScript(
    data.resourceURI.spec + "src/matcher.js",  this
  );
  Services.scriptloader.loadSubScript(
    data.resourceURI.spec + "src/bookLookup.js", this
  );
  Services.scriptloader.loadSubScript(
    data.resourceURI.spec + "src/importer.js", this
  );

  // Expose modules on a single global so dialog.js can reach them
  Zotero.KindleImporter = {
    Parser:     KindleParser,
    Matcher:    KindleMatcher,
    BookLookup: KindleBookLookup,
    Importer:   KindleImporter,
  };

  // Add "Import Kindle Highlights…" to the Tools menu
  _menuItem = addMenuItem();
}

function shutdown(data, reason) {
  // Remove the menu item we added
  if (_menuItem && _menuItem.parentNode) {
    _menuItem.parentNode.removeChild(_menuItem);
    _menuItem = null;
  }

  // Clean up our global
  if (Zotero.KindleImporter) {
    delete Zotero.KindleImporter;
  }
}

function uninstall(data, reason) {
  // Nothing extra needed beyond shutdown
}

// ─── Menu Registration ────────────────────────────────────────────────────────

function addMenuItem() {
  // Get the main Zotero window
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  if (!win) return null;

  const doc      = win.document;
  const toolsMenu = doc.getElementById("menu_ToolsPopup");
  if (!toolsMenu) return null;

  const menuItem = doc.createXULElement("menuitem");
  menuItem.id    = "kindle-importer-menuitem";
  menuItem.setAttribute("label", "Import Kindle Highlights…");
  menuItem.setAttribute("oncommand", "Zotero.KindleImporter.openDialog()");

  // Insert before the separator at the bottom of the Tools menu
  const sep = toolsMenu.querySelector("menuseparator:last-of-type");
  toolsMenu.insertBefore(menuItem, sep || null);

  return menuItem;
}

// ─── Dialog Opener ────────────────────────────────────────────────────────────

// This gets attached to Zotero.KindleImporter so the menu oncommand can call it
if (typeof Zotero !== "undefined" && Zotero.KindleImporter) {
  Zotero.KindleImporter.openDialog = openDialog;
}

function openDialog() {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  win.openDialog(
    "chrome://kindle-importer/content/dialog.xhtml",
    "kindle-importer-dialog",
    "chrome,dialog,centerscreen,resizable=yes,width=700,height=580",
  );
}
