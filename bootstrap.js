/**
 * bootstrap.js
 *
 * Zotero 7 Bootstrap-style plugin entry point.
 *
 * Key Zotero 7 requirements:
 *  - chrome.manifest is NOT supported; chrome URLs must be registered
 *    via aomStartup.registerChrome() in startup()
 *  - startup() receives { id, version, rootURI } where rootURI is a string
 *  - Services, Cc, Ci, Cu are globals in the bootstrap context
 */

"use strict";

var chromeHandle = null;
var _menuItem    = null;

function install(data, reason) {}

async function startup({ id, version, rootURI }, reason) {
  // 1. Register chrome:// URL for our dialog
  // chrome.manifest is no longer supported in Zotero 7 — must use aomStartup
  const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);

  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "kindle-importer", "chrome/content/"],
  ]);

  // 2. Wait for Zotero UI to be fully ready
  await Zotero.uiReadyPromise;

  // 3. Load source modules into a shared sandbox object
  // Using a plain object as the scope so vars defined in each file
  // are accessible as properties after loading.
  var scope = { Zotero };
  Services.scriptloader.loadSubScript(rootURI + "src/parser.js",     scope);
  Services.scriptloader.loadSubScript(rootURI + "src/matcher.js",    scope);
  Services.scriptloader.loadSubScript(rootURI + "src/bookLookup.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "src/importer.js",   scope);

  // 4. Expose modules on Zotero global for dialog.js to access
  Zotero.KindleImporter = {
    Parser:     scope.KindleParser,
    Matcher:    scope.KindleMatcher,
    BookLookup: scope.KindleBookLookup,
    Importer:   scope.KindleImporter,
    openDialog,
  };

  // 5. Add Tools menu item
  _menuItem = addMenuItem();
}

function shutdown(data, reason) {
  if (_menuItem && _menuItem.parentNode) {
    _menuItem.parentNode.removeChild(_menuItem);
    _menuItem = null;
  }
  if (Zotero.KindleImporter) {
    delete Zotero.KindleImporter;
  }
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}

function addMenuItem() {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  if (!win) return null;

  const doc       = win.document;
  const toolsMenu = doc.getElementById("menu_ToolsPopup");
  if (!toolsMenu) return null;

  const item = doc.createXULElement("menuitem");
  item.id    = "kindle-importer-menuitem";
  item.setAttribute("label",     "Import Kindle Highlights\u2026");
  item.setAttribute("oncommand", "Zotero.KindleImporter.openDialog()");

  const sep = toolsMenu.querySelector("menuseparator:last-of-type");
  toolsMenu.insertBefore(item, sep || null);
  return item;
}

function openDialog() {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  win.openDialog(
    "chrome://kindle-importer/content/dialog.xhtml",
    "kindle-importer-dialog",
    "chrome,dialog,centerscreen,resizable=yes,width=740,height=680"
  );
}
