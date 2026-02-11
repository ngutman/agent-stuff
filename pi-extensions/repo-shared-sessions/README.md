# repo-shared-sessions

Resume Pi sessions across different folders of the same git repository.

## Commands

- `/repo-resume` - pick from matching sessions
- `/repo-resume latest` - jump to latest matching session
- `/repo-sessions` - alias for `/repo-resume`

## Matching strategy

1. If available, compare normalized `remote.origin.url`.
2. Otherwise compare git top-level directory.

This allows session discovery across nested directories and worktrees that share a remote.

## Notes

- Non-git directories are rejected with a clear error.
- In non-interactive mode, `/repo-resume` behaves like `/repo-resume latest`.
