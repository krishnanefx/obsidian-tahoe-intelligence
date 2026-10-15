// Shared UI: the Apple Intelligence sparkle, a word diff, alerts and errors.

import { Modal, Notice, setIcon } from "obsidian";

// A sparkle painted with Apple Intelligence's gradient (see .tahoe-ai-icon).
function aiIcon(el, icon = "sparkles") {
  el.addClass("tahoe-ai-icon");
  setIcon(el, icon);
  const svg = el.querySelector("svg");
  if (svg) {
    const markup = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, "black");
    el.style.setProperty("--tahoe-ai-glyph", `url("data:image/svg+xml,${encodeURIComponent(markup)}")`);
  }
  return el;
}

// Word-level diff (LCS over words and whitespace), for Proofread.
function wordDiff(a, b) {
  const tok = (s) => s.match(/\s+|[^\s]+/g) || [];
  const x = tok(a);
  const y = tok(b);
  // Long texts: fall back to "everything changed" rather than an n² table.
  if (x.length * y.length > 4e6) return [{ type: "del", text: a }, { type: "add", text: b }];
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push("same", x[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", x[i++]);
    else push("add", y[j++]);
  }
  while (i < n) push("del", x[i++]);
  while (j < m) push("add", y[j++]);
  return out;
}

// Renders the diff; returns the number of edits (a deletion next to an
// insertion is one edit, and spacing-only changes don't count).
function renderDiff(el, parts) {
  el.empty();
  let changes = 0;
  let inEdit = false;
  for (const p of parts) {
    if (p.type === "same") {
      el.appendText(p.text);
      if (p.text.trim()) inEdit = false;
      continue;
    }
    el.createSpan({ cls: `tahoe-ai-diff-${p.type}`, text: p.text });
    if (p.text.trim() && !inEdit) {
      changes++;
      inEdit = true;
    }
  }
  return changes;
}

// A macOS-style alert: icon, title, message, two equal buttons.
class AlertModal extends Modal {
  constructor(app, { title, message, confirm = "OK", cancel = "Cancel", warning = false, icon = "sparkles" }) {
    super(app);
    this.o = { title, message, confirm, cancel, warning, icon };
    this.promise = new Promise((r) => (this.resolve = r));
  }

  onOpen() {
    const { modalEl, contentEl, o } = this;
    modalEl.addClass("tahoe-ai-alert");
    modalEl.toggleClass("is-warning", o.warning);
    const icon = contentEl.createDiv({ cls: "tahoe-ai-alert-icon" });
    setIcon(icon, o.icon);
    contentEl.createDiv({ cls: "tahoe-ai-alert-title", text: o.title });
    if (o.message) contentEl.createDiv({ cls: "tahoe-ai-alert-message", text: o.message });
    const row = contentEl.createDiv({ cls: "modal-button-container tahoe-ai-alert-buttons" });
    if (o.cancel) row.createEl("button", { text: o.cancel }).addEventListener("click", () => this.close());
    const ok = row.createEl("button", { cls: o.warning ? "mod-warning" : "mod-cta", text: o.confirm });
    ok.addEventListener("click", () => {
      this.ok = true;
      this.close();
    });
    if (!o.warning) window.setTimeout(() => ok.focus(), 0);
  }

  onClose() {
    this.resolve(!!this.ok);
  }
}

function alert(app, options) {
  const m = new AlertModal(app, options);
  m.open();
  return m.promise;
}

// Friendly messages for model errors.
function explainError(error) {
  const code = error && error.code;
  if (code === "cancelled") return null;
  if (code === "unavailable") return error.message;
  if (code === "context") return "That's more text than the on-device model can read at once. Try a shorter selection.";
  if (code === "guardrail" || code === "refusal") return "Apple Intelligence declined to work on this text.";
  if (code === "language") return "Apple Intelligence doesn't support this language yet.";
  if (code === "assets") return "Apple Intelligence is still downloading its model. Try again in a few minutes.";
  return `Something went wrong: ${(error && error.message) || error}`;
}

function showError(error) {
  const msg = explainError(error);
  if (msg) new Notice(msg, 6000);
}

// "Asking Apple Intelligence…" with the glow, used while a sheet waits.
function thinking(el, text = "Thinking…") {
  const row = el.createDiv({ cls: "tahoe-ai-thinking" });
  aiIcon(row.createSpan());
  row.createSpan({ text });
  return row;
}

export { aiIcon, wordDiff, renderDiff, alert, explainError, showError, thinking };
