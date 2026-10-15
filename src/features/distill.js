/*
 * Distill: turn a rough fleeting note into a permanent-note draft — one idea,
 * a title phrased as a claim, a few sentences in plain words, and links to
 * related notes. Nothing is saved until you press Save; the fleeting note is
 * kept and gets a link to the new one.
 */

import { Modal, Notice, TFile } from "obsidian";
import { S, clip } from "../engine";
import { noteText, knownFolders, safeName, uniquePath, ensureFolder, isoDate } from "../vault";
import { aiIcon, thinking, showError } from "../ui";

const INSTRUCTIONS = `You help someone turn a rough fleeting note into a permanent note for their Zettelkasten.
A permanent note holds exactly one idea, written clearly in the author's own voice so it makes sense on its own months later.
- The title is the idea stated as a short claim, a full sentence of at most 12 words (for example "Memoization trades memory for time").
- The body is 2 to 5 plain sentences: state the idea and explain why it's true or why it matters.
- Use only what the note says. Don't add examples, numbers, names or facts that aren't in it.
- Don't use headings or bullet points in the body.
- If the note contains several ideas, distill only the most important one.`;

async function draft(plugin, file) {
  const text = clip(await noteText(plugin.app, file), 3000);
  const out = await plugin.engine.generate({
    instructions: INSTRUCTIONS,
    prompt: `Fleeting note — ${file.basename}:\n${text}`,
    schema: S.object({
      title: S.string("The idea as a short claim, at most 12 words"),
      body: S.string("2 to 5 sentences in plain words, using only what the note says"),
    }),
    temperature: 0.2,
  });
  // Links: notes closest in meaning to the clean draft (rough notes cluster by
  // writing style, a draft by its idea). The closest are ticked to start with.
  let related = [];
  if (plugin.index.ready) {
    try {
      const vec = await plugin.index.embedText(`${out.title}\n${out.body}`);
      related = plugin.index.nearest(vec, { k: 6, min: 0.25, exclude: new Set([file.path]) });
    } catch {
      // no index yet: no related notes
    }
  }
  return {
    title: safeName(out.title || "").replace(/\.$/, ""),
    body: String(out.body || "").trim(),
    links: related.map((r) => ({ path: r.path, title: r.path.split("/").pop().replace(/\.md$/, ""), checked: r.score >= plugin.settings.linkThreshold })),
  };
}

class DistillModal extends Modal {
  constructor(plugin, file) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.result = null;
  }

  onOpen() {
    this.modalEl.addClass("tahoe-ai-sheet", "tahoe-ai-distill");
    this.titleEl.setText("Distill into a permanent note");
    this.generate();
  }

  async generate() {
    const el = this.contentEl;
    el.empty();
    el.createDiv({ cls: "tahoe-ai-sub", text: `From “${this.file.basename}”` });
    const wait = el.createDiv({ cls: "tahoe-ai-card is-thinking" });
    thinking(wait, "Finding the idea…");
    try {
      this.result = await draft(this.plugin, this.file);
      this.render();
    } catch (e) {
      this.close();
      showError(e);
    }
  }

  render() {
    const el = this.contentEl;
    const r = this.result;
    el.empty();
    el.createDiv({ cls: "tahoe-ai-sub", text: `From “${this.file.basename}”` });

    const card = el.createDiv({ cls: "tahoe-ai-card" });
    const titleRow = card.createDiv({ cls: "tahoe-ai-field" });
    titleRow.createDiv({ cls: "tahoe-ai-label", text: "Title" });
    const title = titleRow.createEl("input", { type: "text", cls: "tahoe-ai-title-input", value: r.title });
    title.addEventListener("input", () => (r.title = title.value));
    const bodyRow = card.createDiv({ cls: "tahoe-ai-field" });
    bodyRow.createDiv({ cls: "tahoe-ai-label", text: "Note" });
    const body = bodyRow.createEl("textarea", { cls: "tahoe-ai-body-input" });
    body.value = r.body;
    body.rows = 6;
    body.addEventListener("input", () => (r.body = body.value));

    if (r.links.length) {
      el.createDiv({ cls: "tahoe-ai-section-title", text: "Link to" });
      const list = el.createDiv({ cls: "tahoe-ai-card tahoe-ai-checklist" });
      for (const link of r.links) {
        const row = list.createEl("label", { cls: "tahoe-ai-check-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = link.checked;
        cb.addEventListener("change", () => (link.checked = cb.checked));
        row.createSpan({ cls: "tahoe-ai-check-title", text: link.title });
        row.createSpan({ cls: "tahoe-ai-check-meta", text: link.path.includes("/") ? link.path.slice(0, link.path.lastIndexOf("/")) : "" });
      }
    }

    const folder = this.targetFolder();
    const footer = el.createDiv({ cls: "tahoe-ai-footer" });
    const meta = footer.createDiv({ cls: "tahoe-ai-footer-meta" });
    aiIcon(meta.createSpan());
    meta.createSpan({ text: `Saves to ${folder || "the vault root"}` });
    const buttons = footer.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Try again" }).addEventListener("click", () => this.generate());
    const save = buttons.createEl("button", { cls: "mod-cta", text: "Save" });
    save.addEventListener("click", () => this.save());
    window.setTimeout(() => title.focus(), 0);
  }

  targetFolder() {
    const s = this.plugin.settings;
    if (s.distillFolder) return s.distillFolder;
    const organize = this.app.plugins.getPlugin("tahoe-organize");
    if (organize && organize.settings && organize.settings.promoteFolder) return organize.settings.promoteFolder;
    return knownFolders(this.app, s).permanent;
  }

  async save() {
    const r = this.result;
    const name = safeName(r.title) || "Untitled idea";
    const folder = this.targetFolder();
    await ensureFolder(this.app, folder);
    const target = uniquePath(this.app, folder, name, "md");
    const sourceLink = this.app.fileManager.generateMarkdownLink(this.file, target);
    const links = r.links.filter((l) => l.checked).map((l) => {
      const f = this.app.vault.getAbstractFileByPath(l.path);
      return f instanceof TFile ? this.app.fileManager.generateMarkdownLink(f, target) : `[[${l.title}]]`;
    });
    const content = [
      "---",
      "type: permanent",
      `created: ${isoDate()}`,
      `source: "${sourceLink.replace(/"/g, '\\"')}"`,
      "---",
      r.body.trim(),
      "",
      links.length ? `Related: ${links.join(" · ")}` : "",
      "",
    ].join("\n");
    const created = await this.app.vault.create(target, content);
    // Keep the fleeting note, and point it at what it became.
    await this.app.fileManager.processFrontMatter(this.file, (fm) => {
      fm.distilled = this.app.fileManager.generateMarkdownLink(created, this.file.path);
    });
    this.close();
    await this.app.workspace.getLeaf(false).openFile(created);
    new Notice(`Saved “${created.basename}”`);
  }

  onClose() {
    this.contentEl.empty();
  }
}

function register(plugin) {
  plugin.addCommand({
    id: "distill",
    name: "Distill into a permanent note",
    icon: "sparkles",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;
      if (!checking) new DistillModal(plugin, file).open();
      return true;
    },
  });
  plugin.registerEvent(
    plugin.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addItem((i) =>
        i
          .setTitle("Distill into a permanent note")
          .setIcon("sparkles")
          .setSection("action")
          .onClick(() => new DistillModal(plugin, file).open())
      );
    })
  );
}

export { register, DistillModal, draft };
