// Bundles src/main.js into the main.js Obsidian loads.
// usage: node esbuild.config.mjs [--watch]
import { build, context } from "esbuild";

const notice = `/*
 * Tahoe Intelligence — https://github.com/krishnanefx/obsidian-tahoe-intelligence (MIT).
 * Built from src/; edit the sources, not this file.
 */`;

// Node's own modules, imported with import("fs") behind Platform.isDesktop (see
// src/node.js), are bundled as one-line wrappers around require(), so they load
// the CommonJS way in Obsidian's window.
const BUILTINS = /^(fs|path|os|child_process|http|https|crypto|util|events|stream|url)$/;
const nodeBuiltins = {
  name: "node-builtins",
  setup(b) {
    // The wrapper's own require() goes to Node itself.
    b.onResolve({ filter: BUILTINS }, (args) => (args.namespace === "node-builtin" ? { path: args.path, external: true } : { path: args.path, namespace: "node-builtin" }));
    b.onLoad({ filter: /.*/, namespace: "node-builtin" }, (args) => ({ contents: `module.exports = require(${JSON.stringify(args.path)});`, loader: "js" }));
  },
};

const options = {
  entryPoints: ["src/main.js"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  plugins: [nodeBuiltins],
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  loader: { ".py": "text", ".swift": "text", ".applescript": "text", ".h": "text" },
  minify: true,
  legalComments: "eof",
  logLevel: "warning",
  banner: { js: notice },
  metafile: process.argv.includes("--meta"),
};

if (process.argv.includes("--watch")) {
  await (await context(options)).watch();
} else {
  const result = await build(options);
  if (result.metafile) {
    const fs = await import("node:fs");
    fs.writeFileSync("meta.json", JSON.stringify(result.metafile));
  }
  console.log("built main.js");
}
