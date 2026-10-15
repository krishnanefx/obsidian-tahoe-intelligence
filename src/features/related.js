/*
 * Related notes: a sidebar of the notes closest in meaning to the one you're
 * reading, always up to date. Rows use the file explorer's own markup, so the
 * theme gives them the same icons, tag dots and selection. Each shows a line
 * of the note; "Link" adds a [[link]] at the cursor, and you can drag a row
 * into the note.
 */

import { ItemView, MarkdownView, TFile, Keymap, setIcon, debounce } from "obsidian";
import { noteText } from "../vault";
import { aiIcon } from "../ui";
import { hybridRelated } from "../keywords";

const VIEW_RELATED = "tahoe-related";
const SHOW = 12;

class RelatedView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.refresh = debounce(() => this.render(), 350, true);
    this.previews = new Map(); // path → { mtime, text }
  }

  getViewType() {
    return VIEW_RELATED;
  }

  getDisplayText() {
    return "Related";
  }

  getIcon() {
    return "waypoints";
  }

  async onOpen() {
    this.contentEl.addClass("tahoe-related");
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
    this.unwatch = this.plugin.index.onChange(() => this.refresh());
    this.render();
  }

  async onClose() {
    if (this.unwatch) this.unwatch();
  }

  // The note to show relations for: the active one, or the last one we saw.
  currentFile() {
    const f = this.app.workspace.getActiveFile();
    if (f && f.extension === "md") this.file = f;
    return this.file;
  }

  async preview(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return "";
    const c = this.previews.get(path);
    if (c && c.mtime === f.stat.mtime) return c.text;
    const text = (await noteText(this.app, f))
      .replace(/^#{1,6}\s+.*$/gm, "")
      .replace(/\[![\w|-]+\][+-]?[^\n]*/g, "")
      .replace(/[*_`>#-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    this.previews.set(path, { mtime: f.stat.mtime, text });
    return text;
  }

  async render() {
    const el = this.contentEl;
    const file = this.currentFile();
    const index = this.plugin.index;
    el.empty();
    const header = el.createDiv({ cls: "tahoe-related-header" });
    aiIcon(header.createSpan());
    header.createSpan({ cls: "tahoe-related-header-title", text: file ? `Related to “${file.basename}”` : "Related" });

    if (!file) return this.empty(el, "Open a note to see the notes related to it.");
    if (!index.ready) return this.empty(el, "Reading your notes…", true);

    // Meaning plus shared distinctive words (meaning alone misses short notes).
    let near = await hybridRelated(this.plugin, file, { k: SHOW });
    if (this.currentFile() !== file) return;
    if (!index.vectorOf(file.path) && !near.length) {
      // Too short to be indexed, or brand new: work it out now.
      const text = await noteText(this.app, file);
      if (text.length < 20) return this.empty(el, "Write a little more and related notes will appear here.");
      try {
        near = index.nearest(await index.embedText(`${file.basename}\n${text}`), { k: SHOW, min: 0.2, exclude: new Set([file.path]) });
      } catch {
        return this.empty(el, "Related notes need Apple Intelligence on this Mac.");
      }
      if (this.currentFile() !== file) return;
    }
    if (!near.length) return this.empty(el, "Nothing closely related yet.");

    const links = this.app.metadataCache.resolvedLinks[file.path] || {};
    const backlinks = new Set(Object.entries(this.app.metadataCache.resolvedLinks).filter(([, d]) => d[file.path]).map(([s]) => s));
    const tree = el.createDiv({ cls: "nav-files-container tahoe-related-tree" });
    for (const n of near) {
      const f = this.app.vault.getAbstractFileByPath(n.path);
      if (!(f instanceof TFile)) continue;
      const item = tree.createDiv({ cls: "tree-item nav-file" });
      const self = item.createDiv({ cls: "tree-item-self nav-file-title is-clickable tappable tahoe-related-row", attr: { "data-path": f.path, draggable: "true" } });
      const inner = self.createDiv({ cls: "tree-item-inner nav-file-title-content" });
      inner.createSpan({ cls: "tahoe-related-name", text: f.basename });
      const sub = self.createDiv({ cls: "tahoe-related-preview" });
      this.preview(f.path).then((t) => sub.setText(t || (f.parent && !f.parent.isRoot() ? f.parent.name : "")));

      const isLinked = !!links[f.path] || backlinks.has(f.path);
      const side = self.createDiv({ cls: "tahoe-related-side" });
      if (isLinked) {
        self.addClass("has-mark");
        const ok = side.createSpan({ cls: "tahoe-related-linked", attr: { "aria-label": links[f.path] ? "Linked from this note" : "Links to this note" } });
        setIcon(ok, "link");
      } else {
        const add = side.createEl("button", { cls: "tahoe-related-link", text: "Link", attr: { "aria-label": `Add [[${f.basename}]] at the cursor` } });
        add.addEventListener("click", (e) => {
          e.stopPropagation();
          this.addLink(file, f);
        });
      }
      self.addEventListener("click", (e) => this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f));
      self.addEventListener("dragstart", (e) => {
        const dm = this.app.dragManager;
        if (dm && dm.dragFile) dm.onDragStart(e, dm.dragFile(e, f));
      });
      self.addEventListener("mouseover", (e) =>
        this.app.workspace.trigger("hover-link", { event: e, source: VIEW_RELATED, hoverParent: this, targetEl: self, linktext: f.path })
      );
    }
  }

  empty(el, text, busy) {
    const box = el.createDiv({ cls: `tahoe-related-empty${busy ? " is-busy" : ""}` });
    box.setText(text);
  }

  // At the cursor if the note is open in an editor; otherwise on a "Related" line at the end.
  async addLink(from, to) {
    const view = this.app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v) => v instanceof MarkdownView && v.file === from);
    const link = this.app.fileManager.generateMarkdownLink(to, from.path);
    if (view && view.getMode() === "source") {
      const ed = view.editor;
      const cur = ed.getCursor();
      const line = ed.getLine(cur.line);
      const before = cur.ch > 0 && !/\s/.test(line[cur.ch - 1]) ? " " : "";
      ed.replaceRange(`${before}${link}`, cur);
    } else {
      await this.app.vault.process(from, (d) => {
        const m = /\nRelated: (.*)$/m.exec(d);
        if (m) return d.replace(/\nRelated: (.*)$/m, `\nRelated: $1 · ${link}`);
        return `${d.replace(/\s*$/, "")}\n\nRelated: ${link}\n`;
      });
    }
    this.refresh();
  }
}

function register(plugin) {
  plugin.registerView(VIEW_RELATED, (leaf) => new RelatedView(leaf, plugin));
  plugin.registerHoverLinkSource(VIEW_RELATED, { display: "Related notes", defaultMod: true });
  plugin.addCommand({
    id: "show-related",
    name: "Show related notes",
    icon: "waypoints",
    callback: async () => {
      let leaf = plugin.app.workspace.getLeavesOfType(VIEW_RELATED)[0];
      if (!leaf) {
        leaf = plugin.app.workspace.getRightLeaf(false);
        await leaf.setViewState({ type: VIEW_RELATED, active: true });
      }
      plugin.app.workspace.revealLeaf(leaf);
    },
  });
  // Put it in the right sidebar the first time, like Backlinks.
  plugin.app.workspace.onLayoutReady(() => {
    window.setTimeout(() => {
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_RELATED);
      leaves.slice(1).forEach((l) => l.detach());
      if (!leaves.length && !plugin.settings.relatedPlaced) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) leaf.setViewState({ type: VIEW_RELATED, active: false });
        plugin.settings.relatedPlaced = true;
        plugin.saveSettings();
      }
    }, 400);
  });
}

export { register, VIEW_RELATED };
