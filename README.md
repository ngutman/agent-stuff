# agent-stuff

A Pi package with personal extensions by **ngutman**.

This repository is intentionally similar in spirit and layout to [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)

## Included extensions

### `repo-shared-sessions`

Path: `pi-extensions/repo-shared-sessions/index.ts`

Commands:

- `/repo-resume` — open an interactive selector of sessions from the same git repository
- `/repo-resume latest` — jump directly to the most recently modified matching session
- `/repo-sessions` — alias for `/repo-resume`

How repository matching works:

1. Prefer `remote.origin.url` (normalized; supports SSH/HTTPS variants)
2. Fall back to git top-level path when no remote exists

### `autoname-sessions`

Path: `pi-extensions/autoname-sessions/index.ts`

Command:

- `/autoname-sessions [--dry-run] [--force] [--limit <n>] [--quiet]`

This command infers concise purpose-based session names from transcript samples, with deterministic fallback behavior and a local cache to avoid unnecessary renames.

### `copy-last-response`

Path: `pi-extensions/copy-last-response/index.ts`

Triggers:

- `Alt+O` — copy the last completed assistant response to the clipboard as markdown
- `/copy-last-response` — same behavior via slash command

This copies only assistant text blocks, preserving markdown and excluding thinking/tool-call blocks.

### `repo-conditional-resources`

Path: `pi-extensions/repo-conditional-resources/index.js`

Purpose:

- conditionally load Pi skills/prompts/themes based on the current git repository
- keep globally installed workflows hidden unless a matching repo is open
- support machine-local symlink targets under `~/.pi/agent/repo-resources/`

Default bundled profiles:

- load OpenClaw skills for `openclaw/*`
- load OpenClaw prompts for `openclaw/*` except `openclaw/maintainers`

## Documentation

### Slash commands

- [`docs/slash-commands/landpr.md`](docs/slash-commands/landpr.md) — a reusable PR landing workflow that combines the core flow from `agent-scripts` with extra safety checks from a stricter internal prompt variant, including head-drift detection, safer PR comment posting, merge verification, and recovery guidance.
- [`docs/slash-commands/review-security.md`](docs/slash-commands/review-security.md) — a red-team-style PR security review prompt that reads `SECURITY.md` first, checks for policy/boundary violations, and prioritizes exploitability over generic review commentary.

## Usage

Install directly from GitHub:

```bash
pi install git:github.com/ngutman/agent-stuff
```

Install from a local clone:

```bash
pi install ~/workspace/agent-stuff
```

One-off load of a single extension:

```bash
pi -e ~/workspace/agent-stuff/pi-extensions/repo-shared-sessions/index.ts
pi -e ~/workspace/agent-stuff/pi-extensions/copy-last-response/index.ts
```

## Development notes

- Extensions are written in TypeScript and loaded by Pi via runtime transpilation.
- This package declares Pi core packages as `peerDependencies`.
- Keep extension behavior safe and deterministic (no hidden side effects).

## License

MIT
