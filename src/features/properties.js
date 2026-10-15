/*
 * Auto-properties: fill in missing `type`, `course`, `status` and tags.
 * Values come only from lists — your settings plus values already used in the
 * vault — so nothing new sprawls. Existing values are never overwritten.
 *
 * "Fill in properties across the vault" runs in the background (it pauses
 * while you type and picks up where it left off after a restart) and queues
 * suggestions for review; or, if you prefer, applies them as it goes.
 */

import { Modal, Notice, TFile, debounce } from "obsidian";
import { S, clip } from "../engine";
import { noteText, frontmatterOf, propertyValues, tagsOf, allFolders } from "../vault";
import { aiIcon, alert, showError } from "../ui";

const NONE = "none";
const COURSE_CODE = /\b([A-Z]{2,5}) ?(\d{1,3}[A-Z]?)\b/g;

const DESCRIPTIONS = {
  type: "What kind of note this is",
  course: "The class this note is for, only if it is clearly coursework",
  status: "Progress — only for a note that is itself a task or project to finish",
};

// What each built-in type means, so the model can tell them apart.
const TYPE_MEANINGS = {
  fleeting: "a quick, rough thought",
  literature: "notes on a book, article or talk by someone else",
  permanent: "one polished idea in the author's own words",
  project: "planning or progress for active work with a goal",
  area: "an ongoing part of life, like health or money",
  resource: "reference material or a how-to",
  lecture: "class or lecture notes",
  meeting: "notes from a meeting or conversation",
  daily: "a daily note",
  review: "a weekly or monthly review",
};

// Folder names that settle the type on their own ("100 Fleeting Notes" → fleeting).
const FOLDER_TYPES = [
  [/fleeting/i, "fleeting"],
  [/literature|reading/i, "literature"],
  [/permanent|evergreen|zettel/i, "permanent"],
  [/areas?$/i, "area"],
  [/resources?$/i, "resource"],
  [/daily|journal/i, "daily"],
  [/reviews?$/i, "review"],
  [/meetings?$/i, "meeting"],
];

function folderType(file, allowed) {
  const parts = (file.parent ? file.parent.path : "").split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    for (const [re, type] of FOLDER_TYPES) if (re.test(parts[i].replace(/^\d+\s*/, "")) && allowed.includes(type)) return type;
  }
  return null;
}

function instructions(defs, typeValues) {
  const lines = defs.map((d) => {
    let line = `- ${d.key}: ${d.description || DESCRIPTIONS[d.key] || `the note's ${d.key}`}. Use "${NONE}" when it doesn't apply.`;
    if (d.key === "type") line += `\n  ${typeValues.filter((v) => TYPE_MEANINGS[v]).map((v) => `${v} = ${TYPE_MEANINGS[v]}`).join("; ")}.`;
    if (d.key === "status") line += " Ideas, references, class notes and areas get none.";
    return line;
  });
  return `You fill in properties for notes in someone's knowledge base, choosing only from the allowed values.
${lines.join("\n")}
- tags: pick up to three from the list only when they describe what this note is about; none is fine.`;
}

// Allowed values for a property: settings + vault + (for course) course codes seen in names.
function valuesFor(plugin, def) {
  const set = new Set((def.values || []).map((v) => String(v).trim()).filter(Boolean));
  for (const v of propertyValues(plugin.app, def.key)) set.add(v);
  if (def.key === "course") {
    const names = [...allFolders(plugin.app).map((f) => f.name), ...plugin.app.vault.getMarkdownFiles().map((f) => f.basename)];
    for (const n of names) for (const m of n.matchAll(COURSE_CODE)) set.add(`${m[1]} ${m[2]}`);
  }
  return [...set].slice(0, 40);
}

// Properties the note already has are context ("course: CS 161" → class notes).
function existingProps(plugin, file) {
  const fm = frontmatterOf(plugin.app, file);
  const parts = Object.entries(fm)
    .filter(([k, v]) => k !== "position" && v != null && v !== "" && typeof v !== "object")
    .slice(0, 8)
    .map(([k, v]) => `${k}: ${v}`);
  return parts.length ? `\nIt already has: ${parts.join(", ")}` : "";
}

function missingKeys(plugin, file) {
  const fm = frontmatterOf(plugin.app, file);
  const defs = plugin.settings.properties.filter((d) => d.enabled && (fm[d.key] == null || fm[d.key] === ""));
  const wantTags = plugin.settings.propertyTags && tagsOf(plugin.app, file).length === 0;
  return { defs, wantTags };
}

async function suggestFor(plugin, file) {
  const { defs, wantTags } = missingKeys(plugin, file);
  if (!defs.length && !wantTags) return null;
  const text = clip(await noteText(plugin.app, file), 2400);
  if (text.length < 20) return null;
  const props = {};
  const active = [];
  const fixed = {};
  let typeValues = [];
  for (const d of defs) {
    let values = valuesFor(plugin, d);
    if (!values.length) continue;
    if (d.key === "type") {
      // The folder often settles it; in Projects the model picks the kind of project note.
      const byFolder = folderType(file, values);
      if (byFolder) {
        fixed.type = byFolder;
        continue;
      }
      if (/projects?$/i.test((file.parent ? file.parent.path : "").split("/").find((x) => /projects?$/i.test(x.replace(/^\d+\s*/, ""))) || "")) {
        values = values.filter((v) => ["project", "lecture", "meeting", "resource"].includes(v));
      }
      typeValues = values;
    }
    props[d.key] = S.oneOf([...values, NONE], d.description || DESCRIPTIONS[d.key]);
    active.push(d);
  }
  const tags = wantTags ? plugin.triage.candidateTags(`${file.basename} ${text}`, file) : [];
  if (tags.length) props.tags = S.list(S.oneOf(tags), 3, "Up to three tags that clearly apply");
  if (!Object.keys(props).length && !Object.keys(fixed).length) return null;
  const out = !Object.keys(props).length ? {} : await plugin.engine.generate({
    instructions: instructions(active, typeValues),
    prompt: `File: ${file.path}\nTitle: ${file.basename}${existingProps(plugin, file)}\n\nNote:\n${text}`,
    schema: S.object(props),
    temperature: 0.1,
  });
  const changes = Object.assign({}, fixed);
  for (const d of active) if (out[d.key] && out[d.key] !== NONE) changes[d.key] = out[d.key];
  // Status only makes sense on project-type notes.
  if (changes.status && (changes.type || frontmatterOf(plugin.app, file).type) && !["project"].includes(changes.type || frontmatterOf(plugin.app, file).type)) delete changes.status;
  const addTags = [...new Set((out.tags || []).filter((t) => tags.includes(t)))];
  if (!Object.keys(changes).length && !addTags.length) return null;
  return { path: file.path, mtime: file.stat.mtime, changes, tags: addTags };
}

async function applySuggestion(plugin, s, only) {
  const file = plugin.app.vault.getAbstractFileByPath(s.path);
  if (!(file instanceof TFile)) return false;
  await plugin.app.fileManager.processFrontMatter(file, (fm) => {
    for (const [k, v] of Object.entries(s.changes)) {
      if (only && !only.has(`${k}=${v}`)) continue;
      if (fm[k] == null || fm[k] === "") fm[k] = v;
    }
    const tags = s.tags.filter((t) => !only || only.has(`#${t}`));
    if (tags.length) {
      const existing = fm.tags == null ? [] : Array.isArray(fm.tags) ? fm.tags : String(fm.tags).split(/[,\s]+/).filter(Boolean);
      fm.tags = [...new Set([...existing, ...tags])];
    }
  });
  return true;
}

/* ---------- review sheet ---------- */

class PropertiesReviewModal extends Modal {
  constructor(plugin, suggestions, { onDone } = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.items = suggestions.map((s) => ({ s, on: new Set([...Object.entries(s.changes).map(([k, v]) => `${k}=${v}`), ...s.tags.map((t) => `#${t}`)]) }));
    this.onDone = onDone;
  }

  onOpen() {
    this.modalEl.addClass("tahoe-ai-sheet", "tahoe-ai-props");
    this.titleEl.setText(this.items.length === 1 ? "Suggested properties" : `Suggested properties · ${this.items.length} notes`);
    const el = this.contentEl;
    el.createDiv({ cls: "tahoe-ai-sub", text: "Only empty properties are filled in. Click a suggestion to leave it out." });
    const list = el.createDiv({ cls: "tahoe-ai-card tahoe-ai-props-list" });
    for (const item of this.items) {
      const row = list.createDiv({ cls: "tahoe-ai-props-row" });
      const name = row.createDiv({ cls: "tahoe-ai-props-name" });
      const link = name.createEl("a", { text: item.s.path.split("/").pop().replace(/\.md$/, ""), cls: "tahoe-ai-props-link" });
      link.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(item.s.path);
        if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
      });
      name.createDiv({ cls: "tahoe-ai-props-path", text: item.s.path.includes("/") ? item.s.path.slice(0, item.s.path.lastIndexOf("/")) : "" });
      const chips = row.createDiv({ cls: "tahoe-ai-chips" });
      const chip = (key, label) => {
        const c = chips.createEl("button", { cls: "tahoe-ai-chip is-on", text: label });
        c.addEventListener("click", () => {
          if (item.on.has(key)) item.on.delete(key);
          else item.on.add(key);
          c.toggleClass("is-on", item.on.has(key));
          this.updateButton();
        });
      };
      for (const [k, v] of Object.entries(item.s.changes)) chip(`${k}=${v}`, `${k}: ${v}`);
      for (const t of item.s.tags) chip(`#${t}`, `#${t}`);
    }
    const footer = el.createDiv({ cls: "tahoe-ai-footer" });
    const meta = footer.createDiv({ cls: "tahoe-ai-footer-meta" });
    aiIcon(meta.createSpan());
    meta.createSpan({ text: "Suggested on this Mac" });
    const buttons = footer.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: this.items.length > 1 ? "Later" : "Cancel" }).addEventListener("click", () => this.close());
    this.applyBtn = buttons.createEl("button", { cls: "mod-cta" });
    this.applyBtn.addEventListener("click", () => this.apply());
    this.updateButton();
  }

  updateButton() {
    const n = this.items.reduce((sum, i) => sum + i.on.size, 0);
    this.applyBtn.setText(n ? `Apply ${n}` : "Apply");
    this.applyBtn.disabled = !n;
  }

  async apply() {
    let notes = 0;
    for (const item of this.items) {
      if (!item.on.size) continue;
      if (await applySuggestion(this.plugin, item.s, item.on)) notes++;
    }
    this.applied = true;
    this.close();
    new Notice(`Updated properties in ${notes} ${notes === 1 ? "note" : "notes"}`);
  }

  onClose() {
    this.contentEl.empty();
    if (this.onDone) this.onDone(!!this.applied, this.items.map((i) => i.s.path));
  }
}

/* ---------- background job over the vault ---------- */

class PropertiesJob {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.running = false;
    this.lastTyping = 0;
    this.persist = debounce(() => plugin.saveSettings(), 3000, true);
  }

  get state() {
    return (this.plugin.settings.propertyJob = this.plugin.settings.propertyJob || { queue: [], total: 0 });
  }

  get pending() {
    return (this.plugin.settings.propertyReview = this.plugin.settings.propertyReview || []);
  }

  candidates() {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => !this.plugin.index.excluded(f))
      .filter((f) => {
        const { defs, wantTags } = missingKeys(this.plugin, f);
        return defs.length || wantTags;
      });
  }

  async begin() {
    const files = this.candidates().filter((f) => !this.pending.some((p) => p.path === f.path));
    if (!files.length) return new Notice("Every note already has its properties");
    const minutes = Math.max(1, Math.round((files.length * 1.6) / 60));
    const ok = await alert(this.app, {
      title: `Fill in properties for ${files.length} ${files.length === 1 ? "note" : "notes"}?`,
      message: `This runs in the background on this Mac (about ${minutes} min) and pauses while you type. ${
        this.plugin.settings.propertyAutoApply ? "Suggestions are applied as they're made." : "You'll review the suggestions before anything changes."
      }`,
      confirm: "Start",
      icon: "list-plus",
    });
    if (!ok) return;
    this.state.queue = files.map((f) => f.path);
    this.state.total = files.length;
    this.plugin.saveSettings();
    this.run();
  }

  stop() {
    this.state.queue = [];
    this.state.total = 0;
    this.stopRequested = true;
    this.plugin.saveSettings();
    this.plugin.setJobStatus(null);
  }

  async run() {
    if (this.running || !this.state.queue.length) return;
    this.running = true;
    this.stopRequested = false;
    try {
      while (this.state.queue.length && !this.stopRequested) {
        // Give way while the user is writing.
        while (Date.now() - this.lastTyping < 8000) await new Promise((r) => window.setTimeout(r, 2000));
        const p = this.state.queue[0];
        const f = this.app.vault.getAbstractFileByPath(p);
        this.plugin.setJobStatus(`Filling in properties · ${this.state.total - this.state.queue.length + 1}/${this.state.total}`);
        if (f instanceof TFile) {
          try {
            const s = await suggestFor(this.plugin, f);
            if (s) {
              if (this.plugin.settings.propertyAutoApply) await applySuggestion(this.plugin, s);
              else this.pending.push(s);
            }
          } catch (e) {
            if (e.code === "unavailable") {
              showError(e);
              break;
            }
          }
        }
        this.state.queue.shift();
        this.persist();
      }
    } finally {
      this.running = false;
      this.plugin.setJobStatus(null);
      this.plugin.saveSettings();
    }
    if (!this.state.queue.length && this.pending.length && !this.plugin.settings.propertyAutoApply) {
      const n = new Notice(`Property suggestions are ready for ${this.pending.length} notes — click to review`, 10000);
      n.noticeEl.addEventListener("click", () => this.review());
    }
  }

  review() {
    // Drop suggestions for notes that changed or already got the property.
    const fresh = this.pending.filter((s) => {
      const f = this.app.vault.getAbstractFileByPath(s.path);
      return f instanceof TFile && f.stat.mtime === s.mtime;
    });
    this.plugin.settings.propertyReview = fresh;
    if (!fresh.length) return new Notice("No property suggestions to review");
    new PropertiesReviewModal(this.plugin, fresh, {
      onDone: (applied, paths) => {
        if (!applied) return;
        const done = new Set(paths);
        this.plugin.settings.propertyReview = this.pending.filter((s) => !done.has(s.path));
        this.plugin.saveSettings();
      },
    }).open();
  }
}

function register(plugin) {
  const job = (plugin.propertiesJob = new PropertiesJob(plugin));
  plugin.registerEvent(plugin.app.workspace.on("editor-change", () => (job.lastTyping = Date.now())));
  plugin.addCommand({
    id: "suggest-properties",
    name: "Suggest properties for this note",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;
      if (checking) return true;
      (async () => {
        const n = new Notice("Reading the note…", 0);
        try {
          const s = await suggestFor(plugin, file);
          n.hide();
          if (!s) return new Notice("This note already has its properties");
          new PropertiesReviewModal(plugin, [s]).open();
        } catch (e) {
          n.hide();
          showError(e);
        }
      })();
      return true;
    },
  });
  plugin.addCommand({ id: "fill-properties", name: "Fill in properties across the vault…", callback: () => job.begin() });
  plugin.addCommand({ id: "review-properties", name: "Review property suggestions", callback: () => job.review() });
  plugin.addCommand({
    id: "stop-properties",
    name: "Stop filling in properties",
    checkCallback: (checking) => {
      if (!job.state.queue.length) return false;
      if (!checking) {
        job.stop();
        new Notice("Stopped. Suggestions so far are kept for review.");
      }
      return true;
    },
  });
}

// Pick up an unfinished run after a restart.
function startBackground(plugin) {
  if (plugin.propertiesJob && plugin.propertiesJob.state.queue.length) plugin.propertiesJob.run();
}

export { register, startBackground, suggestFor, applySuggestion };
