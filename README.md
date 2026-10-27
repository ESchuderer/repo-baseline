# repo-baseline

Shared GitHub setup for ESchuderer's and OpenReloading's repositories: reusable workflows a repository calls with a few lines, pinned to a commit. Each module is optional.

## Modules

| Module | File | What it does |
|---|---|---|
| ci | `templates/ci/`, README section CI conventions | Copy-in workflows and rules for lean CI: a CI skeleton (workflow lint, dependency review, concurrency, timeouts), pr-title, scorecard and a Dependabot template. No reusable workflow. |
| lint-js | `callers/lint-js.yml`, `templates/lint-js/` | Configuration for JavaScript and TypeScript repositories: Biome (lint, cognitive complexity, parameters, function length, import cycles), knip, jscpd and a TypeScript strictness gate, run by npm scripts of the repository with the tools as its devDependencies. No reusable workflow. |
| lint-python | `callers/lint-python.yml`, `templates/lint-python/` | Configuration for Python repositories: ruff (bugbear, simplify, complexity and size limits, pathlib, pylint subset) and basedpyright with a baseline file, installed from the repository's dev dependencies. No reusable workflow. |
| sonar | `.github/workflows/sonar.yml`, `templates/sonar/` | One SonarQube Cloud scan of `main` and of pull requests into it. |
| settings | `profiles/`, `callers/`, `scripts/` | Desired GitHub settings per profile (rulesets, merge methods, Actions allowlist, security features) and a script that applies them with a dry run, a snapshot and a restore. |
| release | `.github/workflows/release-weekly.yml`, `callers/release-weekly.yml`, `templates/release/`, `templates/pages/`, README section Release and Pages | A repository on one `main` branch: release-please keeps a release pull request open, a weekly workflow merges it every Monday (or when started by hand), and one Pages workflow serves the latest release at the root and `main` at `/next/`. |

## settings

A profile is one JSON file in `profiles/` that names the settings a repository should have:

| Profile | For | Applied |
|---|---|---|
| `oss` | Public repository: one `main` ruleset (squash only, linear history), squash-only merge setting, Actions allowlist with SHA pinning, workflow token read-only, private vulnerability reporting, Dependabot alerts and security updates, code scanning default setup, secret scanning with push protection | yes |
| `private-advisory` | Private repository on a plan without rulesets and auto-merge: the same targets where the plan has them | never, reported only |

Each profile also lists the caller workflows a repository should have (`callers/<module>.yml`, with `{{ref}}` for the commit to pin) and files such as `.github/dependabot.yml`. The repository has one long-lived branch, `main`: feature branches are short-lived, pull requests are squash-merged and history stays linear.

Required status check names differ per repository, so the profile holds none. Pass them with `--checks`; without it an existing ruleset keeps its checks and a new one is created without the rule. Every required check runs on pull requests into `main`, so pull-request-only checks such as `dependency-review` and `conventional` can be required too.

```sh
# dry run (the default): prints each API call, writes nothing
node scripts/apply.mjs ESchuderer/BenchKeeper --profile oss
# apply: writes a snapshot of the current settings first, then sends the calls in order
node scripts/apply.mjs ESchuderer/BenchKeeper --profile oss --checks build,test --apply
# organization repository: add the merge queue
node scripts/apply.mjs OpenReloading/Feeder --profile oss --checks build,test --merge-queue --apply
# restore a snapshot (a dry run unless --apply)
node scripts/apply.mjs restore <snapshot file> --apply
```

- The script talks to GitHub through the `gh` CLI, so the signed-in token needs admin rights on the repository. Nothing here runs from a workflow.
- Only settings the profile names are touched. Allowlist patterns are added to the existing ones, never removed. A ruleset is found by its branches (a hand-made one under another name is updated, not duplicated) and keeps its name, the pull request parameters the profile does not name, its other rules (a `PUT` replaces the whole rule list, so the script sends them back) and its status checks; its branches and bypass actors become the profile's. A second run reports nothing to change.
- Switching `allowed_actions` from `all` to `selected` stops every action and reusable workflow that is not on the list: the dry run prints a warning, read it before `--apply`.
- Calls go out in order: repository, Actions, rulesets, then the security features. A failed call stops the run; `--keep-going` sends the rest anyway and exits 1 (use it when one optional feature, such as code scanning on a repository with an advanced setup, is not available).
- A snapshot (mode 0600) holds the settings as read before the first call (folder `repo-baseline/snapshots` in `$XDG_STATE_HOME`, by default the `.local/state` folder of the home directory, or `--snapshot-dir`) and, written after the calls, the ids of the rulesets the run created. Restore sets everything back to the snapshot and deletes those rulesets by id; it names the repository it writes to first, and refuses a file that is not a snapshot of this script. A restore only changes values: a snapshot from someone else can weaken settings of any repository you administer, so use your own.
- A ruleset the profile does not name is left as it is. A repository that still has a ruleset for `develop` gets it deleted by hand (Settings, Rules, Rulesets) after its content is on `main`; the script never deletes one, except in a restore, for the rulesets the same run created.
- A part GitHub does not return (a plan without rulesets, missing rights) is named and left alone.
- Restore does not remove allowlist patterns that were added while `allowed_actions` was `all`, and a code scanning default setup change is asynchronous on GitHub's side (a second run right after can answer 409).
- Not covered: organization settings, branch protection rules (rulesets only), secrets, the code scanning language list (default setup picks it).

Endpoints used: [repository](https://docs.github.com/en/rest/repos/repos), [rulesets](https://docs.github.com/en/rest/repos/rules), [Actions permissions](https://docs.github.com/en/rest/actions/permissions), [code scanning default setup](https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration). Unverified: whether a ruleset `PUT` replaces omitted fields (the script always sends the whole ruleset); whether an empty status check list is accepted (the script omits the rule instead). The script reads up to 100 rulesets per repository.

Tests: `node --test scripts/test/*.test.mjs` (a fake GitHub in memory, no network).

## Release and Pages

Every `main` merge is releasable and deploys the `next` edition. A release is one pull request: release-please keeps it open from the Conventional Commits, and every Monday 05:00 UTC the weekly workflow merges it once its checks pass. The owner can merge it earlier, run the weekly workflow by hand (Actions, Run workflow) for any other day, or put the label `hold` on the pull request to skip a week. Without a releasable commit (`feat`, `fix`, `perf`, or a breaking change) there is no pull request and nothing is released.

| Rule | How |
|---|---|
| Release pull request | `templates/release/release-please.yml` runs release-please on every push to `main` and keeps one release pull request open from the Conventional Commits. Merging it tags the version and creates the GitHub Release. Publishing steps (packages, images) run from `release: published` or from the release workflow after a release, never from a plain push to `main`. |
| Weekly merge | `callers/release-weekly.yml` (schedule and `workflow_dispatch`) calls `.github/workflows/release-weekly.yml`: it turns on auto-merge (squash) for the release pull request, waits for the merge, and starts the release workflow so a merge made without the App token still releases (a repeat run finds nothing to do). A failed run mails the owner. GitHub disables scheduled workflows of a public repository after 60 days without repository activity ([docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow)); a repository that stays quiet that long needs its schedule re-enabled by hand. |
| Merge queue | Organization repositories: `--merge-queue` of the settings script adds a squash merge queue to the `main` ruleset, and every required check runs on `merge_group` (the CI templates do). A personal repository cannot have one (the API answers 422 for the rule, checked 2026-10-27; [docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)) and does without: requiring up-to-date branches costs a rebase and a rerun per queued pull request for little gain. Apply the queue only after the workflows have `merge_group`, or the queue waits for checks that never report. The SonarCloud app check is one of them: it reports on pull requests only (no such check on the queue commit of a test merge in Feeder, 2026-10-27), so a queue that requires it stalls until it times out. Take it off the required checks first (the pull request is still analysed before it is queued) or skip the queue. |
| Not in the baseline | No feature flags (a static app has the `next` edition as its staging channel; add flags when a hosted edition exists), no semantic-release (it releases on every merge and has no pull request to hold), no release branches (a fix goes to `main` and a patch release). |
| Checks on the release pull request | A pull request opened with `GITHUB_TOKEN` starts no checks until someone approves the runs. The workflow opens it with the release GitHub App token (variable `RELEASE_APP_CLIENT_ID`, secret `RELEASE_APP_PRIVATE_KEY`) so required checks run at once. Without the App the job falls back to `GITHUB_TOKEN`: the owner approves the runs on the release pull request and, because a release created with `GITHUB_TOKEN` does not trigger `release: published`, starts the Pages workflow by hand after each release. |
| Pages | One workflow builds both editions into one artifact, because a Pages deployment replaces the whole site: the root is the latest release, built from its tag, and `/next/` is `main`, rebuilt on every push to `main`. Triggers are `push` on `main`, `release: published` and `workflow_dispatch`. Until the first release exists the root redirects to `/next/`. |
| Browser storage | Both editions share one origin. An app that keeps data in the browser (IndexedDB, localStorage, service worker cache) names it per edition: the workflow passes `EDITION` (`NEXT_PUBLIC_EDITION` for Next.js), `stable` or `next`, at build time, and the service worker of `next` has scope `/next/`. |
| Pull requests | Squash merge into `main`, short-lived branches, linear history, required checks as before. |

Templates:

| File | Use |
|---|---|
| `templates/release/release-please.yml` | Release pull request with the App token. `release-type` defaults to `simple`; change it for the language of the repository. |
| `callers/release-weekly.yml` | The Monday schedule and the manual trigger; pin `{{ref}}` to a commit of this repository and allow `ESchuderer/repo-baseline/.github/workflows/release-weekly.yml@*` on the Actions allowlist. |
| `templates/pages/pages.yml` | Pages for a site built with `npm run build` into `dist/`. |
| `templates/pages/pages-mkdocs.yml` | Pages for mkdocs: hash-locked `requirements-docs.txt`, `site_url: !ENV SITE_URL`. |
| `templates/pages/pages-nextjs.yml` | Pages for a Next.js static export (`output: 'export'`, `basePath` from `BASE_PATH`, written to `out/`). |

The root edition is built with the build script of the release tag. A release made before the build reads `EDITION` uses the storage names of `next`, so make that change before the first release.

### New repository

1. Copy the CI skeleton (`templates/ci/`, see CI conventions) and the release template; add `googleapis/release-please-action@*` to the Actions allowlist (`actions/*` is covered by `github_owned_allowed`).
2. Copy the Pages template that fits the build and make the build read `EDITION` and `BASE_PATH`.
3. Create the release GitHub App (contents, pull requests, issues and actions write; install it on the repository only), then set the repository variable `RELEASE_APP_CLIENT_ID` and the secret `RELEASE_APP_PRIVATE_KEY`. The weekly merge needs it: without the App the release pull request gets no checks.
4. Apply the settings profile (`settings` above) and require the CI checks on `main`.

### Settings the owner changes

The scripts and workflows here change none of these.

- Pages source: GitHub Actions (Settings, Pages).
- Environment `github-pages`: deployment branches and tags allow only `main` and release tags (`v*`); remove `develop` entries.
- Rulesets: delete a leftover ruleset for `develop` (see settings).
- Actions allowlist entry and the App variable and secret of the checklist above.

## CI conventions

Rules every repository follows, learned from auditing the OpenReloading repositories and BenchKeeper (13 minutes of Feeder tests and about 22 minutes of Ballistics CI ran twice on every merge; two lint workflows never ran at all). `templates/ci/` holds copy-in files; they are standalone workflows, not reusable ones, so a repository needs no allowlist entry for them.

| Rule | Why |
|---|---|
| Every workflow starts with `permissions: {}`; each job grants what it needs (`contents: read` at least). | A default read grant at the top applies to every job added later. |
| Every job has `timeout-minutes`, about three times its median run time, at least 5. | The default is 360 minutes; a hung test would hold the runner for six hours. |
| `concurrency` on CI and pr-title workflows: `group: ${{ github.workflow }}-${{ github.head_ref \|\| github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. | New pushes cancel superseded pull request runs, and a run on `main` or a deploy is never cancelled. |
| CI runs on `push` to `main` and on `pull_request`, with no `branches:` filter on `pull_request`. | The push run checks the squashed commit that landed on `main`. release-please pull requests target `main` and need their checks, so every pull request runs them. |
| A required check keeps its name. To split a slow job into parallel jobs, add an aggregator job with the original name: `needs: [...]`, `if: ${{ always() }}`, failing unless every needed result is `success` (or `skipped` where the original job could be skipped). | A renamed check leaves open pull requests waiting forever for the old name, and adding a new required name blocks every open pull request until its first run. |
| Third-party actions are pinned to a full commit SHA with the version in a comment, `persist-credentials: false` on checkout, untrusted values passed through `env:` and never interpolated into `run:`. | The `oss` settings profile requires SHA pinning; actionlint and zizmor (the `workflows` job in the CI skeleton) check the rest. |
| Tool versions that Dependabot cannot see (an image in a `run:` line, a pinned CLI version) sit in one `env:` block at the top of the workflow with a comment. | They are updated by hand, so a reader must find them in one place. |
| Cache a dependency or browser download only when it saves more than about 20 seconds; do not cache otherwise. | A cache adds an invalidation problem and rarely pays for downloads under 30 seconds. |
| Scheduled workflows have a reason and a failing run gets looked at; Scorecard runs weekly and on branch protection changes, not on every push. | A schedule nobody reads is a failure nobody sees. |
| `.github/dependabot.yml` lists exactly the ecosystems the repository uses: `github-actions` always, plus `npm`, `pip`, `uv`, `docker` per directory with a lockfile or Dockerfile. | Dependabot bumps the tools that sit in `package.json`, a requirements file or a Dockerfile, and nothing else. |

Files in `templates/ci/`:

| File | Use |
|---|---|
| `ci.yml` | CI skeleton with the `workflows` job (actionlint and zizmor) and `dependency-review`; add the repository's own jobs, each with `timeout-minutes` and `permissions`. |
| `pr-title.yml` | Conventional Commits check of the pull request title for repositories that squash-merge pull requests into `main` (require `conventional` on `main`). |
| `scorecard.yml` | OpenSSF Scorecard weekly. Replace the repository name in its `if`. |
| `dependabot.yml` | Ecosystem entries to keep or delete. |

The `workflows` job and `dependency-review` job are identical in every repository, which is why they are templates; a reusable workflow would need an allowlist entry in every repository for no gain.

Settings that matter for CI and are not files: SHA pinning required and the Actions allowlist (below), fork pull request approval for all external contributors, `can_approve_pull_request_reviews` on (a workflow that opens pull requests with `GITHUB_TOKEN` cannot without it; unverified for release-please), no bypass actors beyond pull requests. For a repository owned by an organization the Actions allowlist is an organization setting: a repository-level `PUT` answers 409 and the `settings` script's allowlist call fails for it, so add patterns on the organization (`PUT /orgs/<org>/actions/permissions/selected-actions`), which then applies to all its repositories. Narrow patterns to the actions actually used (`docker/build-push-action@*`, not `docker/*@*`).

## Adopting the code quality modules

lint-js, lint-python and sonar are meant to be rolled out one pull request per repository. lint-js and lint-python are configuration, not reusable workflows: the repository declares the tools as exact-version dev dependencies, its own scripts run them, and its own workflow (copied from `callers/`) installs the dependencies and runs the scripts. Tools therefore run the same way locally, in the editor and in CI, and Dependabot bumps them like any other dependency. sonar stays a reusable workflow because it needs one shared token setup.

The templates hold the rules, each repository copies them (merging into its existing Biome or `pyproject.toml` config) and records its current findings as a baseline. Nothing then fails on day one, and a new violation fails the check. Versions at the time the templates were written, each the newest release at least 7 days old:

| Tool | Version | Release page |
|---|---|---|
| Biome | 2.5.15 | https://www.npmjs.com/package/@biomejs/biome |
| knip | 6.41.0 | https://www.npmjs.com/package/knip |
| jscpd | 5.4.1 | https://www.npmjs.com/package/jscpd |
| ruff | 0.17.1 | https://pypi.org/project/ruff/ |
| basedpyright | 1.40.2 | https://pypi.org/project/basedpyright/ |
| sonarqube-scan-action | v8.3.0 (`d209202bc7d53ff1cc128f7f907dac145c9d6ae9`) | https://github.com/SonarSource/sonarqube-scan-action/releases |

After adoption the repository's Dependabot (`npm` or `pip`/`uv`, plus `github-actions` for the workflow pins) keeps the tools current. Keep the Dependabot entry for each ecosystem the repository uses: without it the tools stay on the adoption version.

## lint-js

1. Install the tools as exact-version devDependencies (no `^`, so the config and the lockfile name one version):

```sh
npm install --save-dev --save-exact @biomejs/biome@2.5.15 knip@6.41.0 jscpd@5.4.1 typescript
```

2. Copy from `templates/lint-js/`: merge `biome-quality.jsonc` into `biome.json` (its override first in `overrides`), copy `knip.json` and `.jscpd.json` to the root, and for TypeScript copy `tsconfig.strict.json` next to each `tsconfig.json` and `tsc-baseline.sh` to `scripts/`. Point the `$schema` of `biome.json` and `knip.json` at the installed packages (`./node_modules/@biomejs/biome/configuration_schema.json`, `./node_modules/knip/schema.json`) so a Dependabot bump cannot disagree with them.
3. Add the scripts. `check` is the one CI runs:

```json
{
  "scripts": {
    "lint": "biome lint .",
    "typecheck": "sh scripts/tsc-baseline.sh tsconfig.strict.json tsc-baseline.txt",
    "knip": "knip",
    "dup": "jscpd --baseline .jscpd-baseline.json --fail-on-new-clones",
    "check": "npm run lint && npm run typecheck && npm run knip && npm run dup"
  }
}
```

4. Record the baselines (run after `npm ci`, with the installed versions: a baseline written by another version can fail in CI):

```sh
# Biome: one inline `biome-ignore ... baseline` comment per existing finding, in non-test files
git ls-files -z -- '*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.mts' '*.cjs' '*.cts' \
  ':(exclude,glob)**/*.test.*' ':(exclude,glob)**/*.spec.*' ':(exclude,glob)**/test/**' \
  ':(exclude,glob)**/tests/**' ':(exclude,glob)**/e2e/**' |
  xargs -0 npx biome lint --suppress --reason=baseline \
    --only=complexity/noExcessiveCognitiveComplexity --only=complexity/useMaxParams \
    --only=complexity/noExcessiveLinesPerFunction --only=suspicious/noImportCycles
# jscpd: fingerprints of the clones that exist
npx jscpd --baseline .jscpd-baseline.json --update-baseline
# TypeScript: errors of the strict config, per tsconfig
sh scripts/tsc-baseline.sh tsconfig.strict.json tsc-baseline.txt --write
```

5. Copy `callers/lint-js.yml` to `.github/workflows/lint-js.yml` (the job runs `npm ci` and `npm run check`; add a `.nvmrc` or set `node-version`). If the repository's ruleset requires a check by name, keep the workflow and job names so the check context does not change.

| Rule | Threshold | Reason |
|---|---|---|
| Biome `noExcessiveCognitiveComplexity` ([docs](https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/)) | 15 | The rule's default. |
| Biome `useMaxParams` ([docs](https://biomejs.dev/linter/rules/use-max-params/)) | 5 | Same limit as ruff `PLR0913`, so both languages read alike. |
| Biome `noExcessiveLinesPerFunction` ([docs](https://biomejs.dev/linter/rules/no-excessive-lines-per-function/)) | 80, blank lines and IIFEs skipped | The default is 50; 80 leaves room for a component or a request handler of about one screen. |
| Biome `noImportCycles` ([docs](https://biomejs.dev/linter/rules/no-import-cycles/)) | on | No tuning; each cycle is a defect. |
| knip ([docs](https://knip.dev/features/rules-and-filters)) | `error` for every issue type whose count is 0, `warn` for the rest | Warnings print but do not fail, so a type must reach `error` as soon as its count is 0, or it gates nothing. |
| jscpd ([docs](https://github.com/kucherenko/jscpd/blob/master/docs/rust.md#baseline)) | 100 tokens, JS and TS formats, tests excluded | Shorter matches are mostly idiom (imports, option objects). A baseline file tolerates the clones that exist. Remove jscpd and its baseline once the sonar module gates duplication on new code. |
| TypeScript `strict`, `noUncheckedIndexedAccess` ([docs](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html)) | no new error | Few repositories pass `noUncheckedIndexedAccess` on day one (the pilot has 1,052 errors in one package). `tsc-baseline.sh` compares the error list without line numbers; shrink the baseline as errors are fixed. |

SonarQube flags a plain `npm ci` in a workflow (rule `githubactions:S6505`, found on Ballistics: install scripts may run). Use `npm ci --ignore-scripts` where nothing needs a postinstall (and run the needed script by name afterwards), otherwise accept the rule in the SonarQube Cloud project and say why in the pull request. The rule matters only for repositories where the sonar module is on.

Limits: a Biome suppression covers its function, so a baselined function can get worse without failing. Tests are exempt from the three size and complexity rules through the override; adapt its globs per repository. Biome suppressions in the `--only` run ignore `overrides`, which is why the baseline command leaves test paths out. The template enables only the four quality rules; turn on Biome's recommended rules (and a formatter) in the repository when its code is ready for them.

## lint-python

1. Declare the tools in a hash-locked file: a source `requirements-dev.in` with `ruff==0.17.1` and `basedpyright==1.40.2`, compiled with the Python version CI uses, and installed in CI with `--require-hashes`. SonarQube flags an install without hashes (rule `githubactions:S8544`, found on AutoLever), and the lock also stops a changed package from installing silently.

```sh
pip install pip-tools   # use a pip version that pip-tools supports; pip-tools 7.5.3 failed to import under pip 26
pip-compile --generate-hashes --strip-extras -o requirements-dev.txt requirements-dev.in
pip install --only-binary :all: --require-hashes -r requirements-dev.txt
```

   `--require-hashes` applies to every requirement in the file, so keep `-r requirements.txt` out of it and install the project's own dependencies in a separate step the way the project already does. Dependabot's `pip` ecosystem lists pip-compile as supported ([docs](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories)); unverified whether it bumps the `.in` and `.txt` pair together until the first Dependabot pull request.
2. Merge `templates/lint-python/pyproject-quality.toml` into `pyproject.toml` and adapt `include` and the per-path ignores (the CAD script glob there is an example).
3. Record the baselines with the project's dependencies installed (so imports resolve) and the Python version CI uses, as another version can change what basedpyright reports:

```sh
ruff check --add-noqa .       # one `# noqa: CODE` per existing finding
basedpyright --writebaseline  # writes .basedpyright/baseline.json
```

4. Copy `callers/lint-python.yml` to `.github/workflows/lint-python.yml` and replace its install step with the project's own install of the dev dependencies. Keep the workflow and job names if a ruleset requires the check by name.

Rule families: `E4`, `E7`, `E9`, `F`, `B`, `C4`, `C90`, `SIM`, `RET`, `PTH`, `PERF`, `RUF`, `UP`, `I`, `PT`, `ARG`, the pylint limits `PLR0911`, `PLR0912`, `PLR0913`, `PLR0915` and the families `PLE`, `PLW`, `PLC` ([rules](https://docs.astral.sh/ruff/rules/)). To adopt one family per pull request, leave the others out of `select` until their turn.

| Setting | Value | Reason |
|---|---|---|
| `mccabe.max-complexity` ([docs](https://docs.astral.sh/ruff/rules/complex-structure/)) | 10 | ruff's default (`ruff config lint.mccabe.max-complexity`), written out. |
| `pylint` limits | 5 arguments, 6 returns, 12 branches, 50 statements | ruff's defaults (`ruff config lint.pylint.max-args` and the others), written out so a reader sees them. |
| basedpyright `typeCheckingMode` ([docs](https://docs.basedpyright.com/latest/configuration/config-files/)) | `standard` | `recommended` reports every unannotated or partly unknown value (about 2,350 warnings in the pilot against 106 errors), which buries real mistakes. Raise it once the baseline is small. |
| basedpyright baseline ([docs](https://docs.basedpyright.com/latest/benefits-over-pyright/baseline/)) | `.basedpyright/baseline.json` | Existing errors are listed, a new one fails. |

Limits: `--add-noqa` is a per-line baseline in the code ([docs](https://docs.astral.sh/ruff/linter/#error-suppression)); remove the comments as the code is fixed. Tests and CAD scripts get relaxed limits by path, documented in the template. basedpyright needs the project's dependencies installed, otherwise every import is an error.

## sonar

Optional. SonarQube Cloud already analyzes a repository once its GitHub app is installed and Automatic Analysis is on: the `SonarCloud Code Analysis` check then appears on pull requests with no workflow, token or properties file (seen on AutoLever, Feeder, Ballistics, BuildGuide and BenchKeeper). This module is for CI-based analysis, which Automatic Analysis cannot replace when a repository wants to import a coverage report into the gate. Without that need, skip the steps below.

Owner steps, once per GitHub account and once per repository (nothing here can be done from a workflow):

1. Import the GitHub account into SonarQube Cloud ([getting started](https://docs.sonarsource.com/sonarqube-cloud/getting-started/github), [import guide](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/creating-organization/importing-github-organization)) and choose the OSS plan: unlimited public repositories (no private projects), unlimited branch and pull request analysis, custom quality profiles and gates; its price is unverified; the Free plan analyzes only the main branch ([plans](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans)). Unverified: whether a personal account (not an organization) qualifies for the OSS plan.
2. Per repository: import it as a project, then turn Automatic Analysis off under Administration, Analysis Method. CI analysis and Automatic Analysis cannot run on one project ([docs](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis)).
3. Per repository: add the token as the Actions secret `SONAR_TOKEN` ([docs](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud)), and as a Dependabot secret too, since Dependabot pull requests do not get Actions secrets ([docs](https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions)).
4. Allow the actions the workflow uses on the Actions allowlist: `ESchuderer/repo-baseline/.github/workflows/sonar.yml@*` and `SonarSource/sonarqube-scan-action@*` (for a repository owned by an organization, on the organization: see CI conventions). Without the entry the run ends in `startup_failure`, which is how the lint workflows of Feeder and AutoLever never ran before they became standalone.
5. After the first scan, require the check on `main`. Pick its exact name in the status check list of the ruleset: Sonar's documentation names it `SonarQube Code Analysis` while community reports name it `SonarCloud Code Analysis` (unverified which one a project shows).

Then copy `templates/sonar/sonar-project.properties` to the repository root and fill in the organization and project key (`sonar.test.inclusions` only filters files inside `sonar.tests`, which is why the template sets both to `.` and excludes the test globs from the main code: [analysis scope](https://docs.sonarsource.com/sonarqube-server/10.7/project-administration/analysis-scope), a SonarQube Server page, as the SonarQube Cloud documentation has no page of its own for it), and add `.github/workflows/sonar.yml`:

```yaml
name: Sonar
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
permissions: {}
jobs:
  sonar:
    permissions:
      contents: read
    uses: ESchuderer/repo-baseline/.github/workflows/sonar.yml@<commit sha>
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

The job scans only pushes to `branch` and pull requests into it, whatever the caller triggers on. Inputs: `branch` (`main`), `project-base-dir` (`.`), `coverage-artifact` (empty). To import coverage, put this job into the repository's test workflow with `needs: <test job>`, upload the report (`coverage/lcov.info` or `coverage.xml`) as an artifact there, and pass its name as `coverage-artifact`. The default Sonar way gate requires 80% coverage and at most 3% duplication on new code ([docs](https://docs.sonarsource.com/sonarqube-cloud/standards/managing-quality-gates/introduction-to-quality-gates)); unverified: whether it fails when no coverage report exists, so import coverage before requiring the check.

Limits:

- Pull requests from forks are not scanned (GitHub withholds secrets from them, [docs](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud)), so a required Sonar check never reports on them; a maintainer merges those with a ruleset bypass or pushes the branch to the repository.
- The scan runs with `fetch-depth: 0` ([action docs](https://github.com/SonarSource/sonarqube-scan-action)) and no `SONAR_HOST_URL`, which SonarQube Cloud does not need.
