/*
 * Deadlines in Apple Reminders — two-way sync.
 *
 * Every open task with a due date (📅 2026-10-09 or [due:: 2026-10-09]) gets a
 * reminder in a Reminders list (default "Obsidian"), so it shows on your
 * iPhone's lock screen and in Siri. Each synced task carries a block id
 * (^tr-a1b2c3) — hidden in Live Preview and Reading view — that ties it to its
 * reminder.
 *
 *   Obsidian → Reminders: new dated tasks, edited text or date, checked off.
 *   Reminders → Obsidian: completed (e.g. on iPhone), new date, edited title.
 *   New reminders added to the list (say, "Hey Siri, remind me … in Obsidian")
 *   become tasks in an inbox note.
 *
 * Nothing is ever deleted in Reminders: if a task disappears from the vault,
 * its reminder is marked completed. If you delete a reminder, its task simply
 * stops syncing.
 */

import { Notice, TFile, debounce, normalizePath } from "obsidian";
import { knownFolders, isoDate, ensureFolder } from "../vault";
import { alert } from "../ui";

const TASK_LINE = /^(\s*(?:>\s*)*[-*+]\s+\[)(.)(\]\s+)(.*)$/;
const BLOCK_ID = /\s+\^(tr-[a-z0-9]{6})\s*$/;
const DUE = /(?:📅\s*(\d{4}-\d{2}-\d{2}))|(?:\[due::\s*(\d{4}-\d{2}-\d{2})\])/;
const DONE_ON = /\s*✅\s*\d{4}-\d{2}-\d{2}/;
// Tasks-plugin markers that aren't part of the title.
const MARKERS = /\s*(?:📅|⏳|🛫|➕|✅|❌)\s*\d{4}-\d{2}-\d{2}|\s*\[(?:due|scheduled|start|created|completion)::[^\]]*\]|\s*[🔁⏫🔼🔽⏬🔺][^📅⏳🛫➕✅]*?(?=\s*(?:📅|⏳|🛫|$))/gu;

function newId() {
  return `tr-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}

// A task line → its parts.
function parseTask(line) {
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  const body = m[4];
  const idm = BLOCK_ID.exec(body);
  const id = idm ? idm[1] : null;
  const withoutId = id ? body.slice(0, idm.index) : body;
  const d = DUE.exec(withoutId);
  const due = d ? d[1] || d[2] : "";
  const title = withoutId.replace(MARKERS, "").replace(/\s+/g, " ").trim();
  return { done: m[2] !== " ", status: m[2], due, title, id, prefix: m[1], mid: m[3], body: withoutId };
}

// Rewrite a task line with a new title, date or completion, keeping its markers.
function rewriteTask(line, { title, due, done, id, format }) {
  const t = parseTask(line);
  if (!t) return line;
  let body = t.body;
  if (title != null && title !== t.title) {
    // Replace the title part (everything before the first marker).
    const firstMarker = body.search(/\s(?:📅|⏳|🛫|➕|✅|❌|🔁|⏫|🔼|🔽|⏬|🔺|\[(?:due|scheduled|start|created|completion)::)/u);
    body = firstMarker >= 0 ? `${title}${body.slice(firstMarker)}` : title;
  }
  if (due != null && due !== t.due) {
    if (!due) body = body.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}|\s*\[due::[^\]]*\]/u, "");
    else if (DUE.test(body)) body = body.replace(/📅\s*\d{4}-\d{2}-\d{2}/u, `📅 ${due}`).replace(/\[due::\s*\d{4}-\d{2}-\d{2}\]/, `[due:: ${due}]`);
    else body = `${body} ${format === "dataview" ? `[due:: ${due}]` : `📅 ${due}`}`;
  }
  let status = t.status;
  if (done != null && done !== t.done) {
    status = done ? "x" : " ";
    body = body.replace(DONE_ON, "");
    if (done && format !== "dataview" && format !== "plain") body = `${body} ✅ ${isoDate()}`;
  }
  const blockId = id || t.id;
  return `${t.prefix}${status}${t.mid}${body.replace(/\s+$/, "")}${blockId ? ` ^${blockId}` : ""}`;
}

/* ---------- where reminders come from ---------- */

class HelperBackend {
  constructor(engine) {
    this.engine = engine;
  }
  access(ask) {
    return this.engine.remindersAccess(ask);
  }
  fetch(list) {
    return this.engine.remindersFetch(list);
  }
  save(list, items) {
    return this.engine.remindersSave(list, items);
  }
}

/* ---------- the sync ---------- */

class RemindersSync {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.backend = new HelperBackend(plugin.engine);
    this.running = false;
    this.again = false;
    this.syncSoon = debounce(() => this.sync(), 5000, true);
  }

  get s() {
    return this.plugin.settings;
  }

  get state() {
    return (this.s.reminderMap = this.s.reminderMap || {}); // id → { rid, path, title, due, done }
  }

  vaultLink(path) {
    return `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
  }

  inboxNotePath() {
    if (this.s.reminderInbox) return normalizePath(this.s.reminderInbox.endsWith(".md") ? this.s.reminderInbox : `${this.s.reminderInbox}.md`);
    const inbox = knownFolders(this.app, this.s).inbox;
    return normalizePath(`${inbox ? `${inbox}/` : ""}Reminders.md`);
  }

  // Turn it on: ask macOS for access (the prompt is Obsidian's), then sync.
  async enable() {
    let access = await this.backend.access(false);
    if (access === "notDetermined") {
      const ok = await alert(this.app, {
        title: "Sync deadlines with Reminders?",
        message: `Tasks with due dates will appear in a “${this.s.reminderList}” list in Reminders, and changes you make there come back to your notes. macOS will ask to let Obsidian use Reminders.`,
        confirm: "Continue",
        icon: "list-checks",
      });
      if (!ok) return false;
      access = await this.backend.access(true);
    }
    if (access !== "full") {
      new Notice("Obsidian can't use Reminders. Allow it in System Settings → Privacy & Security → Reminders.", 8000);
      return false;
    }
    this.s.remindersOn = true;
    await this.plugin.saveSettings();
    await this.sync({ announce: true });
    return true;
  }

  start() {
    if (!this.s.remindersOn || this.started) return;
    this.started = true;
    this.plugin.engine.onEvent = (event) => event === "reminders-changed" && this.syncSoon();
    this.plugin.registerEvent(
      this.app.metadataCache.on("changed", (file, data, cache) => {
        if (cache && cache.listItems && cache.listItems.some((l) => l.task != null)) this.syncSoon();
      })
    );
    this.plugin.registerInterval(window.setInterval(() => this.sync(), 3 * 60000));
    window.setTimeout(() => this.sync(), 4000);
  }

  // Every task with a date, or with a sync id, in the vault.
  async scanTasks() {
    const out = new Map(); // id → task
    const fresh = []; // dated open tasks without an id yet
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.plugin.index.excluded(file)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache || !cache.listItems || !cache.listItems.some((l) => l.task != null)) continue;
      const lines = (await this.app.vault.cachedRead(file)).split("\n");
      for (const item of cache.listItems) {
        if (item.task == null) continue;
        const n = item.position.start.line;
        const t = parseTask(lines[n] || "");
        if (!t || !t.title) continue;
        t.path = file.path;
        t.line = n;
        t.raw = lines[n];
        if (t.id) out.set(t.id, t);
        else if (t.due && !t.done) fresh.push(t);
      }
    }
    return { tasks: out, fresh };
  }

  async sync({ announce = false } = {}) {
    if (!this.s.remindersOn) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      await this.run(announce);
    } catch (e) {
      console.warn("Tahoe Intelligence: Reminders sync failed", e);
      if (announce) new Notice(`Couldn't sync with Reminders: ${e.message}`);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.syncSoon();
      }
    }
  }

  async run(announce) {
    const list = this.s.reminderList || "Obsidian";
    const format = this.s.taskFormat;
    const reminders = new Map((await this.backend.fetch(list)).map((r) => [r.id, r]));
    const { tasks, fresh } = await this.scanTasks();
    const state = this.state;
    const toSave = []; // reminder changes
    const edits = new Map(); // path → [{ id, line, raw, change }]
    const edit = (task, change) => {
      if (!edits.has(task.path)) edits.set(task.path, []);
      edits.get(task.path).push({ task, change });
    };
    let pushed = 0;
    let pulled = 0;
    const handled = new Set(); // reminders dealt with in this run

    // 1. Tasks already linked to a reminder.
    for (const [id, last] of Object.entries(state)) {
      let t = tasks.get(id);
      const r = last.rid ? reminders.get(last.rid) : null;
      if (r) handled.add(r.id);
      if (!t && r) {
        // Not found by the scan — make sure it's really gone (the note may not be indexed yet).
        const f = this.app.vault.getAbstractFileByPath(last.path);
        if (f instanceof TFile && (await this.app.vault.read(f)).includes(`^${id}`)) continue;
      }
      if (!r) {
        // Deleted in Reminders: stop syncing this task.
        delete state[id];
        continue;
      }
      if (!t) {
        // Gone from the vault: complete the reminder (never delete it).
        if (!r.completed) {
          toSave.push({ id: r.id, completed: true });
          pushed++;
        }
        delete state[id];
        continue;
      }
      const obs = { title: t.title, due: t.due, done: t.done };
      const rem = { title: r.title, due: r.due, done: r.completed };
      const next = {};
      for (const k of ["title", "due", "done"]) {
        const oChanged = obs[k] !== last[k];
        const rChanged = rem[k] !== last[k];
        // A change on one side wins; if both changed, the note wins, except
        // that completing on either side completes both.
        if (k === "done" && oChanged && rChanged) next[k] = obs.done || rem.done;
        else next[k] = oChanged ? obs[k] : rChanged ? rem[k] : obs[k];
      }
      const toReminders = next.title !== rem.title || next.due !== rem.due || next.done !== rem.done;
      const toNote = next.title !== obs.title || next.due !== obs.due || next.done !== obs.done;
      if (toReminders) {
        toSave.push({ id: r.id, title: next.title, due: next.due, completed: next.done });
        pushed++;
      }
      if (toNote) {
        edit(t, next);
        pulled++;
      }
      state[id] = { rid: r.id, path: t.path, title: next.title, due: next.due, done: next.done };
    }

    // 2. New dated tasks → new reminders.
    const created = [];
    for (const t of fresh) {
      const id = newId();
      created.push({ t, id });
      toSave.push({ title: t.title, due: t.due, completed: false, notes: `From “${t.path.split("/").pop().replace(/\.md$/, "")}” in Obsidian`, url: this.vaultLink(t.path) });
      edit(t, { id });
    }

    // 3. New reminders added in Reminders → tasks in the inbox note.
    // (Not ones handled above, and not ones Obsidian made earlier — they link back to this vault.)
    const linked = new Set(Object.values(state).map((x) => x.rid));
    const ours = `obsidian://open?vault=${encodeURIComponent(this.app.vault.getName())}&`;
    const incoming = [...reminders.values()].filter((r) => !linked.has(r.id) && !handled.has(r.id) && !r.completed && r.title.trim() && !(r.url || "").startsWith(ours));

    // Save to Reminders, then map new ids.
    const ids = await this.backend.save(list, toSave);
    const firstNew = toSave.length - created.length;
    created.forEach(({ t, id }, i) => {
      state[id] = { rid: ids[firstNew + i], path: t.path, title: t.title, due: t.due, done: false };
      pushed++;
    });

    // Write note changes, matching lines by their text so edits elsewhere are safe.
    for (const [path, list2] of edits) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      await this.app.vault.process(file, (data) => {
        const lines = data.split("\n");
        for (const { task, change } of list2) {
          let n = lines[task.line] === task.raw ? task.line : lines.indexOf(task.raw);
          if (n < 0 && task.id) n = lines.findIndex((l) => l.includes(`^${task.id}`));
          if (n < 0) continue;
          lines[n] = rewriteTask(lines[n], Object.assign({ format }, change));
        }
        return lines.join("\n");
      });
    }

    if (incoming.length) {
      const path = this.inboxNotePath();
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      await ensureFolder(this.app, folder);
      const lines = [];
      const updates = [];
      for (const r of incoming) {
        const id = newId();
        lines.push(`- [ ] ${r.title.trim()}${r.due ? (format === "dataview" ? ` [due:: ${r.due}]` : ` 📅 ${r.due}`) : ""} ^${id}`);
        state[id] = { rid: r.id, path, title: r.title.trim(), due: r.due, done: false };
        updates.push({ id: r.id, url: this.vaultLink(path), notes: r.notes || "Added from Reminders" });
        pulled++;
      }
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.process(existing, (d) => `${d.replace(/\s*$/, "")}\n${lines.join("\n")}\n`);
      else await this.app.vault.create(path, `# Reminders\n\nAdded from the “${list}” list in Reminders.\n\n${lines.join("\n")}\n`);
      await this.backend.save(list, updates);
    }

    this.s.reminderLastSync = Date.now();
    await this.plugin.saveSettings();
    if (announce || pushed + pulled) {
      const parts = [];
      if (pushed) parts.push(`${pushed} to Reminders`);
      if (pulled) parts.push(`${pulled} from Reminders`);
      if (announce || parts.length) new Notice(parts.length ? `Synced ${parts.join(", ")}` : "Reminders are up to date", 2500);
    }
    return { pushed, pulled };
  }

  async disable() {
    this.s.remindersOn = false;
    await this.plugin.saveSettings();
  }
}

function register(plugin) {
  const sync = (plugin.reminders = new RemindersSync(plugin));
  plugin.addCommand({
    id: "reminders-sync",
    name: "Sync deadlines with Reminders",
    icon: "list-checks",
    callback: () => (plugin.settings.remindersOn ? sync.sync({ announce: true }) : sync.enable().then((ok) => ok && sync.start())),
  });
}

function startBackground(plugin) {
  if (plugin.reminders && plugin.settings.remindersOn) plugin.reminders.start();
}

export { register, startBackground, parseTask, rewriteTask, RemindersSync };
