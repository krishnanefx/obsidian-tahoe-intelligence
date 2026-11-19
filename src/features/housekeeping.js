/*
 * Looking after the meaning index and the related notes: clear it.
 */

import { Notice } from "obsidian";

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
}

export { register };
