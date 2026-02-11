# autoname-sessions

Automatically names Pi sessions based on their transcript purpose.

## Command

- `/autoname-sessions [options]`

Options:

- `--dry-run` / `dry run` — preview only, do not write names
- `--force` — include sessions even if they already have names
- `--limit <n>` or `--limit=<n>` — max sessions to process (default 200)
- `--quiet` — suppress summary notifications

## How it works

1. Loads all sessions via `SessionManager.listAll()`.
2. Builds compact transcript samples from user/assistant/tool-result messages.
3. Calls a nested `pi -p` prompt to infer a concise lowercase name.
4. Falls back to a deterministic first-user-message heuristic if inference fails.
5. Stores a cache under `~/.pi/agent/cache/autoname-sessions.json` to avoid unnecessary renames.

## Autorun mode (optional)

Set environment variable:

```bash
export PI_AUTONAME_SESSIONS_AUTO=1
```

When enabled, the extension runs once per process on `session_start`.
