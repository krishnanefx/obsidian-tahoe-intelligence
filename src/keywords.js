/*
 * Distinctive words, to go with the meaning index: each note's words weighted
 * by how rare they are in the vault (tf-idf). Meaning alone struggles with
 * short notes and formulas; shared rare words ("knapsack", "memoization")
 * are a strong, cheap signal. Built in memory from Obsidian's cached reads.
 */

import { TFile } from "obsidian";
import { noteText } from "./vault";

const STOP = new Set(
  "about above after again against also although always among another anything around because before being below between both cannot could does doing down during each either else enough even every from further have having here into itself just like many might more most much must neither never next often only other otherwise ought over same should since some such than that their them then there these they thing things this those though through thus under until upon very what when where whether which while with within without would your yours yourself been were will shall make makes made using used uses note notes"
    .split(" ")
);

function terms(text) {
  const words = (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'-]{3,}/gu) || []).map((w) => w.replace(/'s$/, "").replace(/(ies)$/, "y").replace(/([^s])s$/, "$1"));
  const tf = new Map();
  for (const w of words) if (!STOP.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
  return tf;
}

class KeywordIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.docs = new Map(); // path → { mtime, tf: Map }
    this.df = new Map();
    this.dirty = true;
  }

  async refresh() {
    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.plugin.index.excluded(f));
    const live = new Set(files.map((f) => f.path));
    let changed = false;
    for (const p of [...this.docs.keys()]) {
      if (live.has(p)) continue;
      this.docs.delete(p);
      changed = true;
    }
    for (const f of files) {
      const d = this.docs.get(f.path);
      if (d && d.mtime === f.stat.mtime) continue;
      this.docs.set(f.path, { mtime: f.stat.mtime, tf: terms(`${f.basename} ${f.basename} ${await noteText(this.app, f)}`) });
      changed = true;
    }
    if (changed || this.dirty) {
      this.df = new Map();
      for (const d of this.docs.values()) for (const w of d.tf.keys()) this.df.set(w, (this.df.get(w) || 0) + 1);
      this.vectors = new Map();
      this.dirty = false;
    }
  }

  // Unit tf-idf vector for a note (words that appear in only one note carry no link).
  vector(path) {
    if (this.vectors.has(path)) return this.vectors.get(path);
    const d = this.docs.get(path);
    if (!d) return null;
    const n = this.docs.size;
    const v = new Map();
    let norm = 0;
    for (const [w, c] of d.tf) {
      const df = this.df.get(w) || 1;
      if (df < 2 || df > n * 0.5) continue;
      const x = (1 + Math.log(c)) * Math.log(n / df);
      v.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    this.vectors.set(path, v);
    return v;
  }

  similar(path, k = 30) {
    const q = this.vector(path);
    if (!q || !q.size) return [];
    const out = [];
    for (const p of this.docs.keys()) {
      if (p === path) continue;
      const v = this.vector(p);
      if (!v || !v.size) continue;
      let s = 0;
      const [small, big] = q.size < v.size ? [q, v] : [v, q];
      for (const [w, x] of small) {
        const y = big.get(w);
        if (y) s += x * y;
      }
      if (s > 0) out.push({ path: p, score: s });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

// Notes that gather everything (reviews, maps, daily notes, generated indexes)
// are related to all notes, so they're left out.
function isHub(app, path) {
  const name = path.split("/").pop().replace(/\.md$/, "");
  if (/^\d{4}-\d{2}-\d{2}/.test(name) || /^(weekly review|map of )/i.test(name)) return true;
  const f = app.vault.getAbstractFileByPath(path);
  const fm = f instanceof TFile ? (app.metadataCache.getFileCache(f) || {}).frontmatter || {} : {};
  return ["review", "moc", "answer", "daily"].includes(String(fm.type || "").toLowerCase()) || !!fm["tahoe-generated"];
}

// Meaning + distinctive words. Returns [{ path, score }], best first.
async function hybridRelated(plugin, file, { k = 12, min = 0.12 } = {}) {
  const kw = (plugin.keywords = plugin.keywords || new KeywordIndex(plugin));
  await kw.refresh();
  const byMeaning = plugin.index.ready ? plugin.index.similarTo(file.path, { k: 30 }) : [];
  const byWords = kw.similar(file.path, 30);
  const scores = new Map();
  for (const m of byMeaning) scores.set(m.path, { meaning: Math.max(0, m.score), words: 0 });
  for (const w of byWords) {
    const s = scores.get(w.path) || { meaning: 0, words: 0 };
    s.words = w.score;
    scores.set(w.path, s);
  }
  // Notes found only by words still need some meaning score to compare fairly.
  for (const [p, s] of scores) if (!s.meaning && plugin.index.vectorOf(p) && plugin.index.vectorOf(file.path)) {
    const m = plugin.index.build();
    const a = m.row.get(file.path);
    const b = m.row.get(p);
    if (a != null && b != null) {
      let d = 0;
      for (let i = 0; i < m.dim; i++) d += m.data[a * m.dim + i] * m.data[b * m.dim + i];
      s.meaning = Math.max(0, d);
    }
  }
  return [...scores.entries()]
    .filter(([path]) => !isHub(plugin.app, path))
    .map(([path, s]) => ({ path, score: 0.5 * s.meaning + 0.5 * Math.min(1, s.words * 1.6) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export { KeywordIndex, hybridRelated, terms, isHub };
