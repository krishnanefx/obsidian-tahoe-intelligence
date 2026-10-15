/*
 * Task extraction: finds to-dos written as plain sentences ("need to email the
 * prof before Friday") and turns them into real checkboxes with due dates
 * under a "Tasks" heading — so the Open Tasks Smart Folder picks them up.
 * Relative dates are worked out from today. You pick which ones to add.
 */

import { Modal, Notice, TFile } from "obsidian";
import { S, clip } from "../engine";
import { isoDate } from "../vault";
import { aiIcon, thinking, showError } from "../ui";

function instructions() {
  return `You find things the author still needs to do in a note, written as ordinary sentences — not ones that are already checkboxes.
For each one:
- task: a short instruction starting with a verb, using the note's own words.
- when: the exact words in the note that say when it's due (for example "by Friday", "this weekend", "on October 14", "Sunday afternoon"), copied as written. Leave it empty if the note doesn't say.
- quote: the words in the note that mention it.
Only include tasks that are in this note. Skip things that are already done, wishes, and general advice. If there are no tasks, return an empty list.`;
}

/* ---------- turning "by Friday" into a date, here rather than in the model ---------- */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

// The next date matching a phrase, from today; "" if it isn't a date.
function resolveWhen(phrase, today = new Date()) {
  const p = String(phrase || "").toLowerCase().trim();
  if (!p) return "";
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let m;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(p))) return validDate(`${m[1]}-${m[2]}-${m[3]}`);
  if (/\b(today|tonight|this evening)\b/.test(p)) return isoDate(base);
  if (/\btomorrow\b/.test(p)) return isoDate(addDays(base, 1));
  if ((m = /\bin (\d+|a|one|two|three) (day|days|week|weeks)\b/.exec(p))) {
    const n = { a: 1, one: 1, two: 2, three: 3 }[m[1]] || Number(m[1]);
    return isoDate(addDays(base, /week/.test(m[2]) ? n * 7 : n));
  }
  if (/\b(this )?weekend\b/.test(p)) return isoDate(addDays(base, (6 - base.getDay() + 7) % 7 || (base.getDay() === 6 ? 0 : 7)));
  if (/\bnext week\b/.test(p)) return isoDate(addDays(base, ((8 - base.getDay()) % 7) || 7));
  if (/\bend of (the )?week\b/.test(p)) return isoDate(addDays(base, (5 - base.getDay() + 7) % 7));
  // Month and day: "October 14", "Oct 14th", "14 October"
  for (let i = 0; i < 12; i++) {
    const name = MONTHS[i];
    const short = name.slice(0, 3);
    const re = new RegExp(`\\b(?:${name}|${short}\\.?)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${name}|${short})\\b`);
    if ((m = re.exec(p))) {
      const day = Number(m[1] || m[2]);
      let d = new Date(base.getFullYear(), i, day);
      if (d < addDays(base, -30)) d = new Date(base.getFullYear() + 1, i, day);
      return d.getMonth() === i ? isoDate(d) : "";
    }
  }
  // "10/14"
  if ((m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(p))) {
    const d = new Date(base.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    return isNaN(d) ? "" : isoDate(d < addDays(base, -30) ? new Date(base.getFullYear() + 1, d.getMonth(), d.getDate()) : d);
  }
  // A day of the month: "before the 20th", "on the 3rd"
  if ((m = /\bthe (\d{1,2})(?:st|nd|rd|th)\b/.exec(p))) {
    const day = Number(m[1]);
    let d = new Date(base.getFullYear(), base.getMonth(), day);
    if (d < base) d = new Date(base.getFullYear(), base.getMonth() + 1, day);
    return day >= 1 && day <= 31 ? isoDate(d) : "";
  }
  // Weekdays: "Friday", "by friday", "next Tuesday", "wednesday night"
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}s?\\b|\\b${WEEKDAYS[i].slice(0, 3)}\\b`).test(p)) {
      // The coming one ("next Friday" too, as most people mean it); today if it's today.
      let ahead = (i - base.getDay() + 7) % 7;
      if (ahead === 0 && /\bnext\b/.test(p)) ahead = 7;
      return isoDate(addDays(base, ahead));
    }
  }
  return "";
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s) {
  if (!DATE.test(s || "")) return "";
  const d = new Date(`${s}T12:00:00`);
  return isNaN(d) ? "" : s;
}

// Lines that are already tasks don't need finding again.
function withoutTasks(raw) {
  return raw
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .split("\n")
    .filter((l) => !/^\s*[-*+]\s+\[.\]/.test(l))
    .join("\n");
}

async function findTasks(plugin, file) {
  const raw = await plugin.app.vault.cachedRead(file);
  const text = clip(withoutTasks(raw), 5000).trim();
  if (text.length < 15) return [];
  const out = await plugin.engine.generate({
    instructions: instructions(),
    prompt: `Note — ${file.basename}:\n${text}`,
    schema: S.object({
      tasks: S.list(
        S.object({
          task: S.string("A short instruction starting with a verb"),
          when: S.string("The note's exact words for the deadline, or empty"),
          quote: S.string("The words in the note that mention it"),
        }),
        8,
        "Tasks the author still needs to do"
      ),
    }),
    temperature: 0,
  });
  const existing = raw.toLowerCase();
  const lowerText = text.toLowerCase();
  const seen = new Set();
  return (out.tasks || [])
    .map((t) => {
      const when = String(t.when || "").trim();
      // Trust a deadline only if those words are really in the note.
      const due = when && lowerText.includes(when.toLowerCase().slice(0, 40)) ? resolveWhen(when) : "";
      const task = String(t.task || "").trim().replace(/\.$/, "");
      return { file, task: task.charAt(0).toUpperCase() + task.slice(1), due, when, quote: String(t.quote || "").trim(), checked: true };
    })
    .filter((t) => {
      const key = t.task.toLowerCase();
      if (!t.task || seen.has(key) || existing.includes(`[ ] ${key}`)) return false;
      // The task must come from this note: its quote (or most of its words) must be in the text.
      const words = key.split(/\W+/).filter((w) => w.length > 3);
      const grounded = (t.quote && lowerText.includes(t.quote.toLowerCase().slice(0, 30))) || (words.length && words.filter((w) => lowerText.includes(w)).length / words.length >= 0.6);
      if (!grounded) return false;
      seen.add(key);
      return true;
    });
}

function formatTask(plugin, t) {
  if (!t.due) return `- [ ] ${t.task}`;
  switch (plugin.settings.taskFormat) {
    case "dataview":
      return `- [ ] ${t.task} [due:: ${t.due}]`;
    case "plain":
      return `- [ ] ${t.task} (due ${new Date(`${t.due}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
    default:
      return `- [ ] ${t.task} 📅 ${t.due}`;
  }
}

// Append under "## Tasks" (created at the end if it isn't there).
async function addTasks(plugin, file, tasks) {
  const heading = plugin.settings.taskHeading || "Tasks";
  const lines = tasks.map((t) => formatTask(plugin, t));
  await plugin.app.vault.process(file, (data) => {
    const re = new RegExp(`^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
    const m = re.exec(data);
    if (!m) return `${data.replace(/\s*$/, "")}\n\n## ${heading}\n${lines.join("\n")}\n`;
    // After the heading's existing list.
    const start = m.index + m[0].length;
    const rest = data.slice(start);
    const next = rest.search(/\n#{1,6}\s/);
    const sectionEnd = next < 0 ? data.length : start + next;
    const section = data.slice(start, sectionEnd).replace(/\s*$/, "");
    return `${data.slice(0, start)}${section}\n${lines.join("\n")}\n${data.slice(sectionEnd).replace(/^\n*/, "\n")}`.replace(/\n{3,}$/, "\n");
  });
}

class TasksModal extends Modal {
  constructor(plugin, files) {
    super(plugin.app);
    this.plugin = plugin;
    this.files = files;
    this.tasks = [];
  }

  onOpen() {
    this.modalEl.addClass("tahoe-ai-sheet", "tahoe-ai-tasks");
    this.titleEl.setText("Tasks found");
    this.find();
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
  }

  async find() {
    const el = this.contentEl;
    el.empty();
    const wait = el.createDiv({ cls: "tahoe-ai-card is-thinking" });
    const row = thinking(wait, this.files.length > 1 ? `Reading ${this.files.length} notes…` : "Reading the note…");
    let i = 0;
    for (const f of this.files) {
      if (this.closed) return;
      i++;
      if (this.files.length > 1) row.lastChild.setText(`Reading ${f.basename}… (${i}/${this.files.length})`);
      try {
        this.tasks.push(...(await findTasks(this.plugin, f)));
      } catch (e) {
        if (e.code === "unavailable") {
          this.close();
          return showError(e);
        }
      }
    }
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    if (!this.tasks.length) {
      const empty = el.createDiv({ cls: "tahoe-ai-empty" });
      aiIcon(empty.createDiv({ cls: "tahoe-ai-empty-icon" }), "list-checks");
      empty.createDiv({ cls: "tahoe-ai-empty-title", text: "No hidden tasks" });
      empty.createDiv({ cls: "tahoe-ai-empty-desc", text: this.files.length > 1 ? "Nothing in these notes reads like a to-do." : "Nothing in this note reads like a to-do." });
      el.createDiv({ cls: "modal-button-container" }).createEl("button", { cls: "mod-cta", text: "Done" }).addEventListener("click", () => this.close());
      return;
    }
    el.createDiv({ cls: "tahoe-ai-sub", text: `They'll be added as checkboxes under “${this.plugin.settings.taskHeading || "Tasks"}”.` });
    const byFile = new Map();
    for (const t of this.tasks) {
      if (!byFile.has(t.file)) byFile.set(t.file, []);
      byFile.get(t.file).push(t);
    }
    for (const [file, tasks] of byFile) {
      if (byFile.size > 1) el.createDiv({ cls: "tahoe-ai-section-title", text: file.basename });
      const card = el.createDiv({ cls: "tahoe-ai-card tahoe-ai-task-list" });
      for (const t of tasks) {
        const row = card.createDiv({ cls: "tahoe-ai-task-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = t.checked;
        cb.addEventListener("change", () => {
          t.checked = cb.checked;
          this.updateButton();
        });
        const body = row.createDiv({ cls: "tahoe-ai-task-body" });
        const input = body.createEl("input", { type: "text", cls: "tahoe-ai-task-input", value: t.task });
        input.addEventListener("input", () => (t.task = input.value));
        if (t.quote) body.createDiv({ cls: "tahoe-ai-task-quote", text: `“${t.quote}”` });
        const date = row.createEl("input", { type: "date", cls: "tahoe-ai-task-date", value: t.due });
        date.addEventListener("change", () => (t.due = validDate(date.value)));
      }
    }
    const footer = el.createDiv({ cls: "tahoe-ai-footer" });
    const meta = footer.createDiv({ cls: "tahoe-ai-footer-meta" });
    aiIcon(meta.createSpan());
    meta.createSpan({ text: "Dates worked out from today" });
    const buttons = footer.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    this.addBtn = buttons.createEl("button", { cls: "mod-cta" });
    this.addBtn.addEventListener("click", () => this.add());
    this.updateButton();
  }

  updateButton() {
    const n = this.tasks.filter((t) => t.checked && t.task.trim()).length;
    this.addBtn.setText(n ? `Add ${n} ${n === 1 ? "task" : "tasks"}` : "Add tasks");
    this.addBtn.disabled = !n;
  }

  async add() {
    const byFile = new Map();
    for (const t of this.tasks) {
      if (!t.checked || !t.task.trim()) continue;
      if (!byFile.has(t.file)) byFile.set(t.file, []);
      byFile.get(t.file).push(t);
    }
    let n = 0;
    for (const [file, tasks] of byFile) {
      await addTasks(this.plugin, file, tasks);
      n += tasks.length;
    }
    this.close();
    new Notice(`Added ${n} ${n === 1 ? "task" : "tasks"}`);
  }
}

function register(plugin) {
  plugin.addCommand({
    id: "find-tasks",
    name: "Find tasks in this note",
    icon: "list-checks",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;
      if (!checking) new TasksModal(plugin, [file]).open();
      return true;
    },
  });
  plugin.addCommand({
    id: "find-tasks-week",
    name: "Find tasks in notes edited this week",
    callback: () => {
      const since = Date.now() - 7 * 86400000;
      const files = plugin.app.vault
        .getMarkdownFiles()
        .filter((f) => f.stat.mtime >= since && !plugin.index.excluded(f) && !/weekly review/i.test(f.basename))
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, 20);
      if (!files.length) return new Notice("No notes were edited this week");
      new TasksModal(plugin, files).open();
    },
  });
  plugin.registerEvent(
    plugin.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addItem((i) => i.setTitle("Find tasks").setIcon("list-checks").setSection("action").onClick(() => new TasksModal(plugin, [file]).open()));
    })
  );
}

export { register, findTasks, formatTask, addTasks, resolveWhen };
