# Docs

Repository documentation that complements the shipped Pi extensions.

## Slash commands

- [`slash-commands/landpr.md`](slash-commands/landpr.md) — PR landing guidance that merges the best parts of two source prompts:
  - the public `agent-scripts` `/landpr` flow
  - a stricter internal variant with additional safety checks

Key additions in this version:
- optional repo guard template
- PR head SHA capture and remote drift detection
- safer force-push lease usage for rebased PR branches
- post-merge comment handling via temp files instead of inline `--body`
- explicit merge verification and recovery steps
- base-branch handling without hard-coding `main`
