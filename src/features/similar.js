/*
 * Duplicate ideas: pairs of notes whose meaning is very close, checked by the
 * model, which states each note's main point and then says "same idea",
 * "related" or "unrelated" (naming the points first makes small models judge
 * better than a bare yes/no). Vault Health shows the pairs with both points so
 * you can decide; "Keep both" hides a pair for good.
 *
 * Left out: iCloud "Name 2" copies (iCloud Conflicts handles those), daily
 * notes made from one template, and pairs where one note links to the other.
 */

import { TFile } from "obsidian";
import { S, clip } from "../engine";
import { noteText } from "../vault";

const INSTRUCTIONS = `You compare two notes from someone's knowledge base and decide how they relate.
"same idea" means both notes make the same main point, even in different words, so one could be merged into the other without losing anything.
"related" means the same topic but a different main point.
"unrelated" means different topics.`;

const base = (p) => p.split("/").pop().replace(/\.md$/, "");
const isDaily = (p) => /^\d{4}-\d{2}-\d{2}/.test(base(p));
const isCopy = (a, b) => base(a).replace(/ \d+$/, "") === base(b).replace(/ \d+$/, "");
const pairKey = (a, b) => [a, b].sort().join("|");

function linked(app, a, b) {
  const links = app.metadataCache.resolvedLinks;
  return !!((links[a] && links[a][b]) || (links[b] && links[b][a]));
}

async function duplicates(plugin, { onProgress, signal } = {}) {
  const index = plugin.index;
  const app = plugin.app;
  if (!index.ready || index.size < 2) return [];
  const s = plugin.settings;
  const dismissed = new Set(s.duplicateDismissed || []);
  const pairs = index
    .pairs(s.duplicateThreshold, 60)
    .filter((x) => !isDaily(x.a) && !isDaily(x.b) && !isCopy(x.a, x.b) && !dismissed.has(pairKey(x.a, x.b)) && !linked(app, x.a, x.b))
    .slice(0, 20);
  const cache = (s.duplicateCache = s.duplicateCache || {});
  const out = [];
  let checked = 0;
  for (const pair of pairs) {
    if (signal && signal.aborted) break;
    const a = app.vault.getAbstractFileByPath(pair.a);
    const b = app.vault.getAbstractFileByPath(pair.b);
    if (!(a instanceof TFile) || !(b instanceof TFile)) continue;
    const key = `${a.path}|${a.stat.mtime}|${b.path}|${b.stat.mtime}`;
    let verdict = cache[key];
    if (!verdict) {
      try {
        const [ta, tb] = await Promise.all([noteText(app, a), noteText(app, b)]);
        verdict = await plugin.engine.generate({
          instructions: INSTRUCTIONS,
          prompt: `Note A — ${a.basename}:\n${clip(ta, 2200)}\n\nNote B — ${b.basename}:\n${clip(tb, 2200)}`,
          schema: S.object({
            pointA: S.string("The main point of note A, in under 12 words"),
            pointB: S.string("The main point of note B, in under 12 words"),
            verdict: S.oneOf(["same idea", "related", "unrelated"]),
          }),
          temperature: 0,
          signal,
        });
        cache[key] = verdict;
      } catch (e) {
        if (e.code === "unavailable" || e.code === "cancelled") break;
        continue;
      }
    }
    checked++;
    if (onProgress) onProgress(checked, pairs.length);
    if (verdict.verdict === "same idea") out.push({ a: a.path, b: b.path, score: pair.score, pointA: verdict.pointA, pointB: verdict.pointB });
  }
  // Forget verdicts for notes that changed or are gone.
  for (const k of Object.keys(cache)) {
    const [pa, ma, pb, mb] = k.split("|");
    const fa = app.vault.getAbstractFileByPath(pa);
    const fb = app.vault.getAbstractFileByPath(pb);
    if (!fa || !fb || String(fa.stat.mtime) !== ma || String(fb.stat.mtime) !== mb) delete cache[k];
  }
  plugin.saveSettings();
  return out;
}

function keepBoth(plugin, a, b) {
  const list = (plugin.settings.duplicateDismissed = plugin.settings.duplicateDismissed || []);
  const k = pairKey(a, b);
  if (!list.includes(k)) list.push(k);
  plugin.saveSettings();
}

export { duplicates, keepBoth };
