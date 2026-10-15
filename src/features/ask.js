/*
 * Ask your vault: ask a question, get an answer written only from your notes,
 * with each claim linked to the note it came from.
 *
 *  1. Find candidate notes — closest in meaning to the question, plus notes
 *     sharing its key words.
 *  2. Split them into passages and keep the ones closest to the question.
 *  3. The on-device model answers from those passages only, citing them as
 *     [1], [2]…, which become [[links]].
 *
 * Follow-up questions keep the conversation; "Save as note" files the answer.
 */

import { Modal, MarkdownRenderer, Component, Notice, TFile, setIcon } from "obsidian";
import { clip } from "../engine";
import { noteText, knownFolders, safeName, uniquePath, ensureFolder, isoDate } from "../vault";
import { aiIcon, showError } from "../ui";
import { KeywordIndex, isHub } from "../keywords";

const INSTRUCTIONS = `You answer questions about someone's own notes. Use only the numbered sources given — they are passages from the notes.
Cite the sources you use with their numbers in square brackets right after the sentence, like [1] or [2][3].
If the sources only partly answer, say what they do say (for example "Your notes don't give a date, but…"). Only if nothing in them is relevant, say "I couldn't find that in your notes." Don't use outside knowledge.
Be brief: a few sentences or a short list. Use the person's own wording where you can.`;

const STOP = new Set("what when where which who whom whose why how does did do is are was were the a an of in on at to for from with about into this that these those my me i you your our we it its and or but not be been being have has had can could should would will shall may might must there their they them than then so if write wrote written writing say said says mention mentioned tell told know knew think thought find found remember remembered note notes notebook anything something everything thing things".split(" "));
const PASSAGE = 650;
const NOTES = 10;
const PASSAGES = 6;

// "why?", "what about the second one?" lean on the previous question; new topics don't.
function isFollowUp(q) {
  return q.split(/\s+/).length <= 8 && /\b(it|its|that|this|those|these|they|them|there|more|else|why|also|what about|how about|and then|the other|same)\b/i.test(q);
}

function keywords(q) {
  return [...new Set((q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) || []).filter((w) => !STOP.has(w)).map((w) => w.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1")))];
}

// A short sample answer embeds far better than a bare question.
const samples = new Map();
async function sampleAnswer(plugin, question) {
  if (!samples.has(question)) {
    try {
      const t = await plugin.engine.generate({
        instructions: "Write two or three plain sentences that could appear in someone's notes and that answer the question. Use the words such notes would use. Don't say you don't know.",
        prompt: `Question: ${question}`,
        temperature: 0.2,
      });
      samples.set(question, String(t || ""));
    } catch {
      samples.set(question, "");
    }
  }
  return samples.get(question);
}

function passages(text) {
  const out = [];
  let cur = "";
  for (const para of text.split(/\n{2,}|\n(?=[-*+] |\d+\. |#)/)) {
    const p = para.trim();
    if (!p) continue;
    if (cur && cur.length + p.length > PASSAGE) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${p}` : p;
    while (cur.length > PASSAGE * 1.6) {
      out.push(cur.slice(0, PASSAGE));
      cur = cur.slice(PASSAGE);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const passageCache = new Map(); // hash → vector

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

async function retrieve(plugin, question, history) {
  const app = plugin.app;
  const index = plugin.index;
  const qText = history.length && isFollowUp(question) ? `${history[history.length - 1].q}\n${question}` : question;
  const sample = await sampleAnswer(plugin, qText);
  const raw = await index.embedText(`${qText}\n${sample}`);
  const qVec = index.centre(raw);

  // Candidate notes: by meaning…
  const byMeaning = index.nearest(raw, { k: NOTES, min: 0.05 });
  const cands = new Map(byMeaning.map((n) => [n.path, n.score]));
  // …and by the question's words, rarer words counting more.
  const keys = keywords(question);
  if (keys.length) {
    const kw = (plugin.keywords = plugin.keywords || new KeywordIndex(plugin));
    await kw.refresh();
    const n = kw.docs.size || 1;
    const scored = [];
    for (const [p, d] of kw.docs) {
      let sc = 0;
      for (const k of keys) {
        const hit = d.tf.get(k) || [...d.tf.keys()].some((w) => w.startsWith(k) && w.length - k.length <= 3);
        if (hit) sc += Math.log(1 + n / (kw.df.get(k) || 1));
      }
      if (sc > 0) scored.push({ path: p, sc });
    }
    scored.sort((a, b) => b.sc - a.sc);
    const top = scored[0] ? scored[0].sc : 1;
    for (const s of scored.slice(0, 8)) cands.set(s.path, Math.max(cands.get(s.path) || 0, 0.3 * (s.sc / top)));
  }

  // Original notes answer better than reviews and maps that summarise them.
  for (const p of [...cands.keys()]) if (isHub(app, p)) cands.delete(p);

  // Passages from the candidates, ranked by closeness to the question.
  const items = [];
  const toEmbed = [];
  for (const [p, noteScore] of cands) {
    const f = app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) continue;
    for (const text of passages(await noteText(app, f))) {
      const key = hash(`${f.basename}\n${text}`);
      const lower = text.toLowerCase();
      const title = f.basename.toLowerCase();
      const item = { file: f, text, noteScore, key, words: Math.min(3, keys.filter((k) => lower.includes(k)).length), title: keys.some((k) => title.includes(k)) ? 1 : 0 };
      items.push(item);
      if (!passageCache.has(key)) toEmbed.push(item);
    }
  }
  for (let i = 0; i < toEmbed.length; i += 16) {
    const batch = toEmbed.slice(i, i + 16);
    const vecs = await plugin.engine.embed(batch.map((x) => `${x.file.basename}\n${x.text}`));
    batch.forEach((x, j) => passageCache.set(x.key, vecs[j]));
  }
  // Meaning of the passage, its note, and the question's own words in it (or in the title).
  for (const it of items) it.score = 0.55 * dot(qVec, index.centre(passageCache.get(it.key))) + 0.2 * it.noteScore + 0.12 * it.words + 0.15 * it.title;
  items.sort((a, b) => b.score - a.score);
  // At most two passages per note, so answers draw on several notes.
  const picked = [];
  const perNote = new Map();
  for (const it of items) {
    const n = perNote.get(it.file.path) || 0;
    if (n >= 2) continue;
    perNote.set(it.file.path, n + 1);
    picked.push(it);
    if (picked.length >= PASSAGES) break;
  }
  return picked;
}

class AskModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.history = []; // { q, a, sources }
    this.component = new Component();
  }

  onOpen() {
    this.modalEl.addClass("tahoe-ai-sheet", "tahoe-ai-ask");
    this.component.load();
    const el = this.contentEl;
    const bar = el.createDiv({ cls: "tahoe-ai-ask-bar" });
    aiIcon(bar.createSpan({ cls: "tahoe-ai-ask-icon" }));
    this.input = bar.createEl("input", { type: "text", cls: "tahoe-ai-ask-input", attr: { placeholder: "Ask your notes…" } });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && this.input.value.trim()) {
        e.preventDefault();
        this.ask(this.input.value.trim());
      }
    });
    this.thread = el.createDiv({ cls: "tahoe-ai-ask-thread" });
    const hint = this.thread.createDiv({ cls: "tahoe-ai-ask-hint" });
    hint.createDiv({ text: "Answers come only from your notes, with links to where they came from. Everything stays on this Mac." });
    const examples = hint.createDiv({ cls: "tahoe-ai-ask-examples" });
    for (const q of ["What's due this week?", "What did I write about memoization?", "What's my plan for the midterm?"]) {
      const b = examples.createEl("button", { cls: "tahoe-ai-chip-button", text: q });
      b.addEventListener("click", () => {
        this.input.value = q;
        this.ask(q);
      });
    }
    window.setTimeout(() => this.input.focus(), 0);
  }

  onClose() {
    this.closed = true;
    this.component.unload();
    this.contentEl.empty();
  }

  async ask(question) {
    if (this.busy) return;
    this.busy = true;
    this.input.value = "";
    this.input.disabled = true;
    const hint = this.thread.querySelector(".tahoe-ai-ask-hint");
    if (hint) hint.remove();

    const turn = this.thread.createDiv({ cls: "tahoe-ai-ask-turn" });
    turn.createDiv({ cls: "tahoe-ai-ask-question", text: question });
    const card = turn.createDiv({ cls: "tahoe-ai-card tahoe-ai-ask-answer is-thinking" });
    const body = card.createDiv({ cls: "tahoe-ai-ask-text" });
    body.setText("Looking through your notes…");
    turn.scrollIntoView({ block: "end" });

    try {
      const sources = await retrieve(this.plugin, question, this.history);
      if (this.closed) return;
      if (!sources.length) throw Object.assign(new Error("I couldn't find anything about that in your notes."), { code: "empty" });
      const last = this.history[this.history.length - 1];
      const prior = last && isFollowUp(question) ? `Earlier question: ${last.q}\nEarlier answer: ${last.a.slice(0, 300)}` : "";
      const prompt = [
        prior,
        `Question: ${question}`,
        "",
        "Sources:",
        ...sources.map((s, i) => `[${i + 1}] ${s.file.basename}\n${s.text}`),
      ]
        .filter(Boolean)
        .join("\n");
      body.setText("");
      const answer = await this.plugin.engine.generate({
        instructions: `${INSTRUCTIONS}\nToday is ${isoDate()}.`,
        prompt: clip(prompt, 6200),
        temperature: 0.2,
        onText: (t) => body.setText(t),
      });
      card.removeClass("is-thinking");
      await this.renderAnswer(card, body, answer, sources);
      this.history.push({ q: question, a: answer, sources });
    } catch (e) {
      card.removeClass("is-thinking");
      if (e.code === "empty") body.setText(e.message);
      else {
        body.setText("Something went wrong.");
        showError(e);
      }
    } finally {
      this.busy = false;
      this.input.disabled = false;
      this.input.placeholder = "Ask a follow-up…";
      this.input.focus();
    }
  }

  // [1] → a link chip to the note; then the list of sources used.
  async renderAnswer(card, body, answer, sources) {
    const used = new Set();
    const linked = String(answer || "").replace(/\[(\d{1,2})\]/g, (m, n) => {
      const s = sources[Number(n) - 1];
      if (!s) return "";
      used.add(Number(n) - 1);
      return ` [[${this.app.metadataCache.fileToLinktext(s.file, "", true)}|${Number(n)}]]`;
    });
    body.empty();
    body.addClass("markdown-rendered");
    await MarkdownRenderer.render(this.app, linked, body, "", this.component);
    body.querySelectorAll("a.internal-link").forEach((a) => {
      if (/^\d+$/.test(a.textContent.trim())) a.addClass("tahoe-ai-cite");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const f = this.app.metadataCache.getFirstLinkpathDest(a.getAttribute("data-href") || "", "");
        if (f) this.app.workspace.getLeaf(false).openFile(f);
      });
    });

    const list = card.createDiv({ cls: "tahoe-ai-ask-sources" });
    const seen = new Set();
    sources.forEach((s, i) => {
      if (!used.has(i) || seen.has(s.file.path)) return;
      seen.add(s.file.path);
      const chip = list.createEl("button", { cls: "tahoe-ai-source" });
      setIcon(chip.createSpan({ cls: "tahoe-ai-source-icon" }), "file-text");
      chip.createSpan({ text: s.file.basename });
      chip.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(s.file));
    });

    if (!seen.size) return; // nothing found: nothing to copy or save
    const actions = card.createDiv({ cls: "tahoe-ai-ask-actions" });
    const copy = actions.createEl("button", { cls: "tahoe-ai-chip-button", text: "Copy" });
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(linked.trim());
      new Notice("Copied");
    });
    const save = actions.createEl("button", { cls: "tahoe-ai-chip-button", text: "Save as note" });
    save.addEventListener("click", () => this.save(linked));
  }

  async save(answer) {
    const turn = this.history[this.history.length - 1];
    const q = turn ? turn.q : "Answer";
    const inbox = knownFolders(this.app, this.plugin.settings).inbox;
    await ensureFolder(this.app, inbox);
    const path = uniquePath(this.app, inbox, safeName(q).slice(0, 60) || "Answer", "md");
    const f = await this.app.vault.create(path, `---\ntype: answer\ncreated: ${isoDate()}\n---\n**Q:** ${q}\n\n${answer.trim()}\n`);
    new Notice(`Saved “${f.basename}”`);
  }
}

function register(plugin) {
  const open = () => new AskModal(plugin).open();
  plugin.addCommand({ id: "ask-vault", name: "Ask your notes…", icon: "message-circle-question", callback: open });
  plugin.addRibbonIcon("message-circle-question", "Ask your notes", open);
}

export { register, retrieve, AskModal };
