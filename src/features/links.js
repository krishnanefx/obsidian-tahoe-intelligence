/*
 * Link suggestions by meaning. When you pause after writing a paragraph, its
 * meaning is compared with every note; if one is close, a quiet chip appears
 * at the end of the paragraph — "✦ Knapsack". Click it to add [[Knapsack]].
 * Notes already linked from this note are never suggested.
 */

import { editorInfoField, TFile } from "obsidian";
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { aiIcon } from "../ui";

const PAUSE_MS = 1300;
const MIN_CHARS = 70;
const setSuggestions = StateEffect.define();
const dismissed = new Set(); // "note|paragraph hash"

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

// The paragraph around a position: neighbouring non-blank lines, outside code.
function paragraphAt(state, pos) {
  const doc = state.doc;
  let line = doc.lineAt(pos);
  if (!line.text.trim()) return null;
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);
  for (let n = node; n; n = n.parent) {
    if (/codeblock|frontmatter|math|hmd-codeblock|comment/i.test(n.type.name)) return null;
  }
  let first = line.number;
  let last = line.number;
  const isText = (l) => {
    const t = doc.line(l).text;
    return t.trim() && !/^\s*(```|~~~|---\s*$|#{1,6}\s|\|)/.test(t);
  };
  if (!isText(first)) return null;
  while (first > 1 && isText(first - 1)) first--;
  while (last < doc.lines && isText(last + 1)) last++;
  const from = doc.line(first).from;
  const to = doc.line(last).to;
  return { from, to, text: doc.sliceString(from, to) };
}

class ChipWidget extends WidgetType {
  constructor(items, onPick, onDismiss) {
    super();
    this.items = items;
    this.onPick = onPick;
    this.onDismiss = onDismiss;
  }

  eq(other) {
    return other.items.map((i) => i.path).join() === this.items.map((i) => i.path).join();
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "tahoe-ai-related";
    wrap.setAttribute("contenteditable", "false");
    aiIcon(wrap.createSpan({ cls: "tahoe-ai-related-icon" }));
    for (const item of this.items) {
      const chip = wrap.createSpan({ cls: "tahoe-ai-related-chip", text: item.title, attr: { "aria-label": `Related note — click to link [[${item.title}]]` } });
      chip.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onPick(item);
      });
    }
    const x = wrap.createSpan({ cls: "tahoe-ai-related-dismiss", text: "×", attr: { "aria-label": "Hide suggestion" } });
    x.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onDismiss();
    });
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

function linkSuggestions(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.decorations = Decoration.none;
        this.timer = 0;
        this.current = null; // { from, to, key, items }
        this.cache = new Map(); // paragraph hash → items
      }

      update(update) {
        for (const tr of update.transactions) {
          for (const e of tr.effects) if (e.is(setSuggestions)) this.decorations = e.value;
        }
        if (update.docChanged || update.selectionSet) {
          // Typing or moving: hide chips (unless the cursor is still in the paragraph and nothing changed), then look again after a pause.
          if (update.docChanged && this.decorations !== Decoration.none) this.decorations = Decoration.none;
          if (update.selectionSet && this.current) {
            const head = update.state.selection.main.head;
            if (head < this.current.from || head > this.current.to + 1) this.decorations = Decoration.none;
          }
          window.clearTimeout(this.timer);
          if (this.idle && window.cancelIdleCallback) window.cancelIdleCallback(this.idle);
          // After a pause, and then only when nothing else needs the main thread.
          this.timer = window.setTimeout(() => {
            this.idle = window.requestIdleCallback ? window.requestIdleCallback(() => this.check(), { timeout: 3000 }) : (this.check(), 0);
          }, PAUSE_MS);
        }
      }

      destroy() {
        window.clearTimeout(this.timer);
        if (this.idle && window.cancelIdleCallback) window.cancelIdleCallback(this.idle);
      }

      async check() {
        const view = this.view;
        if (!plugin.settings.features.links || !plugin.index.ready || !plugin.index.size) return;
        const info = view.state.field(editorInfoField, false);
        const file = info && info.file;
        if (!file) return;
        const sel = view.state.selection.main;
        if (!sel.empty) return;
        const para = paragraphAt(view.state, sel.head);
        if (!para || para.text.length < MIN_CHARS) return;
        const key = `${file.path}|${hash(para.text)}`;
        if (dismissed.has(key)) return;

        let items = this.cache.get(key);
        if (!items) {
          let vec;
          try {
            vec = await plugin.index.embedText(para.text);
          } catch {
            return;
          }
          // Skip this note and anything it already links to.
          const exclude = new Set([file.path]);
          const links = plugin.app.metadataCache.resolvedLinks[file.path] || {};
          for (const p of Object.keys(links)) exclude.add(p);
          const near = plugin.index.nearest(vec, { k: 3, exclude, min: plugin.settings.linkThreshold });
          items = near
            .slice(0, plugin.settings.linkMax || 2)
            .map((n) => ({ path: n.path, score: n.score, title: n.path.split("/").pop().replace(/\.md$/, "") }));
          this.cache.set(key, items);
        }
        // The paragraph may have changed while we were thinking.
        const now = paragraphAt(view.state, view.state.selection.main.head);
        if (!now || now.from !== para.from || now.text !== para.text || !items.length) return;

        this.current = { from: para.from, to: para.to, key, items };
        const widget = new ChipWidget(
          items,
          (item) => this.pick(item),
          () => {
            dismissed.add(key);
            view.dispatch({ effects: setSuggestions.of(Decoration.none) });
          }
        );
        view.dispatch({ effects: setSuggestions.of(Decoration.set([Decoration.widget({ widget, side: 1 }).range(para.to)])) });
      }

      pick(item) {
        const view = this.view;
        const cur = this.current;
        if (!cur) return;
        const info = view.state.field(editorInfoField, false);
        const target = plugin.app.vault.getAbstractFileByPath(item.path);
        if (!(target instanceof TFile)) return;
        const linktext = plugin.app.metadataCache.fileToLinktext(target, info && info.file ? info.file.path : "", true);
        const end = view.state.doc.lineAt(Math.min(cur.to, view.state.doc.length)).to;
        const before = view.state.doc.sliceString(end - 1, end);
        const insert = `${/\s/.test(before) ? "" : " "}[[${linktext}]]`;
        view.dispatch({
          changes: { from: end, insert },
          effects: setSuggestions.of(Decoration.none),
          userEvent: "input.link",
        });
        dismissed.add(cur.key);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

function register(plugin) {
  plugin.registerEditorExtension(linkSuggestions(plugin));
}

export { register, paragraphAt };
