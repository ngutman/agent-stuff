# repo-conditional-resources

Conditionally expose Pi skills, prompt templates, and themes based on the current git repository.

## What it does

This extension listens to Pi's `resources_discover` event, inspects the current repository, and returns extra `skillPaths`, `promptPaths`, and `themePaths` only when a configured profile matches.

This is useful when you want:

- globally installed Pi behavior
- repository-specific workflows
- a stable machine-local indirection layer via symlinks under `~/.pi/agent/repo-resources`

## Default OpenClaw setup

Bundled defaults:

- load `~/.pi/agent/repo-resources/openclaw/skills` for `openclaw/*` repos
- load `~/.pi/agent/repo-resources/openclaw/prompts` for `openclaw/*` repos except `openclaw/maintainers`

The `maintainers` prompt exclusion avoids duplicate prompt discovery because that repo already contains `.pi/prompts`.

## Config files

Bundled defaults live in:

- `pi-extensions/repo-conditional-resources/defaults.json`

Optional machine-local overrides live in:

- `~/.pi/agent/repo-conditional-resources.json`

Or set a custom override path with:

- `PI_REPO_CONDITIONAL_RESOURCES_CONFIG=/path/to/config.json`

## Override format

```json
{
  "debug": false,
  "replaceDefaults": false,
  "profiles": [
    {
      "name": "openclaw-skills",
      "enabled": true,
      "match": {
        "repoPatterns": ["openclaw/*"],
        "excludeRepoPatterns": ["openclaw/experimental-*"],
        "remotePatterns": ["github\\.com[:/]openclaw/.*"],
        "pathPatterns": ["/Users/alice/work/openclaw/.*"]
      },
      "resources": {
        "skills": ["~/.pi/agent/repo-resources/openclaw/skills"]
      }
    }
  ]
}
```

## Matching fields

- `repoPatterns`: simple `*` globs against detected `owner/repo`
- `remotePatterns`: regexes against git remote URLs
- `pathPatterns`: regexes against git top-level paths
- `excludeRepoPatterns`, `excludeRemotePatterns`, `excludePathPatterns`: exclusion variants

## Resource fields

- `skills`
- `prompts`
- `themes`

Paths support `~` expansion. Relative paths resolve from the directory containing the config file.
