# Pi extensions

A small collection of extensions for [pi](https://pi.dev/).

## Install

Install from this repository:

```bash
pi install git:github.com/phum1901/agent-stuff
```

Or install the package for the current project:

```bash
pi install -l git:github.com/phum1901/agent-stuff
```

## Extensions

- `prompt-editor.ts` - Adds prompt history, model modes, mode switching, and a mode label in the editor.
- `tps-stats.ts` - Shows output tokens per second and token usage after each turn.
- `auto-compact.ts` - Adds percent-of-window and used-tokens auto-compact thresholds. Lowest of extension thresholds and Pi built-in wins. Single command `/auto-compact` shows status or sets values.
- [`btw.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/btw.ts) - Adds a `/btw` side-chat popover for quick tangential questions.
- [`whimsical.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/whimsical.ts) - Replaces the default thinking and status text with random whimsical phrases.

The prompt editor stores modes in `~/.pi/agent/modes.json`, or in `.pi/modes.json` when a project file exists.
The external extensions are installed from the pinned `mitsuhiko/agent-stuff` dependency.

## Skills

- `discuss` - Turn rough ideas into implementation plans through focused questions.

Install only the skill with:

```bash
npx skills add https://github.com/phum1901/agent-stuff --skill discuss
```
