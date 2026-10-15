/*
 * The model engine: one long-running helper process (helper.swift) that talks
 * to Apple's on-device model, its text embeddings and Vision. Requests are
 * JSON lines; the model handles one request at a time, so they queue here.
 *
 * If Apple Intelligence is off or the Mac can't run it, text generation falls
 * back to a local Ollama model (JSON-schema output works there too).
 */

import { Platform } from "obsidian";
import HELPER_SOURCE from "./helper.swift";
import { fs, path, os, childProcess, http } from "./node";
const HELPER_VERSION = "v2"; // bump when helper.swift changes


// The on-device model reads about 4,000 tokens, prompt and answer together.
// Roughly 3.5 characters per token leaves room for instructions and output.
const INPUT_CHAR_BUDGET = 7000;

class Engine {
  constructor(plugin) {
    this.plugin = plugin;
    this.child = null;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map(); // id → { resolve, reject, onDelta }
    this.queue = Promise.resolve(); // serialises model requests
    this.state = { llm: "unknown", embed: "unknown", helper: "unknown", ollama: null };
    this.buffer = "";
  }

  get settings() {
    return this.plugin.settings;
  }

  /* ---------- helper process ---------- */

  helperPath() {
    return path.join(os.homedir(), "Library", "Caches", "tahoe-intelligence", `tahoe-intelligence-${HELPER_VERSION}`);
  }

  async compileHelper(bin) {
    // Without Xcode's command line tools, xcrun would ask to install them;
    // xcode-select -p asks nothing. The settings say how to install them.
    const tools = await new Promise((resolve) => childProcess.execFile("/usr/bin/xcode-select", ["-p"], (err, out) => resolve(!err && fs.existsSync(String(out).trim()))));
    if (!tools) return false;
    const dir = path.dirname(bin);
    await fs.promises.mkdir(dir, { recursive: true });
    const src = path.join(dir, "tahoe-intelligence.swift");
    await fs.promises.writeFile(src, HELPER_SOURCE);
    const sdk = await new Promise((resolve) =>
      childProcess.execFile("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], (err, out) => resolve(err ? "" : out.trim()))
    );
    return new Promise((resolve) => {
      childProcess.execFile(
        "/usr/bin/xcrun",
        ["--sdk", "macosx", "swiftc", "-O", src, "-o", bin],
        { timeout: 240000, env: Object.assign({}, process.env, sdk ? { SDKROOT: sdk } : {}) },
        (error, stdout, stderr) => {
          if (error) console.warn("Tahoe Intelligence: couldn't build the helper", stderr || error);
          resolve(!error);
        }
      );
    });
  }

  async start() {
    if (this.child) return true;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!Platform.isMacOS) {
        this.state.helper = "unsupported";
        return false;
      }
      const bin = this.helperPath();
      if (!fs.existsSync(bin)) {
        this.state.helper = "building";
        this.plugin.refreshStatus();
        const ok = await this.compileHelper(bin);
        if (!ok) {
          this.state.helper = "failed";
          this.plugin.refreshStatus();
          return false;
        }
      }
      const child = childProcess.spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", (d) => this.onData(d));
      child.stderr.on("data", (d) => console.debug("Tahoe Intelligence helper:", d.toString()));
      child.on("exit", () => {
        for (const p of this.pending.values()) p.reject(new Error("The helper stopped"));
        this.pending.clear();
        this.child = null;
        this.state.helper = "stopped";
      });
      this.child = child;
      this.state.helper = "running";
      const status = await this.request({ op: "status" });
      this.state.llm = status.llm;
      this.state.embed = status.embed;
      this.plugin.refreshStatus();
      return true;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  stop() {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch {
        // already gone
      }
    }
    this.child = null;
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // Unprompted events from the helper (e.g. "reminders-changed").
      if (msg.event && msg.id == null) {
        if (this.onEvent) this.onEvent(msg.event, msg);
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      if (msg.delta != null || msg.reset != null) {
        if (p.onDelta) p.onDelta(msg.delta != null ? msg.delta : null, msg.reset);
        continue;
      }
      if (msg.done) {
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error);
          err.code = msg.code;
          p.reject(err);
        } else p.resolve(msg);
      }
    }
  }

  request(body, { onDelta, signal } = {}) {
    if (!this.child) return Promise.reject(new Error("The helper isn't running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onDelta });
      if (signal) {
        if (signal.aborted) return reject(Object.assign(new Error("Cancelled"), { code: "cancelled" }));
        signal.addEventListener("abort", () => {
          this.child && this.child.stdin.write(JSON.stringify({ id: this.nextId++, op: "cancel", target: id }) + "\n");
          this.pending.delete(id);
          reject(Object.assign(new Error("Cancelled"), { code: "cancelled" }));
        });
      }
      this.child.stdin.write(JSON.stringify(Object.assign({ id }, body)) + "\n");
    });
  }

  // Run model calls one after another, in the order they were asked for.
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /* ---------- availability ---------- */

  get appleReady() {
    return this.state.llm === "available";
  }

  get embedReady() {
    return this.state.embed === "available" && !!this.child;
  }

  async ollamaModels() {
    if (this.state.ollama) return this.state.ollama;
    const models = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: 11434, path: "/api/tags", timeout: 1500 }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve((JSON.parse(body).models || []).map((m) => ({ name: m.name, size: m.size || 0 })));
          } catch {
            resolve([]);
          }
        });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve([]));
    });
    this.state.ollama = models;
    return models;
  }

  async ollamaModel() {
    const models = (await this.ollamaModels()).filter((m) => !/embed/i.test(m.name));
    if (this.settings.ollamaModel && models.some((m) => m.name === this.settings.ollamaModel)) return this.settings.ollamaModel;
    // A 3–8 GB general model: quick and good enough for filing and rewriting.
    const sorted = models.map((m) => ({ name: m.name, score: -Math.abs(m.size / 1e9 - 5) })).sort((a, b) => b.score - a.score);
    return sorted.length ? sorted[0].name : null;
  }

  // Which engine answers text requests right now.
  async provider() {
    await this.start();
    if (this.settings.provider !== "ollama" && this.appleReady) return { kind: "apple", label: "Apple Intelligence" };
    const model = await this.ollamaModel();
    if (model) return { kind: "ollama", label: model, model };
    if (this.appleReady) return { kind: "apple", label: "Apple Intelligence" };
    return null;
  }

  /* ---------- text generation ---------- */

  /**
   * generate({ instructions, prompt, schema?, onText?, temperature?, maxTokens?, signal? })
   * With a schema, resolves to the parsed object; otherwise to the text.
   */
  generate(opts) {
    return this.serial(async () => {
      const p = await this.provider();
      if (!p) throw Object.assign(new Error("Turn on Apple Intelligence in System Settings, or install Ollama, to use this."), { code: "unavailable" });
      if (p.kind === "ollama") return this.generateOllama(p.model, opts);
      let text = "";
      const msg = await this.request(
        {
          op: "generate",
          instructions: opts.instructions || "",
          prompt: opts.prompt,
          schema: opts.schema || undefined,
          stream: !!opts.onText && !opts.schema,
          temperature: opts.temperature != null ? opts.temperature : 0.3,
          maxTokens: opts.maxTokens || undefined,
        },
        {
          signal: opts.signal,
          onDelta: (delta, reset) => {
            text = reset != null ? reset : text + delta;
            if (opts.onText) opts.onText(text);
          },
        }
      );
      if (opts.schema) return JSON.parse(msg.json);
      return msg.text != null ? msg.text : text;
    });
  }

  generateOllama(model, opts) {
    const messages = [];
    if (opts.instructions) messages.push({ role: "system", content: opts.instructions });
    messages.push({ role: "user", content: opts.prompt });
    const body = JSON.stringify({
      model,
      messages,
      stream: !opts.schema,
      think: false,
      format: opts.schema ? toJsonSchema(opts.schema) : undefined,
      options: { temperature: opts.temperature != null ? opts.temperature : 0.3, num_predict: opts.maxTokens || undefined },
    });
    return new Promise((resolve, reject) => {
      let text = "";
      let buf = "";
      const req = http.request(
        { host: "127.0.0.1", port: 11434, path: "/api/chat", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          res.on("data", (d) => {
            buf += d.toString();
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              try {
                const m = JSON.parse(line);
                if (m.message && m.message.content) {
                  text += m.message.content;
                  if (opts.onText && !opts.schema) opts.onText(text);
                }
              } catch {
                // a partial line: the rest comes with the next chunk
              }
            }
          });
          res.on("end", () => {
            try {
              if (buf.trim()) {
                const m = JSON.parse(buf);
                if (m.message && m.message.content) text += m.message.content;
              }
              resolve(opts.schema ? JSON.parse(text) : text);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on("error", reject);
      if (opts.signal) opts.signal.addEventListener("abort", () => req.destroy(Object.assign(new Error("Cancelled"), { code: "cancelled" })));
      req.end(body);
    });
  }

  /* ---------- embeddings & images ---------- */

  async embed(texts) {
    await this.start();
    if (!this.embedReady) throw Object.assign(new Error("Text embeddings aren't available on this Mac yet"), { code: "unavailable" });
    const msg = await this.request({ op: "embed", texts });
    const bytes = Buffer.from(msg.vectors, "base64");
    const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const out = [];
    for (let i = 0; i < texts.length; i++) out.push(all.slice(i * msg.dim, (i + 1) * msg.dim));
    return out;
  }

  async describeImage(fullPath) {
    await this.start();
    return this.request({ op: "image", path: fullPath });
  }

  /* ---------- Reminders (EventKit, via the helper) ---------- */

  async remindersAccess(ask = false) {
    if (!(await this.start())) return "unavailable";
    return (await this.request({ op: ask ? "reminders.request" : "reminders.status" })).access;
  }

  async remindersFetch(list) {
    await this.start();
    return (await this.request({ op: "reminders.fetch", list })).items || [];
  }

  async calendarAccess(ask = false) {
    if (!(await this.start())) return "unavailable";
    return (await this.request({ op: ask ? "calendar.request" : "calendar.status" })).access;
  }

  async calendarEvents(from, to) {
    await this.start();
    return (await this.request({ op: "calendar.events", from, to })).events || [];
  }

  async remindersSave(list, items) {
    if (!items.length) return [];
    await this.start();
    return (await this.request({ op: "reminders.save", list, items })).ids || [];
  }
}

// The helper's schema spec → JSON Schema, for Ollama.
function toJsonSchema(spec) {
  if (spec.enum) return { type: "string", enum: spec.enum, description: spec.description };
  switch (spec.type) {
    case "object": {
      const properties = {};
      const required = [];
      for (const p of spec.properties || []) {
        properties[p.name] = Object.assign({}, toJsonSchema(p.schema || {}), p.description ? { description: p.description } : {});
        if (!p.optional) required.push(p.name);
      }
      return { type: "object", properties, required };
    }
    case "array":
      return { type: "array", items: toJsonSchema(spec.items || {}), minItems: spec.min, maxItems: spec.max };
    case "boolean":
    case "integer":
    case "number":
      return { type: spec.type };
    default:
      return { type: "string" };
  }
}

// Schema helpers, so features read clearly.
const S = {
  string: (description) => ({ type: "string", description }),
  bool: (description) => ({ type: "boolean", description }),
  oneOf: (values, description) => ({ enum: values, description }),
  list: (items, max, description) => ({ type: "array", items, min: 0, max, description }),
  object: (props) => ({
    type: "object",
    properties: Object.entries(props).map(([name, schema]) => ({ name, schema, description: schema.description })),
  }),
};

// Keep note text inside the model's window: the start of the note matters most.
function clip(text, budget = INPUT_CHAR_BUDGET) {
  if (!text) return "";
  if (text.length <= budget) return text;
  const head = text.slice(0, Math.floor(budget * 0.8));
  const tail = text.slice(-Math.floor(budget * 0.15));
  return `${head}\n…\n${tail}`;
}

export { Engine, S, clip, INPUT_CHAR_BUDGET };
