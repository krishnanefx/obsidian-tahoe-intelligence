/*
 * Tahoe Intelligence — on-device models for your notes.
 *
 *   Triage suggestions · Distill into a permanent note · Rename junk names ·
 *   Auto-properties · Link suggestions by meaning · Duplicate ideas ·
 *   Smart folders by topic · Writing help · Task extraction · Weekly review
 *
 * Everything runs on this Mac with Apple Intelligence (or a local Ollama
 * model), and nothing changes in a note until you've reviewed it.
 */

import { Plugin, Notice } from "obsidian";
import { Engine } from "./engine";
import { SemanticIndex } from "./index";
import { TriageSuggester } from "./features/triage";
import { IntelligenceSettingTab, DEFAULT_SETTINGS } from "./settings";
import * as features from "./features";
import { aiIcon } from "./ui";
import { loadNode } from "./node";

export default class TahoeIntelligencePlugin extends Plugin {
  async onload() {
    await loadNode();
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), saved);
    this.settings.features = Object.assign({}, DEFAULT_SETTINGS.features, saved.features);

    this.engine = new Engine(this);
    this.index = new SemanticIndex(this);
    this.triage = new TriageSuggester(this);

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("tahoe-ai-status");
    this.statusEl.hide();

    this.addSettingTab(new IntelligenceSettingTab(this.app, this));
    this.api = features.api(this);
    features.register(this);

    this.app.workspace.onLayoutReady(() => {
      // Let Obsidian settle first; the helper and the index start in the background.
      this.startTimer = window.setTimeout(() => this.startBackground(), 2500);
    });
  }

  async startBackground() {
    const ok = await this.engine.start();
    if (!ok) return this.refreshStatus();
    await this.index.load();
    if (this.engine.embedReady) this.index.start();
    await this.triage.load();
    if (this.settings.features.triage) this.triage.start();
    features.startBackground(this);
  }

  onunload() {
    window.clearTimeout(this.startTimer);
    this.engine.stop();
    this.index.saveNow();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Status bar: shown only while something is happening.
  refreshStatus() {
    const el = this.statusEl;
    if (!el) return;
    const busy = [];
    if (this.engine.state.helper === "building") busy.push("Setting up Apple Intelligence…");
    const p = this.index.progress;
    if (p && p.total > 3) busy.push(`Reading notes · ${p.done}/${p.total}`);
    if (this.jobStatus) busy.push(this.jobStatus);
    if (!busy.length) return el.hide();
    el.show();
    el.empty();
    aiIcon(el.createSpan());
    el.createSpan({ text: busy[0] });
  }

  setJobStatus(text) {
    this.jobStatus = text || null;
    this.refreshStatus();
  }

  notice(text, timeout) {
    return new Notice(text, timeout);
  }
};
