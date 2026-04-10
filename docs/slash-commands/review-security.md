---
summary: 'Red-team a PR for security regressions, policy violations, and boundary breaks.'
description: Review a PR or diff like a security engineer: read SECURITY.md first, infer trust boundaries, hunt for uncommon vulnerability classes, and report only evidence-backed findings.
argument-hint: <pr-number|pr-url|diff-scope?>
read_when:
  - Reviewing a PR specifically for security risk.
  - Checking whether a change violates SECURITY.md, trust boundaries, or existing security posture.
  - Red-teaming a diff for uncommon CVEs, exploit chains, and subtle boundary regressions.
---
# /review-security

Input
- Target: `$1` = PR number, PR URL, branch diff, commit range, file list, or current diff.
- If missing: review the current git diff.
- If the scope is ambiguous: ask once, then stop.

Mission
- You are red-teaming this change as a security expert.
- Assume the author is well-intentioned but may have weakened a boundary, expanded trust, exposed data, or introduced an exploitable edge case.
- Look for uncommon CVEs, exploit chains, and anything that violates the project’s stated security policy, posture, assumptions, or trust boundaries.
- Treat `SECURITY.md` as a first-class contract, not optional background reading.

Non-goals
- Do not do a general code review.
- Do not spend time on style, naming, readability, or normal refactors unless they create a real security issue.
- Do not invent speculative issues without a plausible exploit path.

0) Mandatory reads before reviewing
1. Read the nearest applicable `SECURITY.md` completely.
2. Read any adjacent security-relevant docs referenced by it.
3. Read local instructions (`AGENTS.md`) and any architecture/auth/deployment docs relevant to the changed area.
4. Only then review the diff.

If `SECURITY.md` is missing:
- say that explicitly
- infer likely boundaries from code, docs, auth model, deployment assumptions, and existing tests
- lower confidence on policy-violation claims, but still review for security defects

1) Establish review scope
Use the smallest correct scope:
- current unstaged work: `git diff`
- staged work: `git diff --cached`
- staged + unstaged: review both
- explicit PR/branch/commit: use exactly that diff
- explicit files: review those files plus directly affected callers/callees/config/tests

2) Extract the security contract first
Before judging the change, write down the repo’s implied security model from `SECURITY.md` and surrounding docs:
- assets being protected
- trusted vs untrusted inputs
- authn/authz model
- tenant/user/environment boundaries
- secret handling rules
- allowed egress/ingress/network assumptions
- logging/privacy restrictions
- secure default expectations
- operational constraints (least privilege, isolation, signing, verification, rotation, auditability)

Then compare the diff against that contract.

3) Red-team mindset
Act like an attacker looking for:
- new entry points
- trust boundary erosion
- places where validation happens too late or not at all
- places where internal-only assumptions became user-reachable
- opportunities to chain two “small” changes into one exploit
- security-sensitive defaults hidden behind convenience improvements

Prefer exploitability over checklist compliance.

4) Hunt for meaningful security risks
Check for the usual classes, but do not stop there.

Core classes
- authn/authz bypass or privilege expansion
- IDOR / object capability leaks
- secret/token/key exposure
- injection: shell, SQL, template, LDAP, regex, email/header, HTML/Markdown, path
- SSRF and internal metadata/service discovery exposure
- XSS / HTML injection / origin confusion
- CSRF or missing request origin protections
- path traversal / symlink / archive extraction (`zip-slip`, `tar-slip`)
- deserialization / parser abuse / unsafe eval / dynamic execution
- insecure crypto, missing verification, downgrade paths
- unsafe temp file or filesystem races
- untrusted redirect / callback / webhook handling
- rate-limit, DoS, resource exhaustion, retry storm, queue abuse
- privacy leaks through logs, metrics, traces, errors, analytics, or debug endpoints
- supply-chain trust mistakes: unsigned artifacts, checksum gaps, dependency confusion, install-time script trust

Less-common / easy-to-miss classes
- Unicode confusable, normalization, or case-folding bugs that bypass validation or ACLs
- path canonicalization mismatches across OSes or libraries
- parser differentials between validation and execution layers
- forwarded-header trust (`X-Forwarded-*`, host/origin confusion)
- cache poisoning / cache key omission for identity-sensitive data
- wildcard CORS or origin reflection that becomes exploitable with credentials
- presigned URL scope/TTL/content-type mistakes
- webhook signature verification gaps, body mutation before verification, replay windows
- archive/media/document parser abuse
- sandbox / plugin / extension escape paths
- prompt injection or tool-execution boundary failures in AI features
- data exfil through model context, retrieval, connectors, or hidden tools
- feature-flag or config changes that silently widen exposure in production
- migration/backfill scripts that bypass normal permission checks
- test-only endpoints, debug flags, admin affordances, or fallback credentials becoming reachable

Dependency and platform review
- new packages, actions, containers, binaries, models, or services
- changed permissions in CI/CD, cloud roles, API scopes, or GitHub Actions
- lockfile drift, install scripts, postinstall hooks, binary downloads
- image base changes, package manager trust, checksum/signature verification

5) Compare against existing boundaries, not idealized ones
Ask:
- Does this diff let one actor reach data or actions previously reserved for another?
- Does it trust input that used to be verified elsewhere?
- Does it move a security check later in the flow, where bypass becomes possible?
- Does it widen exposure from local -> repo -> org -> internet?
- Does it turn “internal” or “debug” functionality into something remotely reachable?
- Does it create a new persistence, replay, or exfiltration path?
- Does it violate anything explicitly promised in `SECURITY.md`?

6) Review adjacent code when needed
Do not limit yourself to changed lines if the exploitability depends on nearby code.
Read callers, callees, middleware, validators, serializers, config, schema, and tests until you understand:
- where input first enters
- where trust is established
- where permissions are checked
- where sensitive data is emitted
- where failure defaults land

7) Evidence bar
Only report findings that are:
- evidence-backed by code or config
- tied to an actual policy, boundary, or exploit path
- more than a style or theoretical concern

Good findings include:
- exact file and line or nearest symbol
- what attacker-controlled input or capability is involved
- what boundary is crossed or policy is violated
- why existing code does not sufficiently prevent it
- how it could realistically be exploited

8) Output format
Return a concise security review with these sections.

## Security findings
For each finding, include:
- Severity: `critical`, `high`, `medium`, or `low`
- Confidence: `high`, `medium`, or `low`
- Location: `file:line` or symbol
- Category: one of `auth`, `authz`, `secrets`, `injection`, `ssrf`, `xss`, `crypto`, `filesystem`, `supply-chain`, `privacy`, `dos`, `ai-boundary`, `policy`, or `other`
- Boundary/policy violated: cite the `SECURITY.md` section heading if applicable
- Issue: one sentence
- Why it matters: short exploit-oriented explanation
- Exploit sketch: 1-3 sentences, only if helpful
- Recommended fix: concrete next step

## Security questions
Use this only for ambiguous but important concerns where the answer depends on missing context.
Do not turn clear findings into questions.

## No material issues
If nothing significant is found, say so directly and mention what you checked.

9) Prioritization rules
Prioritize:
1. boundary breaks
2. auth/authz failures
3. secret exposure or cross-tenant leakage
4. remote code execution / injection / SSRF / XSS
5. supply-chain trust regressions
6. production-only exposure due to config or CI/CD changes
7. observability/privacy leaks and lower-severity hardening gaps

10) Style rules for the review
- Be blunt, specific, and evidence-based.
- Prefer a short list of high-signal findings over a long list of weak suspicions.
- If a concern depends on assumptions, state them explicitly.
- Cite the violated `SECURITY.md` heading whenever possible.
- If a change is safe because of an existing safeguard, say that briefly instead of forcing a finding.

Suggested upgrade ideas
- Add a repo-specific variant with mandatory extra docs (`ARCHITECTURE.md`, auth docs, threat model, tenancy docs).
- Add a checklist appendix for common web/backend/mobile/infra review targets.
- Add a mode that compares changed dependencies, CI permissions, and deployment manifests automatically.
