/*
 * Looking after the meaning index and the related notes: clear it, rebuild one folder, see how big it is, and copy the notes related to this one as links.
 */

import { Notice, TFile } from "obsidian";
import { hybridRelated } from "../keywords";
import { fs } from "../node";

// Is a note in a folder (or below it)? An empty folder means the whole vault.
function inFolder(notePath, folder) {
  const f = String(folder || "").replace(/^\/+|\/+$/g, "");
  return !f || notePath.startsWith(`${f}/`);
}

function formatStats({ size, waiting, dim, bytes }) {
  const mb = bytes ? `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB on disk` : "not saved yet";
  const lines = [`${size.toLocaleString()} ${size === 1 ? "note" : "notes"} understood`];
  if (waiting) lines.push(`${waiting.toLocaleString()} waiting to be read`);
  lines.push(dim ? `${dim} numbers per note` : "no vectors yet", mb);
  return lines.join(" · ");
}

function linkList(links) {
  return links.map((l) => `- ${l}`).join("\n");
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

  plugin.addCommand({
    id: "index-stats",
    name: "Show meaning index stats",
    icon: "info",
    callback: async () => {
      const ix = plugin.index;
      let bytes = 0;
      try {
        bytes = (await fs.promises.stat(`${ix.cacheBase}.bin`)).size;
      } catch {
        // not saved yet
      }
      new Notice(formatStats({ size: ix.size, waiting: ix.queue.length, dim: ix.dim, bytes }), 8000);
    },
  });

  plugin.addCommand({
    id: "copy-related",
    name: "Copy related notes as links",
    icon: "copy",
    checkCallback: (checking) => {
      const file = app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;
      if (!checking) {
        (async () => {
          if (!plugin.index.ready) return new Notice("Still reading your notes…");
          const near = await hybridRelated(plugin, file, { k: plugin.settings.relatedCount || 12 });
          const links = near.map((n) => app.vault.getAbstractFileByPath(n.path)).filter((f) => f instanceof TFile).map((f) => app.fileManager.generateMarkdownLink(f, file.path));
          if (!links.length) return new Notice("Nothing closely related yet");
          await navigator.clipboard.writeText(linkList(links));
          new Notice(`Copied ${links.length} ${links.length === 1 ? "link" : "links"}`);
        })();
      }
      return true;
    },
  });
}

export { register, inFolder, formatStats, linkList };
