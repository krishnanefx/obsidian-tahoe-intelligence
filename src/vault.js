// Reading the vault the way the models need it.

import { TFile, TFolder, getAllTags, normalizePath } from "obsidian";

// Note text without front matter, code blocks or embeds, with links as plain words.
function plainText(raw) {
  return String(raw || "")
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, (m, a) => a.split("/").pop())
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function noteText(app, file) {
  return plainText(await app.vault.cachedRead(file));
}

function frontmatterOf(app, file) {
  const cache = app.metadataCache.getFileCache(file);
  return (cache && cache.frontmatter) || {};
}

function allFolders(app) {
  const out = [];
  const walk = (folder) => {
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(app.vault.getRoot());
  return out;
}

function findFolder(app, pattern, under = "") {
  const prefix = under ? `${under}/` : "";
  return allFolders(app).find((f) => (!under || f.path.startsWith(prefix)) && pattern.test(f.name)) || null;
}

// The SecondBrain-style folders: inbox, permanent notes, projects, areas.
function knownFolders(app, settings = {}) {
  const inbox = settings.inboxFolder || (findFolder(app, /inbox/i) || {}).path || "";
  const root = inbox.includes("/") ? inbox.slice(0, inbox.lastIndexOf("/")) : "";
  const pick = (key, re) => settings[key] || (findFolder(app, re, root) || findFolder(app, re) || {}).path || "";
  return {
    inbox,
    root,
    permanent: pick("permanentFolder", /permanent|evergreen|zettel|^3\d\d\b/i),
    projects: pick("projectsFolder", /projects?$|^4\d\d\b/i),
    areas: pick("areasFolder", /areas?$|^5\d\d\b/i),
    archive: pick("archiveFolder", /archive/i),
  };
}

// Tags in use, most used first, without the "#".
function tagsInUse(app) {
  const counts = app.metadataCache.getTags ? app.metadataCache.getTags() : {};
  return Object.entries(counts)
    .map(([t, n]) => [t.replace(/^#/, ""), n])
    .sort((a, b) => b[1] - a[1]);
}

function tagsOf(app, file) {
  const cache = app.metadataCache.getFileCache(file);
  return cache ? (getAllTags(cache) || []).map((t) => t.replace(/^#/, "")) : [];
}

// Values already used for a property across the vault, most used first.
function propertyValues(app, key) {
  const counts = new Map();
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = frontmatterOf(app, f);
    let v = fm[key];
    if (v == null || v === "") continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      const s = String(x).trim();
      if (s) counts.set(s, (counts.get(s) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

// A name that's safe as a file name and doesn't clash with a sibling.
function safeName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 90)
    .trim();
}

function uniquePath(app, folder, base, ext, except) {
  const dir = folder && folder !== "/" ? `${folder}/` : "";
  let candidate = normalizePath(`${dir}${base}.${ext}`);
  let n = 2;
  while (app.vault.getAbstractFileByPath(candidate) && candidate !== except) {
    candidate = normalizePath(`${dir}${base} ${n}.${ext}`);
    n++;
  }
  return candidate;
}

async function ensureFolder(app, folder) {
  if (!folder || app.vault.getAbstractFileByPath(folder)) return;
  const parts = folder.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (!app.vault.getAbstractFileByPath(p)) await app.vault.createFolder(p);
  }
}

function isoDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function longDate(d = new Date()) {
  return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

// ISO week number, for "Weekly Review 2026-W41".
function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - yearStart) / 86400000 + 1) / 7) };
}

export {
  plainText,
  noteText,
  frontmatterOf,
  allFolders,
  findFolder,
  knownFolders,
  tagsInUse,
  tagsOf,
  propertyValues,
  safeName,
  uniquePath,
  ensureFolder,
  isoDate,
  longDate,
  isoWeek,
  TFile,
};
