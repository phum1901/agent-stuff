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
- `auto-compact.ts` - Adds percent-of-window and used-tokens auto-compact thresholds. Lowest of extension thresholds and Pi built-in wins. Checks before a new prompt and after tool results, before the next response. Single command `/auto-compact` shows status or sets values.
- [`btw.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/btw.ts) - Adds a `/btw` side-chat popover for quick tangential questions.
- [`whimsical.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/whimsical.ts) - Replaces the default thinking and status text with random whimsical phrases.

The prompt editor stores modes in `~/.pi/agent/modes.json`, or in `.pi/modes.json` when a project file exists.
The external extensions are installed from the pinned `mitsuhiko/agent-stuff` dependency.

### Auto-compaction

Requires Pi 1.0.0 or newer. Thresholds are stored in `~/.pi/agent/auto-compact.json`.
The extension uses Pi's per-model reserve and recent-history settings. It does not compact after a final answer or force another response. Queued messages do not prevent between-turn compaction.

Between turns, it uses Pi's summary generator and returns a compaction entry without aborting the run. This path does not emit `session_before_compact` or `session_compact` hooks. Pi's built-in threshold and overflow recovery remain active.

## Skills

- `discuss` - Turn rough ideas into implementation plans through focused questions.

Install only the skill with:

```bash
npx skills add https://github.com/phum1901/agent-stuff --skill discuss
```
