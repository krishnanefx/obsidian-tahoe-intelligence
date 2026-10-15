/*
 * The meaning index: one vector per note from Apple's on-device text
 * embeddings. Vectors are centred on the vault's average before comparing —
 * raw embeddings make every note look alike — then compared by cosine.
 *
 * It lives in ~/Library/Caches (derived data, not synced) and updates only the
 * notes that changed.
 */

import { TFile } from "obsidian";
import { noteText } from "./vault";
import { fs, path, os } from "./node";

const BATCH = 8;
const MIN_CHARS = 40; // shorter notes don't say enough to compare

class SemanticIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.entries = new Map(); // path → { mtime, vec: Float32Array }
    this.dim = 0;
    this.queue = [];
    this.running = false;
    this.ready = false;
    this.version = 0;
    this.matrix = null; // centred, normalised vectors
    this.listeners = new Set();
    this.dirty = false;
    this.savedAt = 0;
    this.saveTimer = 0;
  }

  // ~/Library/Caches/tahoe-intelligence/index-<vault>: .bin holds the vectors
  // back to back, .meta.json the notes they belong to. (.json is the old
  // format, read once if there's no .bin yet.)
  get cacheBase() {
    const base = this.app.vault.adapter.getBasePath ? this.app.vault.adapter.getBasePath() : this.app.vault.getName();
    let h = 0;
    for (const ch of base) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return path.join(os.homedir(), "Library", "Caches", "tahoe-intelligence", `index-${h.toString(36)}`);
  }

  excluded(file) {
    const s = this.plugin.settings;
    if (file.path === (s.ocrIndexNote || "Image Text Index.md")) return true;
    if (this.app.metadataCache.isUserIgnored && this.app.metadataCache.isUserIgnored(file.path)) return true; // Settings › Files and links › Excluded files
    return (s.excludeFolders || []).some((f) => f && file.path.startsWith(f.replace(/\/$/, "") + "/"));
  }

  async load() {
    const base = this.cacheBase;
    try {
      const [meta, bin] = await Promise.all([fs.promises.readFile(`${base}.meta.json`, "utf8"), fs.promises.readFile(`${base}.bin`)]);
      const m = JSON.parse(meta);
      const all = bin.byteOffset % 4 === 0 ? new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4) : new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
      if (all.length === m.paths.length * m.dim) {
        this.dim = m.dim;
        m.paths.forEach((p, i) => this.entries.set(p, { mtime: m.mtimes[i], vec: all.subarray(i * m.dim, (i + 1) * m.dim) }));
      }
    } catch {
      try {
        const raw = JSON.parse(await fs.promises.readFile(`${base}.json`, "utf8"));
        this.dim = raw.dim;
        for (const [p, e] of Object.entries(raw.entries || {})) {
          const bytes = Buffer.from(e.v, "base64");
          this.entries.set(p, { mtime: e.m, vec: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) });
        }
        if (this.entries.size) this.saveSoon(); // in the new format
      } catch {
        // unreadable: it's rebuilt
      }
    }
    this.invalidate();
  }

  // Saving rewrites the whole index (10 MB for 5,000 notes), so it waits for
  // a quiet moment and happens at most once a minute; quitting saves the rest.
  saveSoon() {
    this.dirty = true;
    if (this.saveTimer) return;
    const wait = Math.max(5000, 60000 - (Date.now() - this.savedAt));
    this.saveTimer = window.setTimeout(() => {
      const go = () => {
        this.saveTimer = 0;
        this.save().catch((e) => console.warn("Tahoe Intelligence: couldn't save the index", e));
      };
      if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 15000 });
      else go();
    }, wait);
  }

  packed() {
    const paths = [...this.entries.keys()];
    const dim = this.dim;
    const all = new Float32Array(paths.length * dim);
    const mtimes = paths.map((p, i) => {
      const e = this.entries.get(p);
      all.set(e.vec, i * dim);
      return e.mtime;
    });
    this.dirty = false;
    this.savedAt = Date.now();
    return { meta: JSON.stringify({ version: 2, dim, paths, mtimes }), bin: Buffer.from(all.buffer) };
  }

  // Written beside and then moved into place, so a crash never leaves half an index.
  async save() {
    if (!this.dim) return;
    const base = this.cacheBase;
    const { meta, bin } = this.packed();
    await fs.promises.mkdir(path.dirname(base), { recursive: true });
    await fs.promises.writeFile(`${base}.bin.tmp`, bin);
    await fs.promises.writeFile(`${base}.meta.json.tmp`, meta);
    await fs.promises.rename(`${base}.bin.tmp`, `${base}.bin`);
    await fs.promises.rename(`${base}.meta.json.tmp`, `${base}.meta.json`);
  }

  // On quit: anything not saved yet, before the window goes.
  saveNow() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (!this.dirty || !this.dim) return;
    try {
      const base = this.cacheBase;
      const { meta, bin } = this.packed();
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.writeFileSync(`${base}.bin.tmp`, bin);
      fs.writeFileSync(`${base}.meta.json.tmp`, meta);
      fs.renameSync(`${base}.bin.tmp`, `${base}.bin`);
      fs.renameSync(`${base}.meta.json.tmp`, `${base}.meta.json`);
    } catch (e) {
      console.warn("Tahoe Intelligence: couldn't save the index", e);
    }
  }

  start() {
    const app = this.app;
    const p = this.plugin;
    p.registerEvent(app.vault.on("modify", (f) => f instanceof TFile && f.extension === "md" && this.enqueueSoon(f)));
    p.registerEvent(app.vault.on("create", (f) => f instanceof TFile && f.extension === "md" && this.enqueueSoon(f)));
    p.registerEvent(
      app.vault.on("rename", (f, old) => {
        const e = this.entries.get(old);
        if (e) {
          this.entries.delete(old);
          this.entries.set(f.path, e);
          this.invalidate();
          this.saveSoon();
        }
      })
    );
    p.registerEvent(
      app.vault.on("delete", (f) => {
        if (this.entries.delete(f.path)) {
          this.invalidate();
          this.saveSoon();
        }
      })
    );
    this.scan();
  }

  enqueueSoon(file) {
    if (!this.pendingTimers) this.pendingTimers = new Map();
    window.clearTimeout(this.pendingTimers.get(file.path));
    this.pendingTimers.set(
      file.path,
      window.setTimeout(() => {
        this.pendingTimers.delete(file.path);
        this.enqueue(file);
      }, 5000)
    );
  }

  scan() {
    const files = this.app.vault.getMarkdownFiles();
    const keep = new Set(files.filter((f) => !this.excluded(f)).map((f) => f.path));
    for (const p of [...this.entries.keys()]) {
      if (keep.has(p) || !this.entries.delete(p)) continue;
      this.invalidate();
      this.saveSoon();
    }
    for (const f of files) {
      const e = this.entries.get(f.path);
      if (!this.excluded(f) && (!e || e.mtime !== f.stat.mtime)) this.queue.push(f.path);
    }
    this.total = this.queue.length;
    this.pump();
  }

  enqueue(file) {
    if (this.excluded(file) || this.queue.includes(file.path)) return;
    this.queue.push(file.path);
    this.total = Math.max(this.total || 0, this.queue.length);
    this.pump();
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, BATCH);
        const files = [];
        const texts = [];
        for (const p of batch) {
          const f = this.app.vault.getAbstractFileByPath(p);
          if (!(f instanceof TFile)) continue;
          const body = await noteText(this.app, f);
          if (body.length < MIN_CHARS) {
            if (this.entries.delete(p)) this.invalidate();
            continue;
          }
          files.push(f);
          texts.push(`${f.basename}\n${body}`);
        }
        if (texts.length) {
          const vecs = await this.plugin.engine.embed(texts);
          files.forEach((f, i) => this.entries.set(f.path, { mtime: f.stat.mtime, vec: vecs[i] }));
          this.dim = vecs[0].length;
          this.invalidate();
          this.saveSoon();
        }
        this.plugin.refreshStatus();
        await new Promise((r) => window.setTimeout(r, 30)); // stay out of the way while typing
      }
    } catch (e) {
      console.warn("Tahoe Intelligence: indexing stopped", e);
    } finally {
      this.running = false;
      this.total = 0;
      if (!this.ready) {
        this.ready = true;
      }
      this.plugin.refreshStatus();
      this.emit();
    }
  }

  get progress() {
    if (!this.running || !this.total) return null;
    return { done: this.total - this.queue.length, total: this.total };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // one listener's error doesn't stop the others
      }
    }
  }

  invalidate() {
    this.matrix = null;
    this.version++;
  }

  // Centre on the vault's mean and normalise, once per change.
  build() {
    if (this.matrix) return this.matrix;
    const paths = [...this.entries.keys()];
    const dim = this.dim;
    const mean = new Float32Array(dim);
    for (const p of paths) {
      const v = this.entries.get(p).vec;
      for (let i = 0; i < dim; i++) mean[i] += v[i];
    }
    for (let i = 0; i < dim; i++) mean[i] /= Math.max(paths.length, 1);
    const data = new Float32Array(paths.length * dim);
    paths.forEach((p, row) => {
      const v = this.entries.get(p).vec;
      let n = 0;
      for (let i = 0; i < dim; i++) {
        const x = v[i] - mean[i];
        data[row * dim + i] = x;
        n += x * x;
      }
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < dim; i++) data[row * dim + i] /= n;
    });
    this.matrix = { paths, data, mean, dim, row: new Map(paths.map((p, i) => [p, i])) };
    return this.matrix;
  }

  centre(vec) {
    const m = this.build();
    const out = new Float32Array(m.dim);
    let n = 0;
    for (let i = 0; i < m.dim; i++) {
      out[i] = vec[i] - m.mean[i];
      n += out[i] * out[i];
    }
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < m.dim; i++) out[i] /= n;
    return out;
  }

  // Notes closest to a (raw) vector.
  nearest(vec, { k = 10, exclude = new Set(), min = -1 } = {}) {
    const m = this.build();
    if (!m.paths.length) return [];
    const q = this.centre(vec);
    const scored = [];
    for (let r = 0; r < m.paths.length; r++) {
      if (exclude.has(m.paths[r])) continue;
      let s = 0;
      const off = r * m.dim;
      for (let i = 0; i < m.dim; i++) s += q[i] * m.data[off + i];
      if (s >= min) scored.push({ path: m.paths[r], score: s });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }

  vectorOf(filePath) {
    const e = this.entries.get(filePath);
    return e ? e.vec : null;
  }

  similarTo(filePath, opts = {}) {
    const v = this.vectorOf(filePath);
    if (!v) return [];
    const exclude = new Set(opts.exclude || []);
    exclude.add(filePath);
    return this.nearest(v, Object.assign({}, opts, { exclude }));
  }

  async embedText(text) {
    return (await this.plugin.engine.embed([text]))[0];
  }

  // Every pair of notes above a similarity, most similar first.
  pairs(min, limit = 60) {
    const m = this.build();
    const out = [];
    const n = m.paths.length;
    for (let a = 0; a < n; a++) {
      const oa = a * m.dim;
      for (let b = a + 1; b < n; b++) {
        const ob = b * m.dim;
        let s = 0;
        for (let i = 0; i < m.dim; i++) s += m.data[oa + i] * m.data[ob + i];
        if (s >= min) out.push({ a: m.paths[a], b: m.paths[b], score: s });
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit);
  }

  get size() {
    return this.entries.size;
  }
}

export { SemanticIndex };
