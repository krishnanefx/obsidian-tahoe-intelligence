/*
 * Triage suggestions: for a note in the inbox, the model picks a folder (from
 * the vault's real folders), up to three tags (only tags already in use) and
 * a better title. Suggestions for inbox notes are worked out in the
 * background and saved in the plugin folder, so they sync to iPhone too.
 */

import { TFile, debounce, normalizePath } from "obsidian";
import { S, clip } from "../engine";
import { noteText, allFolders, knownFolders, tagsInUse, tagsOf, safeName } from "../vault";

const CACHE_FILE = "triage-suggestions.json";

const INSTRUCTIONS = `You help someone file notes in their personal knowledge base. It is organised in numbered folders:
Inbox (unsorted) → Fleeting (quick rough thoughts) → Literature (notes about a book, article or lecture someone else made) → Permanent (one polished idea in the author's own words) → Projects (active work with a goal and an end) → Areas (ongoing parts of life, like health or money) → Resources (reference material and how-tos).
Choose the single best folder for the note. A subfolder is better than its parent when it fits.
Pick tags only from the list given, and only when they clearly apply. It's fine to pick none.
Suggest a title that is short and specific, in the author's own words. Keep the current title if it's already clear.`;

class TriageSuggester {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.cache = {}; // path → { mtime, folder, title, tags }
    this.inflight = new Map();
    this.saveSoon = debounce(() => this.save(), 2000, true);
    this.refreshSoon = debounce(() => this.precompute(), 8000, true);
  }

  get cachePath() {
    return normalizePath(`${this.plugin.manifest.dir}/${CACHE_FILE}`);
  }

  async load() {
    try {
      this.cache = JSON.parse(await this.app.vault.adapter.read(this.cachePath)).suggestions || {};
    } catch {
      this.cache = {};
    }
  }

  async save() {
    await this.app.vault.adapter.write(this.cachePath, JSON.stringify({ version: 1, suggestions: this.cache }, null, 1));
  }

  inboxFolder() {
    const organize = this.app.plugins.getPlugin("tahoe-organize");
    const configured = organize && organize.settings && organize.settings.inboxFolder;
    return configured || knownFolders(this.app, this.plugin.settings).inbox;
  }

  start() {
    const inInbox = (f) => f instanceof TFile && f.extension === "md" && f.parent && f.parent.path === this.inboxFolder();
    this.plugin.registerEvent(this.app.vault.on("create", (f) => inInbox(f) && this.refreshSoon()));
    this.plugin.registerEvent(this.app.vault.on("modify", (f) => inInbox(f) && this.refreshSoon()));
    this.plugin.registerEvent(this.app.vault.on("rename", (f, old) => this.cache[old] && (delete this.cache[old], this.saveSoon())));
    this.precompute();
  }

  // Work out suggestions for everything in the inbox, oldest first.
  async precompute() {
    const inbox = this.inboxFolder();
    if (!inbox) return;
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.parent && f.parent.path === inbox);
    const live = new Set(files.map((f) => f.path));
    for (const p of Object.keys(this.cache)) if (!live.has(p)) delete this.cache[p];
    for (const f of files.sort((a, b) => a.stat.ctime - b.stat.ctime)) {
      if (!this.cached(f)) {
        try {
          await this.suggest(f);
        } catch (e) {
          if (e.code === "unavailable") return;
        }
      }
    }
    this.saveSoon();
  }

  cached(file) {
    const c = this.cache[file.path];
    return c && c.mtime === file.stat.mtime ? c : null;
  }

  // Folders worth offering: below the SecondBrain root, two levels deep.
  candidateFolders() {
    const known = knownFolders(this.app, this.plugin.settings);
    const inbox = this.inboxFolder();
    const root = known.root;
    const depth = (p) => (root ? p.slice(root.length + 1) : p).split("/").length;
    let folders = allFolders(this.app).filter((f) => {
      if (f.path === inbox || f.path.startsWith(".") || /(^|\/)(attachments?|assets|templates?|_resources)$/i.test(f.path)) return false;
      if (root && !f.path.startsWith(root + "/")) return false;
      return depth(f.path) <= 2;
    });
    if (!folders.length) folders = allFolders(this.app).filter((f) => f.path !== inbox && !f.path.includes("/"));
    return folders.slice(0, 32).map((f) => {
      const examples = f.children
        .filter((c) => c instanceof TFile && c.extension === "md")
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, 3)
        .map((c) => c.basename);
      return { path: f.path, examples };
    });
  }

  // Tags to offer, grounded in the vault: tags that similar notes use, and tags
  // whose words appear in the note. Finder color tags (#red …) and priority
  // tags are about status, not topic, so they're left out.
  candidateTags(text, file) {
    const organize = this.app.plugins.getPlugin("tahoe-organize");
    const colorMap = (organize && organize.settings && organize.settings.tagColors) || {};
    const skip = new Set(["red", "orange", "yellow", "green", "blue", "purple", "gray", "grey", "urgent", "important", "todo", "done", "archive"]);
    for (const list of Object.values(colorMap)) for (const t of list || []) skip.add(String(t).toLowerCase());
    const inUse = new Map(tagsInUse(this.app).filter(([t]) => !skip.has(t.toLowerCase())));
    const score = new Map();
    // Tags that several close notes share (one look-alike note isn't enough).
    if (file && this.plugin.index.ready) {
      const votes = new Map();
      for (const n of this.plugin.index.similarTo(file.path, { k: 10, min: 0.3 })) {
        const f = this.app.vault.getAbstractFileByPath(n.path);
        if (!(f instanceof TFile)) continue;
        for (const t of tagsOf(this.app, f)) if (inUse.has(t)) votes.set(t, (votes.get(t) || 0) + n.score);
      }
      for (const [t, w] of votes) if (w >= 0.8) score.set(t, w);
    }
    // Tags whose words appear in the note.
    const lower = text.toLowerCase();
    for (const t of inUse.keys()) {
      const words = t.toLowerCase().split(/[/_-]/).filter((w) => w.length > 2);
      if (words.length && words.every((w) => lower.includes(w))) score.set(t, (score.get(t) || 0) + 1);
    }
    return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t]) => t);
  }

  async suggest(file, { force = false } = {}) {
    if (!force) {
      const c = this.cached(file);
      if (c) return c;
    }
    if (this.inflight.has(file.path)) return this.inflight.get(file.path);
    const job = this.run(file).finally(() => this.inflight.delete(file.path));
    this.inflight.set(file.path, job);
    return job;
  }

  async run(file) {
    const text = clip(await noteText(this.app, file), 2600);
    const folders = this.candidateFolders();
    const tags = this.candidateTags(`${file.basename} ${text}`, file).filter((t) => !tagsOf(this.app, file).includes(t));

    // Where do notes like this one live? A hint from the meaning index.
    const near = this.plugin.index.ready ? this.plugin.index.similarTo(file.path, { k: 6 }) : [];
    const votes = new Map();
    for (const n of near) {
      const parent = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
      if (folders.some((f) => f.path === parent)) votes.set(parent, (votes.get(parent) || 0) + n.score);
    }
    const hint = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);

    const prompt = [
      `Current title: ${file.basename}`,
      `Note:\n${text || "(empty)"}`,
      "",
      "Folders (with a few notes in each):",
      ...folders.map((f) => `- ${f.path}${f.examples.length ? ` — e.g. ${f.examples.join("; ")}` : ""}`),
      hint.length ? `\nNotes on similar topics are filed in: ${hint.join(", ")}` : "",
      tags.length ? `\nTags in use: ${tags.join(", ")}` : "",
    ].join("\n");

    const props = {
      folder: S.oneOf(folders.map((f) => f.path), "The best folder for this note"),
      title: S.string("A short, specific title"),
    };
    if (tags.length) props.tags = S.list(S.oneOf(tags), 3, "Up to three tags that clearly apply");
    const out = await this.plugin.engine.generate({ instructions: INSTRUCTIONS, prompt, schema: S.object(props), temperature: 0.2 });

    let title = safeName(out.title || "") || file.basename;
    if (title.toLowerCase() === file.basename.toLowerCase()) title = file.basename;
    const result = {
      mtime: file.stat.mtime,
      folder: out.folder,
      title,
      tags: [...new Set((out.tags || []).filter((t) => tags.includes(t)))],
    };
    this.cache[file.path] = result;
    this.saveSoon();
    return result;
  }
}

export { TriageSuggester, CACHE_FILE };
