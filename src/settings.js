import { PluginSettingTab, Setting, Notice } from "obsidian";
import { ensureAccess } from "./features/calendar";
import { knownFolders } from "./vault";

const DEFAULT_SETTINGS = {
  provider: "auto", // "auto": Apple Intelligence, else Ollama · "ollama": always Ollama
  ollamaModel: "",
  features: {
    triage: true,
    distill: true,
    rename: true,
    properties: true,
    links: true,
    similar: true,
    topics: true,
    writing: true,
    tasks: true,
    review: true,
    related: true,
    ask: true,
    moc: true,
    mathwords: true,
    // These reach other apps, so they start off.
    reminders: false,
    calendar: false,
  },
  // Meaning thresholds (cosine between centred vectors)
  linkThreshold: 0.42,
  linkMax: 2,
  duplicateThreshold: 0.62,
  topicThreshold: 0.05,
  excludeFolders: [],
  // Writing help
  writingButton: true,
  // Properties
  properties: [
    { key: "type", enabled: true, values: ["fleeting", "literature", "permanent", "project", "area", "resource", "lecture", "meeting", "daily", "review"] },
    { key: "course", enabled: true, values: [] },
    { key: "status", enabled: true, values: ["todo", "in progress", "done", "archived"] },
  ],
  propertyTags: true,
  propertyAutoApply: false,
  // Tasks
  taskFormat: "tasks", // tasks (📅) · dataview ([due:: ]) · plain
  taskHeading: "Tasks",
  // Distill / review folders (empty = detect)
  distillFolder: "",
  reviewFolder: "",
  reviewProjects: "",
  reviewAreas: "",
  mocFolder: "",
  meetingFolder: "",
  // Reminders
  remindersOn: false,
  reminderList: "Obsidian",
  reminderInbox: "",
  reminderMap: {},
  // Calendar
  calendarSkip: [],
};

const FEATURE_ROWS = [
  ["triage", "Triage suggestions", "Suggest a folder, tags and a better title for each inbox note (Tahoe Organize's Inbox triage)."],
  ["distill", "Distill into a permanent note", "Turn a rough fleeting note into a one-idea permanent note you can edit before saving."],
  ["rename", "Rename untitled notes and images", "Name “Untitled 3” and “Pasted image …” from what they contain."],
  ["properties", "Auto-properties", "Fill in missing type, course, status and tags — only with values you already use."],
  ["links", "Link suggestions by meaning", "When you pause after a paragraph, suggest a related note to link."],
  ["similar", "Duplicate ideas", "Show notes that say the same thing in Tahoe Organize's vault health."],
  ["topics", "Smart folders by topic", "An “About” rule for Tahoe Organize's smart folders that matches by meaning."],
  ["writing", "Writing help", "Proofread, rewrite, summarize, or turn text into a list or table."],
  ["tasks", "Task extraction", "Find to-dos written as sentences and turn them into tasks with dates."],
  ["review", "Weekly review", "Draft a review of what changed in Projects and Areas this week."],
  ["ask", "Ask your notes", "Ask a question and get an answer from your notes, with links to where it came from."],
  ["related", "Related notes", "A sidebar of the notes closest in meaning to the one you're reading."],
  ["moc", "Map of content", "Draft an index note for a folder or a topic, grouped under headings."],
  ["mathwords", "Plain-English maths", "“days until Oct 14 =” in Tahoe Math: the question becomes a calculation."],
  ["reminders", "Deadlines in Reminders", "Tasks with due dates sync both ways with the Reminders app."],
  ["calendar", "Calendar", "Today's agenda, meeting notes from events, and your week in the weekly review."],
];

class IntelligenceSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.icon = "sparkles";
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    const save = () => p.saveSettings();
    containerEl.empty();

    // Model
    new Setting(containerEl).setName("Model").setHeading();
    const st = p.engine.state;
    const apple =
      st.llm === "available"
        ? "Ready — runs on this Mac, free and private."
        : st.helper === "building"
          ? "Setting up…"
          : st.helper === "failed"
            ? "Couldn't set up the helper. Install Xcode Command Line Tools (xcode-select --install)."
            : st.llm === "unknown"
              ? "Starting…"
              : `Not available (${st.llm}). Turn on Apple Intelligence in System Settings.`;
    new Setting(containerEl).setName("Apple Intelligence").setDesc(apple);
    new Setting(containerEl)
      .setName("Use")
      .setDesc("Ollama is used automatically when Apple Intelligence isn't available.")
      .addDropdown((d) =>
        d
          .addOption("auto", "Apple Intelligence")
          .addOption("ollama", "Ollama (local)")
          .setValue(s.provider)
          .onChange(async (v) => ((s.provider = v), await save()))
      );
    const ollamaRow = new Setting(containerEl).setName("Ollama model").setDesc("Checking…");
    p.engine.ollamaModels().then((models) => {
      const names = models.filter((m) => !/embed/i.test(m.name)).map((m) => m.name);
      ollamaRow.setDesc(names.length ? "A local model served by Ollama." : "Ollama isn't running or has no models.");
      ollamaRow.addDropdown((d) => {
        d.addOption("", "Automatic");
        for (const n of names) d.addOption(n, n);
        d.setValue(s.ollamaModel || "").onChange(async (v) => ((s.ollamaModel = v), await save()));
      });
    });
    const idx = p.index;
    new Setting(containerEl)
      .setName("Meaning index")
      .setDesc(
        st.embed === "available"
          ? `${idx.size.toLocaleString()} notes understood${idx.progress ? ` — reading ${idx.progress.done}/${idx.progress.total}` : ""}. Kept on this Mac, not synced.`
          : "Apple's text embeddings aren't ready on this Mac yet."
      )
      .addButton((b) =>
        b.setButtonText("Rebuild").onClick(() => {
          idx.entries.clear();
          idx.invalidate();
          idx.scan();
          new Notice("Reading every note again…");
          this.display();
        })
      );

    // Tools
    new Setting(containerEl).setName("Tools").setHeading();
    for (const [key, name, desc] of FEATURE_ROWS) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(s.features[key] !== false).onChange(async (v) => {
            s.features[key] = v;
            await save();
            new Notice("Restart Obsidian to turn this on or off everywhere.");
          })
        );
    }

    // Reminders and Calendar reach other apps: their settings show once they're on (Tools above).
    if (p.reminders) {
      new Setting(containerEl).setName("Reminders").setHeading();
      const rem = new Setting(containerEl)
        .setName("Sync deadlines with Reminders")
        .setDesc(
          s.remindersOn
            ? `On — tasks with due dates are in the “${s.reminderList}” list.${s.reminderLastSync ? ` Last synced ${new Date(s.reminderLastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}`
            : "Tasks with due dates appear in Reminders (and on your iPhone, Siri and lock screen). Completing one in either place completes both."
        );
      rem.addToggle((t) =>
        t.setValue(!!s.remindersOn).onChange(async (v) => {
          if (v) {
            const ok = await p.reminders.enable();
            if (ok) p.reminders.start();
          } else await p.reminders.disable();
          this.display();
        })
      );
      new Setting(containerEl)
        .setName("List")
        .setDesc("The Reminders list tasks go in. It's created if it doesn't exist.")
        .addText((t) => t.setPlaceholder("Obsidian").setValue(s.reminderList).onChange(async (v) => ((s.reminderList = v.trim() || "Obsidian"), await save())));
      new Setting(containerEl)
        .setName("New reminders go to")
        .setDesc("Reminders you add to the list in Reminders (or with Siri) become tasks in this note.")
        .addText((t) => t.setPlaceholder(p.reminders ? p.reminders.inboxNotePath() : "Reminders.md").setValue(s.reminderInbox).onChange(async (v) => ((s.reminderInbox = v.trim()), await save())));
    }

    if (s.features.calendar !== false) {
      new Setting(containerEl).setName("Calendar").setHeading();
      const calRow = new Setting(containerEl).setName("Calendars").setDesc("Checking…");
      p.engine.calendarAccess(false).then((a) => {
        calRow.setDesc(
          a === "full"
            ? "Connected. Events from the Calendar app — including Google Calendar if your Google account is added in System Settings → Internet Accounts — show in agendas and your weekly review."
            : "Read events from the Calendar app for agendas, meeting notes and the weekly review. Nothing is changed in Calendar."
        );
        if (a !== "full")
          calRow.addButton((b) =>
            b.setButtonText("Connect…").onClick(async () => {
              await ensureAccess(p);
              this.display();
            })
          );
      });
      new Setting(containerEl)
        .setName("Leave out")
        .setDesc("Calendars to skip, separated by commas — for example Holidays, Birthdays.")
        .addText((t) =>
          t
            .setPlaceholder("Holidays, Birthdays")
            .setValue((s.calendarSkip || []).join(", "))
            .onChange(async (v) => ((s.calendarSkip = v.split(",").map((x) => x.trim()).filter(Boolean)), await save()))
        );
    }


    // Link suggestions
    new Setting(containerEl).setName("Link suggestions").setHeading();
    new Setting(containerEl)
      .setName("How close a note must be")
      .setDesc("Higher shows fewer, closer suggestions.")
      .addSlider((sl) =>
        sl
          .setLimits(0.25, 0.65, 0.01)
          .setValue(s.linkThreshold)
          .setDynamicTooltip()
          .onChange(async (v) => ((s.linkThreshold = v), await save()))
      );

    // Writing help
    new Setting(containerEl).setName("Writing help").setHeading();
    new Setting(containerEl)
      .setName("Show the ✦ button by selected text")
      .setDesc("Writing help is also in the right-click menu and the command palette.")
      .addToggle((t) => t.setValue(s.writingButton).onChange(async (v) => ((s.writingButton = v), await save())));

    // Properties
    new Setting(containerEl).setName("Auto-properties").setHeading();
    for (const def of s.properties) {
      new Setting(containerEl)
        .setName(def.key)
        .setDesc(def.key === "course" ? "Values come from your notes and course codes in folder and note names, plus any you add (comma-separated)." : "Allowed values, comma-separated. Values already used in the vault are added.")
        .addText((t) =>
          t.setValue((def.values || []).join(", ")).onChange(async (v) => {
            def.values = v.split(",").map((x) => x.trim()).filter(Boolean);
            await save();
          })
        )
        .addToggle((t) => t.setValue(def.enabled).onChange(async (v) => ((def.enabled = v), await save())));
    }
    new Setting(containerEl)
      .setName("Tags")
      .setDesc("Add up to three tags to untagged notes, only from tags already in use.")
      .addToggle((t) => t.setValue(s.propertyTags).onChange(async (v) => ((s.propertyTags = v), await save())));
    new Setting(containerEl)
      .setName("Apply without reviewing")
      .setDesc("When filling in the whole vault, write suggestions straight away instead of saving them for review.")
      .addToggle((t) => t.setValue(s.propertyAutoApply).onChange(async (v) => ((s.propertyAutoApply = v), await save())));

    // Tasks
    new Setting(containerEl).setName("Tasks").setHeading();
    new Setting(containerEl)
      .setName("Due date format")
      .addDropdown((d) =>
        d
          .addOption("tasks", "Tasks plugin — 📅 2026-10-09")
          .addOption("dataview", "Dataview — [due:: 2026-10-09]")
          .addOption("plain", "Plain — (due Oct 9)")
          .setValue(s.taskFormat)
          .onChange(async (v) => ((s.taskFormat = v), await save()))
      );
    new Setting(containerEl)
      .setName("Add under heading")
      .addText((t) => t.setPlaceholder("Tasks").setValue(s.taskHeading).onChange(async (v) => ((s.taskHeading = v.trim() || "Tasks"), await save())));

    // Folders
    new Setting(containerEl).setName("Folders").setHeading();
    const k = knownFolders(this.app, s);
    const folder = (key, name, placeholder) =>
      new Setting(containerEl)
        .setName(name)
        .addText((t) => t.setPlaceholder(placeholder || "").setValue(s[key]).onChange(async (v) => ((s[key] = v.trim().replace(/\/$/, "")), await save())));
    folder("distillFolder", "Permanent notes", k.permanent);
    folder("reviewProjects", "Projects", k.projects);
    folder("reviewAreas", "Areas", k.areas);
    folder("reviewFolder", "Weekly reviews go in", k.root ? `${k.root}/Reviews` : "Reviews");
    folder("mocFolder", "Topic maps go in", k.root ? `${k.root}/Maps` : "Maps");
    folder("meetingFolder", "Meeting notes go in", k.inbox || "");
    new Setting(containerEl)
      .setName("Leave out")
      .setDesc("Folders the models should ignore, comma-separated.")
      .addTextArea((t) =>
        t.setValue((s.excludeFolders || []).join(", ")).onChange(async (v) => ((s.excludeFolders = v.split(",").map((x) => x.trim()).filter(Boolean)), await save()))
      );
  }
}

export { IntelligenceSettingTab, DEFAULT_SETTINGS };
