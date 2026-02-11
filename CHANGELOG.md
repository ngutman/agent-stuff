# Changelog

All notable changes to this repository are documented here.

## Unreleased

- Added `autoname-sessions` extension with manual command and optional autorun mode (`PI_AUTONAME_SESSIONS_AUTO=1`).
- Added transcript-based naming with deterministic fallback and cache-backed rename safety.

## 0.1.0

- Initial repository scaffold modeled after `mitsuhiko/agent-stuff`.
- Added `repo-shared-sessions` extension (`/repo-resume`, `/repo-resume latest`, `/repo-sessions`).
- Hardened remote normalization and improved command argument validation.
- Improved session lookup performance by resolving repository identities in parallel.
