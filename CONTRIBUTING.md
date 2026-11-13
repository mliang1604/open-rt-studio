# Contributing

Thanks for your interest in Open RT Studio. Please read the
[architecture document](docs/architecture.md) first; it records the decisions
this project has already made.

Open RT Studio is **not for clinical use**, and contributions must not suggest
otherwise in code, user interface text or documentation.

## Ground rules

- **No patient data, ever.** Tests use generated synthetic data. See the
  [test data policy](docs/test-data.md).
- **No GPL or AGPL dependencies.** State the license of any dependency you add.
- **MPL 2.0 header on every source file.** See
  [license headers](docs/license-headers.md).
- Contributions are accepted under the MPL 2.0 license of the repository.

## Workflow

1. Pick an issue. Each one lists its scope, a "done when" checklist and its
   dependencies. Stories are sized for one pull request.
2. Branch from `main`. One branch and one pull request per issue, or per small
   group of issues that cannot sensibly be separated.
3. Say which issues the pull request closes (`Closes #123`).
4. Wait for the `Build & test` and `End-to-end smoke` checks. Pull requests are
   squash-merged.

## Before you push

The commands are listed in [CLAUDE.md](CLAUDE.md). In short: install with
`npm ci`, then lint, check formatting, build and test. For anything that
changes what the application shows, run it and look at it in a browser with
WebGPU; tests alone are not enough.

## Code style

- TypeScript in strict mode, formatted with Prettier (100 columns, single
  quotes). Do not hand-format.
- Follow the patterns in [CLAUDE.md](CLAUDE.md): signals with OnPush,
  exhaustive switches, framework-free packages.
- Unit tests sit next to the code as `*.spec.ts`. Tests must pass on a machine
  without a GPU; anything that needs WebGPU skips explicitly when it is
  missing.

## Required checks and merging

`main` is protected by a repository ruleset ("Protect main"):

- Changes reach `main` only through a pull request. No approving review is
  required.
- The status checks **`Build & test`** and **`End-to-end smoke`** must pass.
  These are the names of jobs in `.github/workflows/ci.yml`; renaming a job
  breaks the rule, and a pull request then waits forever for a check that
  never reports.
- Force pushes to `main` and deleting it are blocked.
- Auto-merge is allowed, so `gh pr merge --squash --auto` merges a pull
  request by itself once the checks pass.

`End-to-end smoke` runs only `apps/web/e2e/smoke.spec.ts` (`npm run
e2e:smoke`) in Chromium with a software WebGPU adapter: the notice flow,
loading a synthetic series, a probe value and a WebGPU device. In this job a
missing adapter fails the tests instead of skipping them
(`E2E_REQUIRE_WEBGPU=1`), so the check cannot pass with its tests skipped.

A third job, `End-to-end`, runs the whole Playwright suite the same way. It
is not required by the ruleset, so nothing stops a merge while it is red:
wait for it before merging.

`Build & test` runs, in order: `npm ci` (fails when `package.json` and the
lockfile disagree), `npm run lint`, `npm run format:check`, `npm run build`,
`npm test`, and a check that none of that changed a tracked file. Any step
failing fails the check.

### Setting it up on a fork or a new copy

The ruleset is a repository setting and is not stored in the repository, so a
fork or a re-created repository needs it set once by an administrator:

1. Settings → Rules → Rulesets → New ruleset → New branch ruleset.
2. Target: the default branch. Enforcement: Active.
3. Enable "Restrict deletions", "Block force pushes", "Require a pull request
   before merging" (0 approvals) and "Require status checks to pass".
4. Under required checks, add `Build & test` and `End-to-end smoke`. They
   appear in the list after the workflow has run at least once.
5. Settings → General → Pull Requests: enable "Allow auto-merge" and
   "Automatically delete head branches".

## Deployment

`.github/workflows/deploy.yml` builds `apps/web` on every push to `main` and
publishes it to GitHub Pages at <https://mliang1604.github.io/open-rt-studio/>.
The build uses the repository name as the base href, and a copy of
`index.html` as `404.html` makes deep links and reloads work.

Pages has to be enabled once by an administrator: Settings → Pages → Source
"GitHub Actions". While it is not, the workflow says so in a warning and skips
the build and the deployment, so merges do not fail.
