/*
 * Your calendar in Obsidian (read-only, from the Mac's Calendar app — so
 * Google Calendar works if your Google account is added there).
 *
 *   Insert today's agenda · Make a meeting note from an event ·
 *   "This week's calendar" in the weekly review
 */

import { Notice, SuggestModal } from "obsidian";
import { knownFolders, isoDate, safeName, uniquePath, ensureFolder } from "../vault";
import { alert } from "../ui";

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// Ask once (Obsidian's own macOS prompt), then remember the answer.
async function ensureAccess(plugin, { ask = true } = {}) {
  let access = await plugin.engine.calendarAccess(false);
  if (access === "notDetermined" && ask) {
    const ok = await alert(plugin.app, {
      title: "Show your calendar in Obsidian?",
      message: "Tahoe can read events from the Calendar app — including Google Calendar, if your Google account is added there — for agendas, meeting notes and your weekly review. macOS will ask to let Obsidian see your calendars. Nothing is changed in Calendar.",
      confirm: "Continue",
      icon: "calendar",
    });
    if (!ok) return false;
    access = await plugin.engine.calendarAccess(true);
  }
  if (access !== "full") {
    if (ask) new Notice("Obsidian can't see your calendars. Allow it in System Settings → Privacy & Security → Calendars.", 8000);
    return false;
  }
  return true;
}

async function events(plugin, from, to) {
  return (await plugin.engine.calendarEvents(isoDate(from), isoDate(to))).filter((e) => !(plugin.settings.calendarSkip || []).includes(e.calendar));
}

function eventLine(e) {
  const when = e.allDay ? "All day" : `${time(e.start)}–${time(e.end)}`;
  return `- ${when} **${e.title || "Event"}**${e.location ? ` · ${e.location}` : ""}`;
}

async function insertAgenda(plugin, editor) {
  if (!(await ensureAccess(plugin))) return;
  const today = new Date();
  const list = await events(plugin, today, today);
  const lines = [`### Today · ${day(today)}`, ...(list.length ? list.map(eventLine) : ["- Nothing on the calendar"]), ""];
  editor.replaceSelection(lines.join("\n"));
}

class EventPicker extends SuggestModal {
  constructor(plugin, list) {
    super(plugin.app);
    this.plugin = plugin;
    this.list = list;
    this.setPlaceholder("Make a meeting note for…");
  }
  getSuggestions(q) {
    const s = q.toLowerCase();
    return this.list.filter((e) => !s || `${e.title} ${e.calendar}`.toLowerCase().includes(s));
  }
  renderSuggestion(e, el) {
    el.createDiv({ text: e.title || "Event" });
    el.createDiv({ cls: "tahoe-ai-event-meta", text: `${day(new Date(e.start))} · ${e.allDay ? "All day" : `${time(e.start)}–${time(e.end)}`} · ${e.calendar}` });
  }
  async onChooseSuggestion(e) {
    await meetingNote(this.plugin, e);
  }
}

async function meetingNote(plugin, e) {
  const app = plugin.app;
  const k = knownFolders(app, plugin.settings);
  const folder = plugin.settings.meetingFolder || k.inbox || "";
  await ensureFolder(app, folder);
  const date = isoDate(new Date(e.start));
  const target = uniquePath(app, folder, safeName(`${date} ${e.title || "Meeting"}`), "md");
  const people = (e.attendees || []).filter(Boolean);
  const body = [
    "---",
    "type: meeting",
    `date: ${date}`,
    e.allDay ? null : `time: "${time(e.start)}–${time(e.end)}"`,
    people.length ? `attendees:\n${people.map((p) => `  - "${p.replace(/"/g, "'")}"`).join("\n")}` : null,
    e.location ? `location: "${e.location.replace(/"/g, "'")}"` : null,
    "---",
    "## Agenda",
    "- ",
    "",
    "## Notes",
    "",
    "## Action items",
    "- [ ] ",
    "",
  ]
    .filter((l) => l != null)
    .join("\n");
  const f = await app.vault.create(target, body);
  await app.workspace.getLeaf(false).openFile(f);
}

// For the weekly review: what happened this week and what's coming.
async function weekForReview(plugin) {
  try {
    if (!(await ensureAccess(plugin, { ask: false }))) return null;
    const now = new Date();
    const past = await events(plugin, new Date(now.getTime() - 6 * 86400000), now);
    const next = await events(plugin, new Date(now.getTime() + 86400000), new Date(now.getTime() + 7 * 86400000));
    return { past, next };
  } catch {
    return null;
  }
}

function register(plugin) {
  plugin.addCommand({ id: "agenda", name: "Insert today's agenda", icon: "calendar", editorCallback: (editor) => insertAgenda(plugin, editor) });
  plugin.addCommand({
    id: "meeting-note",
    name: "Make a meeting note…",
    icon: "users",
    callback: async () => {
      if (!(await ensureAccess(plugin))) return;
      const now = new Date();
      const list = await events(plugin, new Date(now.getTime() - 86400000), new Date(now.getTime() + 2 * 86400000));
      if (!list.length) return new Notice("No events from yesterday to the day after tomorrow");
      new EventPicker(plugin, list).open();
    },
  });
}

export { register, ensureAccess, weekForReview, eventLine, day };
