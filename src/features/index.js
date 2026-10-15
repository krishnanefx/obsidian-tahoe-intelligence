// Wires each feature into the plugin: commands, menus, editor extensions,
// background work, and the API that Tahoe Organize uses.

import { TFile } from "obsidian";
import * as distill from "./distill";
import * as rename from "./rename";
import * as properties from "./properties";
import * as links from "./links";
import * as similar from "./similar";
import * as topics from "./topics";
import * as writing from "./writing";
import * as tasks from "./tasks";
import * as review from "./review";
import * as related from "./related";
import * as ask from "./ask";
import * as moc from "./moc";
import * as reminders from "./reminders";
import * as calendar from "./calendar";
import { translateMath } from "./mathwords";
import { hybridRelated } from "../keywords";

const modules = {
  distill: () => distill,
  rename: () => rename,
  properties: () => properties,
  links: () => links,
  similar: () => similar,
  topics: () => topics,
  writing: () => writing,
  tasks: () => tasks,
  review: () => review,
  related: () => related,
  ask: () => ask,
  moc: () => moc,
  reminders: () => reminders,
  calendar: () => calendar,
};

function register(plugin) {
  const f = plugin.settings.features;
  for (const [key, load] of Object.entries(modules)) {
    if (f[key] === false) continue;
    const mod = load();
    if (mod.register) mod.register(plugin);
  }
}

function startBackground(plugin) {
  const f = plugin.settings.features;
  for (const [key, load] of Object.entries(modules)) {
    if (f[key] === false) continue;
    const mod = load();
    if (mod.startBackground) mod.startBackground(plugin);
  }
}

// What other plugins (Tahoe Organize) can ask for.
function api(plugin) {
  return {
    version: 1,
    get ready() {
      return plugin.engine.appleReady || plugin.engine.state.ollama?.length > 0;
    },
    get indexReady() {
      return plugin.index.ready && plugin.index.size > 0;
    },
    onIndexChange: (fn) => plugin.index.onChange(fn),

    // Triage: { folder, title, tags } for an inbox note.
    triageSuggestion: (file) => (plugin.settings.features.triage ? plugin.triage.suggest(file) : Promise.resolve(null)),
    cachedTriage: (file) => plugin.triage.cached(file),

    // Vault Health: notes that say the same thing.
    duplicates: (opts) => modules.similar().duplicates(plugin, opts),
    keepBoth: (a, b) => modules.similar().keepBoth(plugin, a, b),

    // Smart Folders: notes about a topic.
    notesAbout: (topic, opts) => modules.topics().notesAbout(plugin, topic, opts),

    // Suggested properties for a note (null if it has them all).
    suggestProperties: (file) => modules.properties().suggestFor(plugin, file),

    // Tahoe Math: "days until Oct 14" → 'daysUntil("Oct 14")'.
    translateMath: (question, opts) => (plugin.settings.features.mathwords === false ? Promise.resolve(null) : translateMath(plugin, question, opts)),

    // Related notes (meaning + distinctive words), for tests and other plugins.
    related: (file, opts) => hybridRelated(plugin, file, opts),

    // Passages Ask would use for a question (for checking retrieval).
    retrieve: (q) => ask.retrieve(plugin, q, []),

    isFile: (f) => f instanceof TFile,
  };
}

export { register, startBackground, api };
