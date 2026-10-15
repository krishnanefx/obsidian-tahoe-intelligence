/*
 * Writing help in the editor: Proofread, Rewrite (and
 * Friendly / Professional / Concise), Summary, Key Points, List, Table.
 * Select text, then use the ✦ button by the selection, the right-click menu
 * or the command palette. The result opens in a sheet — Proofread shows each
 * change — and you choose Replace, Insert Below or Copy.
 */

import { Modal, Notice, Menu, MarkdownRenderer, Component, MarkdownView, Platform } from "obsidian";
import { ViewPlugin } from "@codemirror/view";
import { clip } from "../engine";
import { aiIcon, wordDiff, renderDiff, showError } from "../ui";

const KEEP = "Keep Markdown, [[links]], #tags, `code` and line breaks exactly as they are. Reply with the new text only — no preamble, no quotes.";

const TOOLS = [
  { id: "proofread", name: "Proofread", icon: "check-check", diff: true, prompt: `Proofread the text. Correct every spelling mistake, grammar mistake (verb agreement and tense, like "we was" → "we were", articles, plurals, wrong words like "their"/"there" or "should of") and punctuation mistake. Keep everything else — wording, tone, meaning — the same. ${KEEP}` },
  { id: "rewrite", name: "Rewrite", icon: "pen-line", prompt: `Rewrite the text so it reads more clearly, keeping its meaning and the author's voice. ${KEEP}` },
  { id: "friendly", name: "Friendly", icon: "smile", group: "rewrite", prompt: `Rewrite the text in a warmer, friendlier tone, keeping its meaning. ${KEEP}` },
  { id: "professional", name: "Professional", icon: "briefcase", group: "rewrite", prompt: `Rewrite the text in a clear, professional tone, keeping its meaning. ${KEEP}` },
  { id: "concise", name: "Concise", icon: "scissors", group: "rewrite", prompt: `Make the text shorter and tighter without losing anything important. ${KEEP}` },
  { id: "summary", name: "Summary", icon: "align-left", sep: true, insert: true, prompt: "Summarize the text in two or three sentences. Reply with the summary only." },
  { id: "keypoints", name: "Key points", icon: "list", insert: true, prompt: "List the key points of the text as a short Markdown bullet list. Reply with the list only." },
  { id: "list", name: "List", icon: "list-checks", prompt: `Turn the text into a Markdown bullet list, one item per idea. ${KEEP}` },
  { id: "table", name: "Table", icon: "table", prompt: "Turn the text into a Markdown table with a header row. Reply with the table only." },
];

// What to work on: the selection, or the paragraph the cursor is in.
function target(editor) {
  let from = editor.getCursor("from");
  let to = editor.getCursor("to");
  let text = editor.getRange(from, to);
  if (!text.trim()) {
    const line = from.line;
    let a = line;
    let b = line;
    while (a > 0 && editor.getLine(a - 1).trim()) a--;
    while (b < editor.lastLine() && editor.getLine(b + 1).trim()) b++;
    from = { line: a, ch: 0 };
    to = { line: b, ch: editor.getLine(b).length };
    text = editor.getRange(from, to);
  }
  return text.trim() ? { from, to, text } : null;
}

class WritingSheet extends Modal {
  constructor(plugin, editor, tool, t) {
    super(plugin.app);
    this.plugin = plugin;
    this.editor = editor;
    this.tool = tool;
    this.t = t;
    this.result = "";
    this.component = new Component();
  }

  onOpen() {
    this.modalEl.addClass("tahoe-ai-sheet", "tahoe-ai-writing");
    this.component.load();
    this.scope.register(["Mod"], "Enter", () => (this.replace(), false));
    this.run();
  }

  onClose() {
    if (this.abort) this.abort.abort();
    this.component.unload();
    this.contentEl.empty();
  }

  header() {
    const head = this.titleEl;
    head.empty();
    aiIcon(head.createSpan({ cls: "tahoe-ai-title-icon" }));
    head.createSpan({ text: this.tool.name });
  }

  async run() {
    this.header();
    const el = this.contentEl;
    el.empty();
    this.box = el.createDiv({ cls: "tahoe-ai-card tahoe-ai-result is-thinking" });
    this.out = this.box.createDiv({ cls: "tahoe-ai-result-text" });
    this.out.setText("");
    this.footer();
    this.abort = new AbortController();
    try {
      const text = await this.plugin.engine.generate({
        instructions: this.tool.prompt,
        prompt: `Text:\n${clip(this.t.text, 6000)}`,
        temperature: this.tool.id === "proofread" ? 0 : 0.5,
        signal: this.abort.signal,
        onText: (partial) => {
          this.out.setText(partial);
        },
      });
      this.result = tidy(text, this.t.text);
      this.box.removeClass("is-thinking");
      await this.show();
      this.updateButtons();
      (this.tool.insert ? this.insertBtn : this.replaceBtn).focus();
    } catch (e) {
      if (e.code === "cancelled") return;
      this.close();
      showError(e);
    }
    this.updateButtons();
  }

  async show() {
    this.out.empty();
    if (this.tool.diff) {
      const changes = renderDiff(this.out, wordDiff(this.t.text, this.result));
      this.out.addClass("is-diff");
      this.status.setText(changes ? `${changes} ${changes === 1 ? "change" : "changes"}` : "No changes needed");
    } else {
      this.out.removeClass("is-diff");
      this.out.addClass("markdown-rendered");
      await MarkdownRenderer.render(this.app, this.result, this.out, this.app.workspace.getActiveFile()?.path || "", this.component);
      this.status.setText("");
    }
  }

  footer() {
    const footer = this.contentEl.createDiv({ cls: "tahoe-ai-footer" });
    const left = footer.createDiv({ cls: "tahoe-ai-footer-meta" });
    const other = left.createEl("button", { cls: "tahoe-ai-tool-switch", text: "Other tools" });
    other.addEventListener("click", (e) => {
      const menu = new Menu();
      for (const tool of TOOLS) {
        if (tool.sep) menu.addSeparator();
        menu.addItem((i) => i.setTitle(tool.name).setIcon(tool.icon).setChecked(tool.id === this.tool.id).onClick(() => {
          this.tool = tool;
          this.run();
        }));
      }
      menu.showAtMouseEvent(e);
    });
    this.status = left.createSpan({ cls: "tahoe-ai-footer-status" });
    const buttons = footer.createDiv({ cls: "modal-button-container" });
    this.copyBtn = buttons.createEl("button", { text: "Copy" });
    this.copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(this.result);
      new Notice("Copied");
    });
    this.insertBtn = buttons.createEl("button", { text: "Insert below" });
    this.insertBtn.addEventListener("click", () => this.insertBelow());
    this.replaceBtn = buttons.createEl("button", { cls: "mod-cta", text: "Replace" });
    this.replaceBtn.addEventListener("click", () => this.replace());
    this.updateButtons();
  }

  updateButtons() {
    const ready = !!this.result;
    for (const b of [this.copyBtn, this.insertBtn, this.replaceBtn]) if (b) b.disabled = !ready;
    if (this.replaceBtn && this.insertBtn && this.tool.insert) {
      // Summaries and key points usually go next to the text, not over it.
      this.insertBtn.addClass("mod-cta");
      this.replaceBtn.removeClass("mod-cta");
    } else if (this.replaceBtn && this.insertBtn) {
      this.insertBtn.removeClass("mod-cta");
      this.replaceBtn.addClass("mod-cta");
    }
  }

  stillThere() {
    return this.editor.getRange(this.t.from, this.t.to) === this.t.text;
  }

  replace() {
    if (!this.result) return;
    if (!this.stillThere()) return new Notice("The text changed while you were away — copy the result instead");
    this.editor.replaceRange(this.result, this.t.from, this.t.to);
    this.close();
  }

  insertBelow() {
    if (!this.result) return;
    const end = this.t.to;
    this.editor.replaceRange(`\n\n${this.result}`, end, end);
    this.close();
  }
}

// Models sometimes wrap answers in quotes or a code fence, or add a trailing newline.
function tidy(text, original) {
  let t = String(text || "").trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence && !original.trim().startsWith("```")) t = fence[1];
  if (/^"[\s\S]*"$/.test(t) && !/^"/.test(original.trim())) t = t.slice(1, -1);
  return t;
}

function open(plugin, editor, toolId) {
  const t = target(editor);
  if (!t) return new Notice("Select some text first");
  const tool = TOOLS.find((x) => x.id === toolId) || TOOLS[0];
  new WritingSheet(plugin, editor, tool, t).open();
}

function toolsMenu(plugin, editor, menu) {
  for (const tool of TOOLS) {
    if (tool.sep) menu.addSeparator();
    menu.addItem((i) => i.setTitle(tool.name).setIcon(tool.icon).onClick(() => open(plugin, editor, tool.id)));
  }
}

// The ✦ button that appears by a selection.
function selectionButton(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.btn = document.createElement("button");
        this.btn.className = "tahoe-ai-selection-button";
        this.btn.setAttribute("aria-label", "Writing help");
        aiIcon(this.btn.createSpan());
        this.btn.addEventListener("mousedown", (e) => e.preventDefault());
        this.btn.addEventListener("click", (e) => {
          const mdView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
          if (!mdView) return;
          const menu = new Menu();
          toolsMenu(plugin, mdView.editor, menu);
          menu.showAtMouseEvent(e);
        });
        view.dom.appendChild(this.btn);
        this.onScroll = () => this.place();
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        this.hide();
      }

      update(u) {
        if (u.selectionSet || u.focusChanged || u.geometryChanged || u.docChanged || u.viewportChanged) this.place();
      }

      hide() {
        this.btn.hide();
      }

      place() {
        const view = this.view;
        const sel = view.state.selection.main;
        if (!plugin.settings.writingButton || sel.empty || sel.to - sel.from < 12 || !view.hasFocus) return this.hide();
        view.requestMeasure({
          read: () => {
            const end = view.coordsAtPos(sel.to);
            const start = view.coordsAtPos(sel.from);
            const box = view.dom.getBoundingClientRect();
            return end && start ? { end, start, box } : null;
          },
          write: (m) => {
            if (!m) return this.hide();
            // Just after the end of the selection, nudged inside the editor.
            const x = Math.min(m.end.right + 6, m.box.right - 34) - m.box.left;
            const y = m.end.top - m.box.top + (m.end.bottom - m.end.top) / 2 - 13;
            this.btn.show();
            this.btn.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
          },
        });
      }

      destroy() {
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        this.btn.remove();
      }
    }
  );
}

function register(plugin) {
  plugin.addCommand({
    id: "writing-tools",
    name: "Writing help…",
    icon: "sparkles",
    editorCallback: (editor) => {
      const menu = new Menu();
      toolsMenu(plugin, editor, menu);
      const coords = editor.cm && editor.cm.coordsAtPos(editor.cm.state.selection.main.head);
      menu.showAtPosition(coords ? { x: coords.left, y: coords.bottom + 4 } : { x: window.innerWidth / 2, y: window.innerHeight / 3 });
    },
  });
  for (const tool of TOOLS) {
    plugin.addCommand({ id: `writing-${tool.id}`, name: `Writing help: ${tool.name}`, icon: tool.icon, editorCallback: (editor) => open(plugin, editor, tool.id) });
  }
  plugin.registerEvent(
    plugin.app.workspace.on("editor-menu", (menu, editor) => {
      menu.addItem((item) => {
        item.setTitle("Writing help").setIcon("sparkles").setSection("selection");
        const sub = item.setSubmenu ? item.setSubmenu() : null;
        if (sub) toolsMenu(plugin, editor, sub);
        else item.onClick(() => open(plugin, editor, "proofread"));
      });
    })
  );
  if (!Platform.isMobile) plugin.registerEditorExtension(selectionButton(plugin));
}

export { register, TOOLS, tidy };
