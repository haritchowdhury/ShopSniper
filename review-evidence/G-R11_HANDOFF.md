# G-R11 handoff — Repository-wide redacted secret and workflow hygiene

Status: **COMPLETE (provider rotation remains external)**

Date: 2026-08-01

## Outcome

The scanner now resolves the repository root from its own installed file path,
so caller working directory cannot narrow scope. Root documents/contracts,
backend, and frontend are scanned by one deterministic traversal. Findings still
contain only pattern class, repository-relative path, and line number.

The exact new workflow-export paths remain ignored. The two pre-rename workflow
paths remain in the Git index as pending deletions and will disappear only when
the user's existing project-rename changes are committed; nothing was staged or
committed here.

## Changed files

Runtime:

- `scripts/check-secrets.js`

Tests:

- `test/secret-scan.test.js`

No workflow contents, credential values, source/provider behavior, schema,
migration, frontend behavior, deployment, Git staging, commit, or running server
was changed.

## Scope contract

- Repository root is derived from `scripts/check-secrets.js`, never `cwd`.
- Traversal is sorted and deterministic and includes root/backend/frontend files,
  including untracked candidate source, configuration, documentation, fixtures,
  migrations, `.env.example`, contracts, and handoffs.
- Symlinks are not followed.
- Only these categories are excluded:
  - `.git`, dependency, coverage, and known build-output directory segments;
  - exact expected local secret files `.env`, `email_scraper/.env`, and
    `frontend/.env.local`; and
  - exact local exports `email_scraper/My workflow 3.json` and
    `email_scraper/My workflow 4.json`.
- Similar workflow filenames under other paths are not hidden.
- Binary files are skipped after a null-byte check.
- Unreadable non-missing files fail the scan; deleted tracked paths do not cause
  source-content fallback or path guessing.
- The credential-assignment expression now requires a true key boundary, avoiding
  a controlled false positive on the frontend's `new-password` autocomplete
  string without weakening real assignment detection.

## Controlled evidence

One test creates short-lived, fictional credential-shaped fixtures in root,
backend, frontend, and a nested similar-workflow-name path. All four are detected.
The output object contains only `file`, `line`, and `pattern`, and the constructed
value is absent. Cleanup runs in `finally` and the final repository scan is clean.

Another test proves exact local env/workflow exclusions and confirms that root
plans, the shared score contract, `.env.example`, backend source, provider fixture
documentation, and frontend source stay in scope.

## Verification

Executed from repository root/backend/frontend respectively:

```text
node /home/harit/Email Scrapper/email_scraper/scripts/check-secrets.js
PASS from all three working directories with identical clean output (exit 0)
```

Required checks:

```text
npm --prefix email_scraper run check:secrets
PASS — zero redacted findings (exit 0)

cd email_scraper
node --test test/secret-scan.test.js
PASS (exit 0)

npm test
124 tests: 121 passed, 0 failed, 3 database-gated skipped (exit 0)

git diff --check
PASS (exit 0)
```

Git metadata only (no workflow content was read or printed):

```text
git check-ignore -v email_scraper/My workflow 3.json email_scraper/My workflow 4.json
PASS — exact backend `.gitignore` rules reported.

git ls-files -- old-and-new-workflow-paths
Only the two old `Email Scrapper/...` paths are listed; both are deleted in the
working tree. Neither new `email_scraper/...` path is tracked.

git status --short
The pre-existing rename-heavy dirty worktree remains preserved.
```

The backend full suite used temporary loopback permission for its server test.
No live provider/storefront, primary/production database, migration, deployment,
workflow read/edit, credential action, or server stop/restart occurred.

## External deployment blocker

Provider-side rotation/revocation of credential-shaped values referenced by the
local n8n exports remains unverified and user-controlled. Ignore rules and local
scanning reduce commit risk but cannot prove rotation. Deployment must continue
to treat this as incomplete until the user confirms it externally.

## Stop boundary

G-R7 through G-R11 are implemented. This handoff does not claim an independent
parent acceptance review.
