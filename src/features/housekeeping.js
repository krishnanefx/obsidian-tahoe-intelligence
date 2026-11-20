/*
 * Looking after the meaning index and the related notes: clear it and rebuild one folder.
 */

import { Notice } from "obsidian";

// Is a note in a folder (or below it)? An empty folder means the whole vault.
function inFolder(notePath, folder) {
  const f = String(folder || "").replace(/^\/+|\/+$/g, "");
  return !f || notePath.startsWith(`${f}/`);
}

function register(plugin) {
  const app = plugin.app;

  plugin.addCommand({
    id: "index-clear",
    name: "Clear the meaning index",
    icon: "eraser",
    callback: async () => {
      const ix = plugin.index;
      const n = ix.size;
      ix.clear();
      await ix.removeCache();
      new Notice(`Forgot ${n.toLocaleString()} ${n === 1 ? "note" : "notes"}. Notes are read again as they change, or use Rebuild in settings.`);
    },
  });

  plugin.addCommand({
    id: "index-rebuild-folder",
    name: "Rebuild the meaning index for this folder",
    icon: "folder-sync",
    checkCallback: (checking) => {
      const file = app.workspace.getActiveFile();
      if (!file) return false;
      if (!checking) {
        const folder = file.parent && !file.parent.isRoot() ? file.parent.path : "";
        const n = plugin.index.rebuildFolder(folder);
        new Notice(`Reading ${n.toLocaleString()} ${n === 1 ? "note" : "notes"} in ${folder || "the vault"} again…`);
      }
      return true;
    },
  });
}

export { register, inFolder };
