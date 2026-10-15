# Contributing to Tahoe Intelligence

Thanks for helping. Tahoe Intelligence is a small project made and kept up by one person, so the most useful help is a clear report.

## Bugs, ideas and questions

- **A bug:** [open an issue](https://github.com/krishnanefx/obsidian-tahoe-intelligence/issues/new/choose) with the bug form. The steps to reproduce it, your Tahoe Intelligence and Obsidian versions and your device are what make a bug fixable.
- **An idea:** the feature-request form. Say what you were trying to do before how it could work.
- **A question, or help setting it up:** [Discussions](https://github.com/krishnanefx/obsidian-tahoe-intelligence/discussions).

## Pull requests

Small fixes (a bug, a typo, a clearer sentence) are welcome as pull requests. For anything bigger, open an issue first, so we can agree on the approach before you spend time on it.

```sh
npm ci
npm run build     # writes main.js
```

Copy `main.js`, `manifest.json` and `styles.css` into a test vault's `.obsidian/plugins/tahoe-intelligence/` to try it.

- Plain JavaScript as ES modules in `src/`. Node's modules come only from `src/node.js`, which loads them on desktop only, so the plugin still loads on phones.
- Styles in `styles.css`, with Obsidian's CSS variables and without `:has()` or `!important`.
- Before sending, run Obsidian's lint, `eslint-plugin-obsidianmd` with its recommended config: it's what the community directory's review runs.
- Keep the README's disclosures true: anything new that uses the network, another app, the clipboard or files outside the vault has to be listed there.

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).
