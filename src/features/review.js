/*
 * Weekly review: a draft "what I worked on this week" note. It reads the notes
 * in Projects and Areas that changed in the last seven days (one line each),
 * gathers open tasks by due date, and suggests highlights and a focus for
 * next week. The draft opens for you to edit — it's a starting point.
 */

import { Modal, Notice, TFile, normalizePath } from "obsidian";
import { S, clip } from "../engine";
import { noteText, knownFolders, ensureFolder, isoDate, isoWeek } from "../vault";
import { aiIcon, alert, showError } from "../ui";
import { eventLine, day, weekForReview } from "./calendar";

const SUMMARY_INSTRUCTIONS = `You help someone write their weekly review. Given one of their notes, write one short sentence (at most 20 words) saying what it covers and, if the note says, what's done or still to do. Use only what the note says — don't claim anything was done unless the note says it's done. If the note doesn't say what's done or left, just say what it covers. No filler like "progress made", "nothing is done yet" or "decisions needed".`;

const HIGHLIGHT_INSTRUCTIONS = `You help someone write their weekly review. From the notes they worked on this week, choose up to three where the most important work happened — deadlines, finished pieces, or big plans.`;

const FOCUS_INSTRUCTIONS = `You help someone plan next week. From their open tasks, choose up to three to focus on: overdue tasks first, then ones due soon, then important unfinished work.`;

const DUE = /(?:📅|\[due::|due:?)\s*(\d{4}-\d{2}-\d{2})/i;
const DONE_ON = /✅\s*(\d{4}-\d{2}-\d{2})/;

function folders(plugin) {
  const s = plugin.settings;
  const k = knownFolders(plugin.app, plugin.settings);
  return {
    projects: s.reviewProjects || k.projects,
    areas: s.reviewAreas || k.areas,
    out: s.reviewFolder || (k.root ? `${k.root}/Reviews` : "Reviews"),
  };
}

async function gatherTasks(plugin) {
  const today = isoDate();
  const weekAgo = isoDate(new Date(Date.now() - 7 * 86400000));
  const inWeek = isoDate(new Date(Date.now() + 7 * 86400000));
  const open = [];
  const done = [];
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    const cache = plugin.app.metadataCache.getFileCache(f);
    if (!cache || !cache.listItems || !cache.listItems.some((l) => l.task != null)) continue;
    if (/weekly review/i.test(f.basename)) continue;
    const lines = (await plugin.app.vault.cachedRead(f)).split("\n");
    for (const item of cache.listItems) {
      if (item.task == null) continue;
      const line = lines[item.position.start.line] || "";
      const text = line.replace(/^\s*[-*+]\s+\[.\]\s*/, "").replace(/\s*(📅|\[due::|✅|⏳|🛫)[^\]]*\]?/g, "").trim();
      if (!text) continue;
      if (item.task === " ") {
        const m = DUE.exec(line);
        open.push({ file: f, text, due: m ? m[1] : "" });
      } else {
        const m = DONE_ON.exec(line);
        if (m && m[1] >= weekAgo) done.push({ file: f, text });
      }
    }
  }
  const overdue = open.filter((t) => t.due && t.due < today).sort((a, b) => a.due.localeCompare(b.due));
  const soon = open.filter((t) => t.due && t.due >= today && t.due <= inWeek).sort((a, b) => a.due.localeCompare(b.due));
  const later = open.filter((t) => !t.due || t.due > inWeek);
  return { overdue, soon, later, done, open };
}

function calendarSection(cal) {
  const byDay = (list) => {
    const out = [];
    let last = "";
    for (const e of list.slice(0, 30)) {
      const d = day(new Date(e.start));
      if (d !== last) out.push(`**${d}**`);
      last = d;
      out.push(eventLine(e));
    }
    return out;
  };
  return ["## Calendar", ...(cal.past.length ? ["### This week", ...byDay(cal.past)] : []), ...(cal.next.length ? ["### Coming up", ...byDay(cal.next)] : []), ""];
}

class ReviewModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass("tahoe-ai-sheet", "tahoe-ai-review");
    const head = this.titleEl;
    aiIcon(head.createSpan({ cls: "tahoe-ai-title-icon" }));
    head.createSpan({ text: "Writing your weekly review" });
    this.list = this.contentEl.createDiv({ cls: "tahoe-ai-card tahoe-ai-steps" });
    this.write();
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
  }

  step(text) {
    const row = this.list.createDiv({ cls: "tahoe-ai-step is-active" });
    aiIcon(row.createSpan());
    const label = row.createSpan({ text });
    return {
      set: (t) => label.setText(t),
      done: (t) => {
        row.removeClass("is-active");
        row.addClass("is-done");
        if (t) label.setText(t);
      },
    };
  }

  async write() {
    const plugin = this.plugin;
    const app = this.app;
    const { projects, areas, out } = folders(plugin);
    const since = Date.now() - 7 * 86400000;
    const under = (f, folder) => folder && f.path.startsWith(folder + "/");
    const changed = app.vault
      .getMarkdownFiles()
      .filter((f) => f.stat.mtime >= since && (under(f, projects) || under(f, areas)))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 24);

    try {
      // 1. One line per note that changed.
      const s1 = this.step(changed.length ? `Reading ${changed.length} notes you worked on…` : "No project or area notes changed this week");
      const summaries = [];
      let i = 0;
      for (const f of changed) {
        if (this.closed) return;
        s1.set(`Reading ${f.basename}… (${++i}/${changed.length})`);
        const text = clip(await noteText(app, f), 2400);
        if (!text) continue;
        const r = await plugin.engine.generate({
          instructions: SUMMARY_INSTRUCTIONS,
          prompt: `Note — ${f.basename} (in ${f.parent ? f.parent.path : "/"}):\n${text}`,
          schema: S.object({ summary: S.string("One short sentence") }),
          temperature: 0.2,
        });
        summaries.push({ file: f, summary: String(r.summary || "").trim().replace(/\s+/g, " ") });
      }
      s1.done(changed.length ? `Read ${changed.length} notes` : undefined);

      // 2. Tasks.
      const s2 = this.step("Gathering open tasks…");
      const tasks = await gatherTasks(plugin);
      s2.done(`${tasks.open.length} open ${tasks.open.length === 1 ? "task" : "tasks"}${tasks.overdue.length ? `, ${tasks.overdue.length} overdue` : ""}`);

      // 3. Highlights (from the summaries) and next week's focus (chosen from real tasks).
      const s3 = this.step("Writing highlights…");
      // Highlights reuse the per-note summaries word for word, so they stay accurate.
      let highlights = [];
      if (summaries.length) {
        const titles = summaries.map((x) => x.file.basename);
        const r = await plugin.engine.generate({
          instructions: HIGHLIGHT_INSTRUCTIONS,
          prompt: clip(`Notes worked on this week:\n${summaries.map((x) => `- ${x.file.basename}: ${x.summary}`).join("\n")}`, 6000),
          schema: S.object({ notes: S.list(S.oneOf(titles), 3, "The most important notes this week") }),
          temperature: 0,
        });
        const picked = new Set(r.notes || []);
        highlights = summaries.filter((x) => picked.has(x.file.basename));
      }
      let focus = [];
      const pool = [...tasks.overdue, ...tasks.soon, ...tasks.later].slice(0, 30);
      if (pool.length) {
        const label = (t, i) => `${i + 1}. ${t.text}`;
        const r = await plugin.engine.generate({
          instructions: FOCUS_INSTRUCTIONS,
          prompt: `Today is ${isoDate()}.\nOpen tasks:\n${pool.map((t, i) => `${label(t, i)}${t.due ? ` (due ${t.due}${t.due < isoDate() ? ", overdue" : ""})` : ""} — in ${t.file.basename}`).join("\n")}`,
          schema: S.object({ focus: S.list(S.oneOf(pool.map(label)), 3, "Tasks to focus on next week") }),
          temperature: 0,
        });
        const picked = new Set(r.focus || []);
        focus = pool.filter((t, i) => picked.has(label(t, i)));
      }
      s3.done("Highlights written");

      // Calendar, if Obsidian is allowed to see it (never asks from here).
      const cal = plugin.settings.features.calendar !== false ? await weekForReview(plugin) : null;

      // 4. The note.
      const { year, week } = isoWeek();
      const name = `Weekly Review ${year}-W${String(week).padStart(2, "0")}`;
      const target = normalizePath(`${out}/${name}.md`);
      const link = (f) => app.fileManager.generateMarkdownLink(f, target);
      const group = (folder) => summaries.filter((x) => under(x.file, folder));
      // Headings without the folder numbers: "400 Projects" → "Projects".
      const label = (folder) => (folder || "").split("/").pop().replace(/^\d+\s*[-_.]?\s*/, "") || folder;
      const section = (root, fallback, items) => {
        if (!items.length) return [];
        // Notes right in the folder first, then one heading per subfolder (project).
        const by = new Map();
        for (const x of items) {
          const rel = x.file.parent ? x.file.parent.path : "";
          if (!by.has(rel)) by.set(rel, []);
          by.get(rel).push(x);
        }
        const lines = [`## ${root ? label(root) : fallback}`];
        for (const x of by.get(root) || []) lines.push(`- ${link(x.file)} — ${x.summary}`);
        for (const [folder, xs] of by) {
          if (folder === root) continue;
          lines.push(`### ${label(folder)}`);
          for (const x of xs) lines.push(`- ${link(x.file)} — ${x.summary}`);
        }
        return [...lines, ""];
      };
      const taskLine = (t) => `- ${t.text}${t.due ? ` · due ${new Date(`${t.due}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""} · ${link(t.file)}`;
      const body = [
        "---",
        "type: review",
        `week: ${year}-W${String(week).padStart(2, "0")}`,
        `created: ${isoDate()}`,
        "---",
        "## Highlights",
        ...(highlights.length ? highlights.map((x) => `- **${link(x.file)}** — ${x.summary}`) : ["- "]),
        "",
        ...section(projects, "Projects", group(projects)),
        ...section(areas, "Areas", group(areas)),
        "## Open tasks",
        ...(tasks.overdue.length ? ["### Overdue", ...tasks.overdue.map(taskLine)] : []),
        ...(tasks.soon.length ? ["### Due this week", ...tasks.soon.map(taskLine)] : []),
        ...(tasks.later.length ? ["### Later", ...tasks.later.slice(0, 15).map(taskLine), ...(tasks.later.length > 15 ? [`- …and ${tasks.later.length - 15} more`] : [])] : []),
        ...(tasks.open.length ? [] : ["- Nothing open"]),
        "",
        ...(tasks.done.length ? ["## Finished", ...tasks.done.map((t) => `- ${t.text} · ${link(t.file)}`), ""] : []),
        ...(cal && (cal.past.length || cal.next.length) ? calendarSection(cal) : []),
        "## Next week",
        ...(focus.length ? focus.map(taskLine) : ["- "]),
        "",
        "## Reflection",
        "",
      ].join("\n");

      if (this.closed) return;
      await ensureFolder(app, out);
      const existing = app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) {
        const ok = await alert(app, { title: `Replace “${name}”?`, message: "There's already a review for this week. The new draft replaces it.", confirm: "Replace", warning: true, icon: "calendar-check" });
        if (!ok) return this.close();
        await app.vault.modify(existing, body);
      } else await app.vault.create(target, body);
      this.close();
      const file = app.vault.getAbstractFileByPath(target);
      if (file instanceof TFile) await app.workspace.getLeaf(false).openFile(file);
      new Notice(`${name} is ready to edit`);
    } catch (e) {
      this.close();
      showError(e);
    }
  }
}

function register(plugin) {
  plugin.addCommand({ id: "weekly-review", name: "Write weekly review", icon: "calendar-check", callback: () => new ReviewModal(plugin).open() });
}

export { register, gatherTasks };
