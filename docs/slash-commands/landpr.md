---
summary: 'Land PR end-to-end (temp rebase, full gate, merge, comment, verify, cleanup).'
description: Land PR end-to-end with extra safety checks for rebases, fork pushes, merge confirmation, and post-merge bookkeeping.
argument-hint: <pr-number|pr-url?>
read_when:
  - Landing a PR end-to-end (temp rebase, full gate, merge, thanks).
---
# /landpr

Input
- PR: $1 (number or URL). If missing: use most recent PR in convo; if ambiguous: ask.

Goal
- End state: GitHub PR state = `MERGED` (never `CLOSED`).
- Keep the landing flow deterministic: temp rebase, full gate, safe push, merge, post-merge comment, verify, cleanup.

0) Guardrails
- `git status -sb` clean (no local changes).
- If PR is draft, has conflicts, or you can’t push to the head branch: stop + ask.
- Prefer repo default branch / PR base as base branch (often `main`, but do not hard-code it).
- If this command is intended for a single repository, add an explicit repo guard before proceeding. Template:

```sh
origin_url=$(git remote get-url origin 2>/dev/null || true)
case "$origin_url" in
  *github.com:<owner>/<repo>*|*github.com/<owner>/<repo>*) ;;
  *)
    echo "ABORT: /landpr is restricted to <owner>/<repo>."
    exit 1
    ;;
esac
```

1) Capture PR context

```sh
PR="$1"
gh pr view "$PR" --json number,title,state,isDraft,mergeable,author,baseRefName,headRefName,headRefOid,headRepository,maintainerCanModify --jq '{number,title,state,isDraft,mergeable,author:.author.login,base:.baseRefName,head:.headRefName,headSha:.headRefOid,headRepo:.headRepository.nameWithOwner,maintainerCanModify}'
prnum=$(gh pr view "$PR" --json number --jq .number)
contrib=$(gh pr view "$PR" --json author --jq .author.login)
base=$(gh pr view "$PR" --json baseRefName --jq .baseRefName)
head=$(gh pr view "$PR" --json headRefName --jq .headRefName)
head_sha=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
head_repo_url=$(gh pr view "$PR" --json headRepository --jq .headRepository.url)
if [ -z "$head_repo_url" ] || [ "$head_repo_url" = "null" ]; then
  head_repo_url=$(git remote get-url origin | sed -E 's#^(git@github.com:)([^.]+/[^.]+)(\\.git)?$#https://github.com/\\2#; s#\\.git$##')
fi
```

2) Update base + create temp branch

```sh
git checkout "$base"
git pull --ff-only
git checkout -b "temp/landpr-$prnum"
```

3) Checkout PR + rebase onto temp

```sh
gh pr checkout "$PR"
git rebase "temp/landpr-$prnum"
```

4) Fix + tests + changelog
- Implement fixes if needed (keep scope tight).
- Add or adjust tests (prefer regression coverage when it fits).
- If the repository keeps a changelog, update it and include `#$prnum` + thanks `@$contrib`.
- If the repo does not use a changelog, skip that part rather than inventing one.

5) Gate (before commit)
- Run the full repo gate: lint, typecheck, tests, docs/build checks, or the project’s canonical verification command.
- Record the exact commands you ran; reuse them in the post-merge PR comment.
- Example only: `pnpm lint && pnpm build && pnpm test`

6) Commit (via `committer`)

```sh
committer "fix: <summary> (#$prnum) (thanks @$contrib)" CHANGELOG.md <changed files>
land_sha=$(git rev-parse HEAD)
```

- If no changelog was updated, omit `CHANGELOG.md` from the file list.
- Keep the subject aligned with the repo’s commit convention.

7) Push rebased PR branch (fork-safe + drift-safe)

```sh
git remote add prhead "$head_repo_url.git" 2>/dev/null || git remote set-url prhead "$head_repo_url.git"
git fetch prhead "$head"
remote_ref="prhead/$head"
remote_sha=$(git rev-parse "$remote_ref")

# Fail loudly on remote drift; do not auto-replay branch history.
if [ "$remote_sha" != "$head_sha" ]; then
  echo "ABORT: PR head moved during land ($head_sha -> $remote_sha)."
  echo "Re-run /landpr from step 1."
  exit 1
fi

# Replay guard: compare only against the rebased base, not against the pre-rebase PR head.
ahead_from_base=$(git rev-list --count "temp/landpr-$prnum..HEAD")
if [ "$ahead_from_base" -gt 8 ]; then
  echo "ABORT: suspicious commit delta vs rebased base ($ahead_from_base > 8)."
  echo "Do NOT rewrite/push. Investigate branch drift or replay."
  exit 1
fi

git push --force-with-lease=refs/heads/$head:$head_sha prhead "HEAD:$head"
```

8) Merge PR
- Rebase: `gh pr merge "$PR" --rebase`
- Squash: `gh pr merge "$PR" --squash`
- Use the repository’s normal merge strategy.
- Never `gh pr close` as a substitute for landing.

9) Comment with SHAs + thanks
- Post this immediately after merge, before any local sync steps.
- Run it as its own shell command. Do not chain it with `git checkout`, `git pull`, or branch deletion.
- Never switch this to `gh pr comment --body "..."` if the body contains markdown code ticks or multiple lines.

```sh
merge_sha=$(gh pr view "$PR" --json mergeCommit --jq '.mergeCommit.oid')
gate_cmds="<exact gate commands run in step 5>"
comment_tpl=$(mktemp)
comment_out=$(mktemp)

cat >"$comment_tpl" <<'EOF'
Landed via temp rebase onto __BASE__.

- Gate: `__GATE__`
- Land commit: __LAND_SHA__
- Merge commit: __MERGE_SHA__

Thanks @__CONTRIB__!
EOF

BASE="$base" GATE="$gate_cmds" LAND_SHA="$land_sha" MERGE_SHA="$merge_sha" CONTRIB="$contrib" \
  perl -0777 -pe '
    s/__BASE__/$ENV{BASE}/g;
    s/__GATE__/$ENV{GATE}/g;
    s/__LAND_SHA__/$ENV{LAND_SHA}/g;
    s/__MERGE_SHA__/$ENV{MERGE_SHA}/g;
    s/__CONTRIB__/$ENV{CONTRIB}/g;
  ' "$comment_tpl" > "$comment_out"

if rg -q '(__[A-Z_]+__|REPLACE_)' "$comment_out"; then
  echo "ABORT: unresolved placeholder in PR comment body."
  exit 1
fi

gh pr comment "$PR" -F - < "$comment_out"
```

10) Verify state == `MERGED`

```sh
gh pr view "$PR" --json state,mergedAt --jq '.state + " @ " + .mergedAt'
```

11) Sync base locally

```sh
git checkout "$base"
git pull --ff-only
```

12) Cleanup

```sh
git branch -D "temp/landpr-$prnum"
```

Recovery rule
- If merge already succeeded and any later step fails, do not restart from step 1.
- First confirm the PR state.
- If it is already `MERGED`, finish any missing post-merge work in this order: landing comment, merged-state verification, local base sync, temp-branch cleanup.

Suggested upgrades you may want to add later
- A repo-specific variant that hard-fails outside a known repo.
- A project-specific gate macro so step 5 uses a single canonical command.
- A changelog toggle for repos that never update release notes in PR land flows.
- A `--dry-run` or checklist mode that prints planned commands before running them.
