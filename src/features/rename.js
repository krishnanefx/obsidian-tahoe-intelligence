/*
 * Rename junk names: "Untitled 3", "Pasted image 20261005091610.png",
 * "Screenshot 2026-…", "IMG_1234". Notes are named from what they say; images
 * from the words in them (Live Text), what's in the picture, and the note
 * they're embedded in. You review every name before anything is renamed, and
 * links are updated.
 */

import { Modal, Notice, TFile } from "obsidian";
import { S, clip } from "../engine";
import { noteText, safeName, uniquePath } from "../vault";
import { aiIcon, showError } from "../ui";

const JUNK_NOTE = /^(untitled|new note|note|unnamed)( \d+)?$/i;
const JUNK_IMAGE = /^(pasted image \d{8,14}|screenshot[ _-]\d{4}-\d{2}-\d{2}.*|screen shot .*|cleanshot .*|img[_-]?\d{3,}|image( \d+)?|photo[_-]?\d+|\d{8}[_-]\d{6}|untitled( \d+)?)$/i;
const IMAGE_EXT = /^(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;

const INSTRUCTIONS = `You name files in someone's notes. Give a short, specific, human name of 2 to 6 words that says what the file is about, like "Knapsack recurrence" or "Midterm topics". Use the person's own words where possible. No dates unless the date is the point, no file extension, no quotes.`;

function junkFiles(app) {
  return app.vault.getFiles().filter((f) => !(app.metadataCache.isUserIgnored && app.metadataCache.isUserIgnored(f.path))).filter((f) => (f.extension === "md" && JUNK_NOTE.test(f.basename)) || (IMAGE_EXT.test(f.extension) && JUNK_IMAGE.test(f.basename)));
}

// The note an image is embedded in, and the line around the embed.
async function embedContext(app, file) {
  for (const [src, dests] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!dests[file.path]) continue;
    const note = app.vault.getAbstractFileByPath(src);
    if (!(note instanceof TFile)) continue;
    const raw = await app.vault.cachedRead(note);
    const lines = raw.split("\n");
    const i = lines.findIndex((l) => l.includes(file.name) || l.includes(file.basename));
    let heading = "";
    for (let j = i; j >= 0; j--) {
      const m = /^#{1,6}\s+(.*)/.exec(lines[j] || "");
      if (m) {
        heading = m[1];
        break;
      }
    }
    const around = lines.slice(Math.max(0, i - 2), i + 3).join(" ").replace(/!\[\[[^\]]*\]\]/g, "").trim();
    return { note: note.basename, heading, around };
  }
  return null;
}

async function proposeName(plugin, file) {
  const app = plugin.app;
  let prompt;
  if (file.extension === "md") {
    const text = clip(await noteText(app, file), 2400);
    if (!text) return null;
    prompt = `A note called "${file.basename}" says:\n${text}\n\nName this note.`;
  } else {
    const full = app.vault.adapter.getFullPath(file.path);
    let seen = { text: "", labels: [] };
    try {
      seen = await plugin.engine.describeImage(full);
    } catch {
      // unreadable: named from its file name
    }
    const organize = app.plugins.getPlugin("tahoe-organize");
    const ocr = organize && organize.ocr && organize.ocr.entries[file.path];
    const words = (seen.text || (ocr && ocr.text) || "").slice(0, 1200);
    const ctx = await embedContext(app, file);
    if (!words && !(seen.labels || []).length && !ctx) return null;
    prompt = [
      "Name this image file.",
      words ? `Text in the image:\n${words}` : "The image has no text.",
      seen.labels && seen.labels.length ? `What's in the picture: ${seen.labels.join(", ")}` : "",
      ctx ? `It's embedded in the note "${ctx.note}"${ctx.heading ? `, under the heading "${ctx.heading}"` : ""}${ctx.around ? `, next to: ${ctx.around}` : ""}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const out = await plugin.engine.generate({
    instructions: INSTRUCTIONS,
    prompt,
    schema: S.object({ name: S.string("2 to 6 words") }),
    temperature: 0.2,
  });
  const name = safeName(out.name || "").replace(/\.(png|jpe?g|md)$/i, "");
  return name && name.toLowerCase() !== file.basename.toLowerCase() ? name : null;
}

class RenameModal extends Modal {
  constructor(plugin, files) {
    super(plugin.app);
    this.plugin = plugin;
    this.rows = files.map((file) => ({ file, name: "", state: "waiting", checked: true }));
    this.cancelled = false;
  }

  onOpen() {
    this.modalEl.addClass("tahoe-ai-sheet", "tahoe-ai-rename");
    this.titleEl.setText("Rename untitled notes and images");
    this.render();
    this.work();
  }

  onClose() {
    this.cancelled = true;
    this.contentEl.empty();
  }

  async work() {
    for (const row of this.rows) {
      if (this.cancelled) return;
      row.state = "thinking";
      this.updateRow(row);
      try {
        row.name = (await proposeName(this.plugin, row.file)) || "";
        row.state = row.name ? "ready" : "skip";
        row.checked = !!row.name;
      } catch (e) {
        row.state = "skip";
        row.checked = false;
        if (e.code === "unavailable") {
          showError(e);
          this.close();
          return;
        }
      }
      this.updateRow(row);
    }
    this.updateFooter();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    el.createDiv({ cls: "tahoe-ai-sub", text: "Names come from what each note says, or from the words and picture in each image. Links to them are updated the way your Files & links settings say." });
    const list = el.createDiv({ cls: "tahoe-ai-card tahoe-ai-rename-list" });
    for (const row of this.rows) {
      row.el = list.createDiv({ cls: "tahoe-ai-rename-row" });
      this.updateRow(row);
    }
    const footer = el.createDiv({ cls: "tahoe-ai-footer" });
    this.footerMeta = footer.createDiv({ cls: "tahoe-ai-footer-meta" });
    const buttons = footer.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    this.applyBtn = buttons.createEl("button", { cls: "mod-cta", text: "Rename" });
    this.applyBtn.addEventListener("click", () => this.apply());
    this.updateFooter();
  }

  updateRow(row) {
    const el = row.el;
    if (!el) return;
    el.empty();
    el.toggleClass("is-skipped", row.state === "skip");
    const cb = el.createEl("input", { type: "checkbox" });
    cb.checked = row.checked;
    cb.disabled = row.state !== "ready";
    cb.addEventListener("change", () => {
      row.checked = cb.checked;
      this.updateFooter();
    });
    const thumb = el.createDiv({ cls: "tahoe-ai-rename-thumb" });
    if (row.file.extension !== "md") thumb.createEl("img", { attr: { src: this.app.vault.getResourcePath(row.file), loading: "lazy" } });
    else thumb.addClass("is-note");
    const text = el.createDiv({ cls: "tahoe-ai-rename-text" });
    text.createDiv({ cls: "tahoe-ai-rename-old", text: row.file.name });
    if (row.state === "thinking" || row.state === "waiting") {
      const t = text.createDiv({ cls: "tahoe-ai-rename-wait" });
      if (row.state === "thinking") aiIcon(t.createSpan());
      t.createSpan({ text: row.state === "thinking" ? "Reading…" : "Waiting" });
    } else if (row.state === "skip") {
      text.createDiv({ cls: "tahoe-ai-rename-wait", text: "Nothing to go on — left as is" });
    } else {
      const input = text.createEl("input", { type: "text", cls: "tahoe-ai-rename-input", value: row.name });
      input.addEventListener("input", () => (row.name = input.value));
      text.createSpan({ cls: "tahoe-ai-rename-ext", text: `.${row.file.extension}` });
    }
  }

  updateFooter() {
    if (!this.applyBtn) return;
    const n = this.rows.filter((r) => r.checked && r.state === "ready" && safeName(r.name)).length;
    const pending = this.rows.filter((r) => r.state === "waiting" || r.state === "thinking").length;
    this.applyBtn.setText(n ? `Rename ${n}` : "Rename");
    this.applyBtn.disabled = !n;
    this.footerMeta.empty();
    aiIcon(this.footerMeta.createSpan());
    this.footerMeta.createSpan({ text: pending ? `Naming… ${this.rows.length - pending}/${this.rows.length}` : `${this.rows.filter((r) => r.state === "ready").length} names suggested` });
  }

  async apply() {
    let done = 0;
    for (const row of this.rows) {
      if (!row.checked || row.state !== "ready") continue;
      const base = safeName(row.name);
      if (!base) continue;
      const folder = row.file.parent ? row.file.parent.path : "";
      const target = uniquePath(this.app, folder, base, row.file.extension, row.file.path);
      if (target === row.file.path) continue;
      await this.app.fileManager.renameFile(row.file, target);
      done++;
    }
    this.close();
    new Notice(done ? `Renamed ${done} ${done === 1 ? "file" : "files"}` : "Nothing renamed");
  }
}

function register(plugin) {
  plugin.addCommand({
    id: "rename-junk",
    name: "Rename untitled notes and pasted images…",
    icon: "text-cursor-input",
    callback: () => {
      const files = junkFiles(plugin.app).slice(0, 40);
      if (!files.length) return new Notice("No untitled notes or pasted images to rename");
      new RenameModal(plugin, files).open();
    },
  });
  plugin.addCommand({
    id: "rename-this",
    name: "Suggest a name for this file",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file) return false;
      if (!checking) new RenameModal(plugin, [file]).open();
      return true;
    },
  });
  plugin.registerEvent(
    plugin.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile)) return;
      if (!(file.extension === "md" || IMAGE_EXT.test(file.extension))) return;
      menu.addItem((i) =>
        i
          .setTitle("Suggest a name")
          .setIcon("sparkles")
          .setSection("action")
          .onClick(() => new RenameModal(plugin, [file]).open())
      );
    })
  );
}

export { register, junkFiles, proposeName };
