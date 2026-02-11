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

## Local usage

From any project where you use Pi:

```bash
pi install ~/workspace/agent-stuff
```

Or one-off:

```bash
pi -e ~/workspace/agent-stuff/pi-extensions/repo-shared-sessions/index.ts
```

## Development notes

- Extensions are written in TypeScript and loaded by Pi via runtime transpilation.
- This package declares Pi core packages as `peerDependencies`.
- Keep extension behavior safe and deterministic (no hidden side effects).

## License

MIT
