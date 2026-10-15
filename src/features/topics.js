/*
 * Smart Folders by topic: "About: dynamic programming".
 *
 *  1. The model writes a short sample note about the topic — a phrase alone
 *     embeds poorly, a note uses the words real notes would.
 *  2. Candidates: the notes closest in meaning to that sample, plus notes that
 *     share several of its key words (meaning alone misses terse notes).
 *  3. The model sees all the candidates at once and picks the ones whose main
 *     subject is the topic — comparing helps it tell "about" from "mentions".
 *
 * Results are cached per topic until a candidate note changes.
 */

import { TFile } from "obsidian";
import { S } from "../engine";
import { noteText } from "../vault";

const SAMPLE_INSTRUCTIONS = "Write a short note, three or four plain sentences, of the kind someone might keep in their notes about the given topic. Mention the key ideas and the words someone would use for it.";
const PICK_INSTRUCTIONS = "You sort notes into a folder about one topic. From the list, choose every note whose main subject is the topic — the folder a note is in can tell you its project. Leave out notes that are about something else, even if they are similar or mention the topic in passing.";

const BY_MEANING = 20;
const BY_WORDS = 8;
const PREVIEW = 220;
const STOP = new Set("about above after again against because before being below between could doing during each from further having here into itself more most other ought over same should some such than that their them then there these they this those through under until very were what when where which while whom why with would your yours using used uses also just like make makes made keep notes note someone things thing ideas idea words".split(" "));

const samples = new Map();

async function sampleNote(plugin, topic) {
  const key = topic.toLowerCase();
  if (!samples.has(key)) {
    const text = await plugin.engine.generate({ instructions: SAMPLE_INSTRUCTIONS, prompt: `Topic: ${topic}`, temperature: 0.2 });
    samples.set(key, String(text || ""));
  }
  return samples.get(key);
}

function keywords(topic, sample) {
  const words = `${topic} ${sample}`.toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

async function notesAbout(plugin, topic, { onProgress, signal } = {}) {
  topic = String(topic || "").trim();
  const index = plugin.index;
  if (!topic || !index.ready || !index.size) return null;
  const app = plugin.app;

  const sample = await sampleNote(plugin, topic);
  const near = index.nearest(await index.embedText(`${topic}\n${sample}`), { k: BY_MEANING, min: plugin.settings.topicThreshold });
  const candidates = new Map(near.map((n) => [n.path, n.score]));

  // Notes sharing several key words with the sample.
  const keys = keywords(topic, sample);
  const texts = new Map();
  const lexical = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (index.excluded(f)) continue;
    const text = await noteText(app, f);
    texts.set(f.path, text);
    if (candidates.has(f.path)) continue;
    const lower = `${f.basename} ${text}`.toLowerCase();
    const hits = keys.filter((k) => lower.includes(k)).length;
    if (hits >= 2) lexical.push({ path: f.path, hits });
  }
  lexical.sort((a, b) => b.hits - a.hits);
  for (const l of lexical.slice(0, BY_WORDS)) candidates.set(l.path, 0);
  if (signal && signal.aborted) return null;

  // Reuse the answer if none of the candidates changed.
  const cache = (plugin.settings.topicCache = plugin.settings.topicCache || {});
  const key = topic.toLowerCase();
  const stamp = [...candidates.keys()]
    .sort()
    .map((p) => {
      const f = app.vault.getAbstractFileByPath(p);
      return `${p}@${f ? f.stat.mtime : 0}`;
    })
    .join("|");
  if (cache[key] && cache[key].stamp === stamp) return cache[key].paths.map((p) => ({ path: p, score: candidates.get(p) || 0 }));

  const items = [...candidates.keys()]
    .map((p) => app.vault.getAbstractFileByPath(p))
    .filter((f) => f instanceof TFile)
    .map((f) => ({ path: f.path, title: f.basename, text: (texts.get(f.path) || "").replace(/^#.*\n/gm, "").replace(/\s+/g, " ").trim().slice(0, PREVIEW) }));
  if (!items.length) return [];
  // Titles must be unique for the model to pick them.
  const seen = new Map();
  for (const it of items) {
    const n = (seen.get(it.title) || 0) + 1;
    seen.set(it.title, n);
    if (n > 1) it.title = `${it.title} (${it.path.split("/").slice(-2, -1)[0] || n})`;
  }
  if (onProgress) onProgress(0, 1);
  const r = await plugin.engine.generate({
    instructions: PICK_INSTRUCTIONS,
    prompt: `Topic: ${topic}\n\nNotes (title, folder, start of the note):\n${items.map((x) => `- ${x.title} [${x.path.includes("/") ? x.path.slice(0, x.path.lastIndexOf("/")) : "/"}]: ${x.text}`).join("\n")}`,
    schema: S.object({ notes: S.list(S.oneOf(items.map((x) => x.title)), items.length, `Notes whose main subject is ${topic}`) }),
    temperature: 0,
    signal,
  });
  if (onProgress) onProgress(1, 1);
  const picked = new Set(r.notes || []);
  const paths = items.filter((x) => picked.has(x.title)).map((x) => x.path);
  cache[key] = { stamp, paths };
  plugin.saveSettings();
  return paths.map((p) => ({ path: p, score: candidates.get(p) || 0 }));
}

export { notesAbout };
