/*
 * Map of Content: an index note for a folder or a topic. Each note gets a
 * one-line summary (cached until the note changes); the model groups them
 * under a few headings, choosing only from the real notes; then the map is
 * written as "Map of <name>" with [[links]].
 */

import { Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { S, clip } from "../engine";
import { noteText, allFolders, knownFolders, safeName, ensureFolder, isoDate } from "../vault";
import { aiIcon, alert, showError } from "../ui";

const MAX_NOTES = 60;
const SUMMARY = `Say what a note is about in one short phrase of at most 12 words, using its own words. No "This note…".`;
const GROUP = `You organise someone's notes into a Map of Content. Group the notes under 2 to 6 short headings (2–4 words each) that describe what the notes in each group have in common. Put every note in exactly one group, choosing only from the note titles given.`;

async function summary(plugin, file) {
  const cache = (plugin.settings.summaryCache = plugin.settings.summaryCache || {});
  const c = cache[file.path];
  if (c && c.m === file.stat.mtime) return c.s;
  const text = clip(await noteText(plugin.app, file), 2000);
  if (!text) return "";
  const r = await plugin.engine.generate({ instructions: SUMMARY, prompt: `Note — ${file.basename}:\n${text}`, schema: S.object({ phrase: S.string("At most 12 words") }), temperature: 0.1 });
  const s = String(r.phrase || "").trim().replace(/\.$/, "");
  cache[file.path] = { m: file.stat.mtime, s };
  return s;
}

class MocModal extends Modal {
  constructor(plugin, preset) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = preset && preset.topic ? "topic" : "folder";
    this.folder = (preset && preset.folder) || "";
    this.topic = (preset && preset.topic) || "";
  }

  onOpen() {
    this.modalEl.addClass("tahoe-ai-sheet", "tahoe-ai-moc");
    const head = this.titleEl;
    aiIcon(head.createSpan({ cls: "tahoe-ai-title-icon" }));
    head.createSpan({ text: "Map of content" });
    this.form();
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
  }

  form() {
    const el = this.contentEl;
    el.empty();
    el.createDiv({ cls: "tahoe-ai-sub", text: "An index note that groups related notes under headings, with a line about each." });
    const seg = el.createDiv({ cls: "tahoe-ai-segmented" });
    const tab = (id, label) => {
      const b = seg.createEl("button", { cls: `tahoe-ai-segment${this.mode === id ? " is-active" : ""}`, text: label });
      b.addEventListener("click", () => {
        this.mode = id;
        this.form();
      });
    };
    tab("folder", "A folder");
    tab("topic", "A topic");
    const card = el.createDiv({ cls: "tahoe-ai-card tahoe-ai-moc-card" });
    const field = card.createDiv({ cls: "tahoe-ai-field" });
    let input;
    if (this.mode === "folder") {
      field.createDiv({ cls: "tahoe-ai-label", text: "Folder" });
      input = field.createEl("input", { type: "text", cls: "tahoe-ai-moc-input", value: this.folder, attr: { placeholder: "SecondBrain/400 Projects/CS 161", list: "tahoe-ai-folders" } });
      const dl = field.createEl("datalist", { attr: { id: "tahoe-ai-folders" } });
      for (const f of allFolders(this.app)) if (!f.path.startsWith(".")) dl.createEl("option", { value: f.path });
      input.addEventListener("input", () => (this.folder = input.value.trim().replace(/\/$/, "")));
    } else {
      field.createDiv({ cls: "tahoe-ai-label", text: "Topic" });
      input = field.createEl("input", { type: "text", cls: "tahoe-ai-moc-input", value: this.topic, attr: { placeholder: "dynamic programming" } });
      input.addEventListener("input", () => (this.topic = input.value.trim()));
    }
    input.addEventListener("keydown", (e) => e.key === "Enter" && this.make());
    const footer = el.createDiv({ cls: "tahoe-ai-footer" });
    footer.createDiv({ cls: "tahoe-ai-footer-meta", text: this.mode === "folder" ? "Includes notes in its subfolders" : "Notes are found by meaning, like a topic Smart Folder" });
    const buttons = footer.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons.createEl("button", { cls: "mod-cta", text: "Make map" }).addEventListener("click", () => this.make());
    window.setTimeout(() => input.focus(), 0);
  }

  step(list, text) {
    const row = list.createDiv({ cls: "tahoe-ai-step is-active" });
    aiIcon(row.createSpan());
    const label = row.createSpan({ text });
    return { set: (t) => label.setText(t), done: (t) => (row.removeClass("is-active"), row.addClass("is-done"), t && label.setText(t)) };
  }

  async make() {
    const app = this.app;
    const plugin = this.plugin;
    let files = [];
    let name = "";
    let outFolder = "";
    if (this.mode === "folder") {
      const folder = app.vault.getAbstractFileByPath(this.folder);
      if (!(folder instanceof TFolder)) return new Notice("Choose a folder first");
      name = folder.name.replace(/^\d+\s*[-_.]?\s*/, "");
      outFolder = folder.path;
      files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder.path + "/") && !/^Map of /.test(f.basename));
    } else if (!this.topic) return new Notice("Type a topic first");

    const el = this.contentEl;
    el.empty();
    const list = el.createDiv({ cls: "tahoe-ai-card tahoe-ai-steps" });
    try {
      if (this.mode === "topic") {
        const s0 = this.step(list, `Finding notes about “${this.topic}”…`);
        const found = (await plugin.api.notesAbout(this.topic)) || [];
        files = found.map((x) => app.vault.getAbstractFileByPath(x.path)).filter((f) => f instanceof TFile);
        name = this.topic.charAt(0).toUpperCase() + this.topic.slice(1);
        const k = knownFolders(app, plugin.settings);
        outFolder = plugin.settings.mocFolder || (k.root ? `${k.root}/Maps` : "Maps");
        s0.done(`Found ${files.length} ${files.length === 1 ? "note" : "notes"}`);
      }
      files = files.filter((f) => !plugin.index.excluded(f)).slice(0, MAX_NOTES);
      if (files.length < 2) {
        this.close();
        return new Notice(files.length ? "Only one note — nothing to map yet" : "No notes to map");
      }

      const s1 = this.step(list, `Reading ${files.length} notes…`);
      const items = [];
      for (let i = 0; i < files.length; i++) {
        if (this.closed) return;
        s1.set(`Reading ${files[i].basename}… (${i + 1}/${files.length})`);
        items.push({ file: files[i], title: files[i].basename, summary: await summary(plugin, files[i]) });
      }
      plugin.saveSettings();
      s1.done(`Read ${files.length} notes`);

      const s2 = this.step(list, "Grouping…");
      // Titles must be unique for the model to pick them.
      const seen = new Map();
      for (const it of items) {
        const n = (seen.get(it.title) || 0) + 1;
        seen.set(it.title, n);
        if (n > 1) it.title = `${it.title} (${it.file.parent ? it.file.parent.name : n})`;
      }
      const titles = items.map((x) => x.title);
      const r = await plugin.engine.generate({
        instructions: GROUP,
        prompt: clip(`Map of: ${name}\n\nNotes:\n${items.map((x) => `- ${x.title}: ${x.summary}`).join("\n")}`, 6000),
        schema: S.object({
          groups: S.list(S.object({ heading: S.string("2–4 words"), notes: S.list(S.oneOf(titles), titles.length) }), 6, "The groups"),
        }),
        temperature: 0.2,
      });
      const placed = new Set();
      const groups = [];
      for (const g of r.groups || []) {
        const notes = (g.notes || []).filter((t) => !placed.has(t) && titles.includes(t));
        notes.forEach((t) => placed.add(t));
        if (notes.length) groups.push({ heading: String(g.heading || "Notes").trim(), notes });
      }
      const rest = titles.filter((t) => !placed.has(t));
      if (rest.length) groups.push({ heading: "Other", notes: rest });
      s2.done(`${groups.length} groups`);

      const target = normalizePath(`${outFolder ? `${outFolder}/` : ""}Map of ${safeName(name)}.md`);
      const byTitle = new Map(items.map((x) => [x.title, x]));
      const body = [
        "---",
        "type: moc",
        `created: ${isoDate()}`,
        "---",
        `Notes ${this.mode === "folder" ? `in ${this.folder}` : `about ${this.topic}`}, grouped by theme.`,
        "",
        ...groups.flatMap((g) => [
          `## ${g.heading}`,
          ...g.notes.map((t) => {
            const it = byTitle.get(t);
            return `- ${app.fileManager.generateMarkdownLink(it.file, target)}${it.summary ? ` — ${it.summary}` : ""}`;
          }),
          "",
        ]),
      ].join("\n");
      await ensureFolder(app, outFolder);
      const existing = app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) {
        const ok = await alert(app, { title: `Replace “${existing.basename}”?`, message: "There's already a map with this name. The new one replaces it.", confirm: "Replace", warning: true, icon: "map" });
        if (!ok) return this.close();
        await app.vault.modify(existing, body);
      } else await app.vault.create(target, body);
      this.close();
      const f = app.vault.getAbstractFileByPath(target);
      if (f instanceof TFile) await app.workspace.getLeaf(false).openFile(f);
    } catch (e) {
      this.close();
      showError(e);
    }
  }
}

function register(plugin) {
  plugin.addCommand({ id: "make-moc", name: "Make a map of content…", icon: "map", callback: () => new MocModal(plugin).open() });
  plugin.registerEvent(
    plugin.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFolder) || file.isRoot()) return;
      menu.addItem((i) => i.setTitle("Make a map of content").setIcon("map").setSection("action").onClick(() => {
        const m = new MocModal(plugin, { folder: file.path });
        m.open();
        m.make();
      }));
    })
  );
}

export { register, MocModal, summary };
