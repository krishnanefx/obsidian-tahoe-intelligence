/*
 * Node's modules, on the desktop app only. Obsidian on phones and tablets has
 * no Node, so they're loaded with import() when the plugin starts on a
 * desktop (loadNode, awaited first thing in onload), and the modules that need
 * them use these bindings, which fill in then. On a phone they stay null and
 * nothing that needs them runs.
 */

import { Platform } from "obsidian";

export let fs = null;
export let path = null;
export let os = null;
export let childProcess = null;
export let http = null;

let loading = null;

export function loadNode() {
  if (!loading) loading = load();
  return loading;
}

async function load() {
  if (Platform.isDesktop) {
    const [fsModule, pathModule, osModule, childProcessModule, httpModule] = await Promise.all([import("fs"), import("path"), import("os"), import("child_process"), import("http")]);
    fs = fsModule;
    path = pathModule;
    os = osModule;
    childProcess = childProcessModule;
    http = httpModule;
  }
}
