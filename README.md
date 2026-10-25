# repo-baseline

Shared GitHub setup for ESchuderer's and OpenReloading's repositories: reusable workflows a repository calls with a few lines, pinned to a commit. Each module is optional.

## Modules

| Module | File | What it does |
|---|---|---|
| promote | `.github/workflows/promote.yml` | Keeps one open pull request from `develop` to `main` that lists the commits `main` lacks. Merging it with a merge commit is the release. |
| ci | `templates/ci/`, README section CI conventions | Copy-in workflows and rules for lean CI: a CI skeleton (workflow lint, dependency review, concurrency, timeouts, no duplicate runs on the promote pull request), pr-title, scorecard and a Dependabot template. No reusable workflow. |
| lint-js | `callers/lint-js.yml`, `templates/lint-js/` | Configuration for JavaScript and TypeScript repositories: Biome (lint, cognitive complexity, parameters, function length, import cycles), knip, jscpd and a TypeScript strictness gate, run by npm scripts of the repository with the tools as its devDependencies. No reusable workflow. |
| lint-python | `callers/lint-python.yml`, `templates/lint-python/` | Configuration for Python repositories: ruff (bugbear, simplify, complexity and size limits, pathlib, pylint subset) and basedpyright with a baseline file, installed from the repository's dev dependencies. No reusable workflow. |
| sonar | `.github/workflows/sonar.yml`, `templates/sonar/` | One SonarQube Cloud scan of `develop` and of pull requests into it, never of promotion pull requests. |
| settings | `profiles/`, `callers/`, `scripts/` | Desired GitHub settings per profile (rulesets, merge methods, Actions allowlist, security features) and a script that applies them with a dry run, a snapshot and a restore. |

## promote

Add `.github/workflows/promote.yml` to the repository:

```yaml
name: Promote
on:
  push:
    branches: [develop]
  workflow_dispatch:
permissions: {}
jobs:
  promote:
    permissions:
      contents: read
      pull-requests: write
    uses: ESchuderer/repo-baseline/.github/workflows/promote.yml@<commit sha> # v0.1.0
```

Requirements:

- Settings, Actions, General: "Allow GitHub Actions to create and approve pull requests" on (`can_approve_pull_request_reviews`).
- The pull request is opened with `GITHUB_TOKEN`, so its `pull_request` runs wait until someone with write access approves them ([GitHub docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)). The `main` ruleset should only require checks whose jobs also run on pushes to `develop` (their results are on the same commit). Pull-request-only checks such as dependency review or a title lint stay required on `develop`.
- `main` allows the merge commit method.
- With an Actions allowlist, allow `ESchuderer/repo-baseline/.github/workflows/promote.yml@*`.

Inputs: `source` (default `develop`), `target` (default `main`).

## settings

A profile is one JSON file in `profiles/` that names the settings a repository should have:

| Profile | For | Applied |
|---|---|---|
| `oss` | Public repository: rulesets for `develop` (squash, linear history) and `main` (merge commit), merge methods, Actions allowlist with SHA pinning, workflow token read-only, private vulnerability reporting, Dependabot alerts and security updates, code scanning default setup, secret scanning with push protection | yes |
| `private-advisory` | Private repository on a plan without rulesets and auto-merge: the same targets where the plan has them | never, reported only |

Each profile also lists the caller workflows a repository should have (`callers/<module>.yml`, with `{{ref}}` for the commit to pin) and files such as `.github/dependabot.yml`. `requiredChecks` states the rule for the status checks of the two rulesets: those of `main` are a subset of those of `develop`, and `dependency-review` and `conventional` are not required on `main` (the promotion pull request is opened with `GITHUB_TOKEN`, see promote).

Required status check names differ per repository, so the profile holds none. Pass them with `--develop-checks` and `--main-checks`; without them an existing ruleset keeps its checks and a new one is created without the rule.

```sh
# dry run (the default): prints each API call, writes nothing
node scripts/apply.mjs ESchuderer/BenchKeeper --profile oss
# apply: writes a snapshot of the current settings first, then sends the calls in order
node scripts/apply.mjs ESchuderer/BenchKeeper --profile oss --develop-checks build,test --main-checks build --apply
# restore a snapshot (a dry run unless --apply)
node scripts/apply.mjs restore <snapshot file> --apply
```

- The script talks to GitHub through the `gh` CLI, so the signed-in token needs admin rights on the repository. Nothing here runs from a workflow.
- Only settings the profile names are touched. Allowlist patterns are added to the existing ones, never removed. A ruleset is found by its branches (a hand-made one under another name is updated, not duplicated) and keeps its name, the pull request parameters the profile does not name, its other rules (a `PUT` replaces the whole rule list, so the script sends them back) and its status checks; its branches and bypass actors become the profile's. A second run reports nothing to change.
- Switching `allowed_actions` from `all` to `selected` stops every action and reusable workflow that is not on the list: the dry run prints a warning, read it before `--apply`.
- Calls go out in order: repository, Actions, rulesets, then the security features. A failed call stops the run; `--keep-going` sends the rest anyway and exits 1 (use it when one optional feature, such as code scanning on a repository with an advanced setup, is not available).
- A snapshot (mode 0600) holds the settings as read before the first call (folder `repo-baseline/snapshots` in `$XDG_STATE_HOME`, by default the `.local/state` folder of the home directory, or `--snapshot-dir`) and, written after the calls, the ids of the rulesets the run created. Restore sets everything back to the snapshot and deletes those rulesets by id; it names the repository it writes to first, and refuses a file that is not a snapshot of this script. A restore only changes values: a snapshot from someone else can weaken settings of any repository you administer, so use your own.
- A part GitHub does not return (a plan without rulesets, missing rights) is named and left alone.
- Restore does not remove allowlist patterns that were added while `allowed_actions` was `all`, and a code scanning default setup change is asynchronous on GitHub's side (a second run right after can answer 409).
- Not covered: organization settings, branch protection rules (rulesets only), secrets, the code scanning language list (default setup picks it).

Endpoints used: [repository](https://docs.github.com/en/rest/repos/repos), [rulesets](https://docs.github.com/en/rest/repos/rules), [Actions permissions](https://docs.github.com/en/rest/actions/permissions), [code scanning default setup](https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration). Unverified: whether a ruleset `PUT` replaces omitted fields (the script always sends the whole ruleset); whether an empty status check list is accepted (the script omits the rule instead). The script reads up to 100 rulesets per repository.

Tests: `node --test scripts/test/*.test.mjs` (a fake GitHub in memory, no network).

## CI conventions

Rules every repository follows, learned from auditing the OpenReloading repositories and BenchKeeper (13 minutes of Feeder tests and about 22 minutes of Ballistics CI ran twice on every merge to `develop`; two lint workflows never ran at all). `templates/ci/` holds copy-in files; they are standalone workflows, not reusable ones, so a repository needs no allowlist entry for them.

| Rule | Why |
|---|---|
| Every workflow starts with `permissions: {}`; each job grants what it needs (`contents: read` at least). | A default read grant at the top applies to every job added later. |
| Every job has `timeout-minutes`, about three times its median run time, at least 5. | The default is 360 minutes; a hung test would hold the runner for six hours. |
| `concurrency` on CI and pr-title workflows: `group: ${{ github.workflow }}-${{ github.head_ref \|\| github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. | New pushes cancel superseded pull request runs, and a run on `develop` or a deploy is never cancelled. |
| CI runs on `push` to `develop` and on `pull_request`, not on `push` to `main`. | `main` only receives merge commits of `develop`: their tree was checked on the pull request and on the push to `develop`. A workflow that deploys or releases from `main` keeps its own `push: main`. |
| Every job of a CI workflow skips the promote pull request: `if: ${{ !(github.event_name == 'pull_request' && github.head_ref == 'develop' && github.base_ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository) }}`. | Pushing to `develop` updates the open promote pull request, which starts a second run of every check on the same commit. A skipped job counts as passing for a required check, so the condition names base and head repository: `github.head_ref != 'develop'` alone would let a fork's branch called `develop` skip every check. A `pull_request: branches:` filter is not an alternative: release-please pull requests target `main` and need their checks. Jobs that run only on pull requests add `github.event_name == 'pull_request' &&` in front. pr-title has no push run, so it needs no skip. |
| Required checks on `main` are a subset of those on `develop`, and only checks that also run on the push to `develop`. | The promote pull request is opened with `GITHUB_TOKEN`, so its own `pull_request` runs wait for approval; its required checks are satisfied by the push run on the same commit. Pull-request-only checks (`dependency-review`, `conventional`) are never required on `main`. |
| A required check keeps its name. To split a slow job into parallel jobs, add an aggregator job with the original name: `needs: [...]`, `if: ${{ always() }}`, failing unless every needed result is `success` (or `skipped` where the original job could be skipped). | A renamed check leaves open pull requests waiting forever for the old name, and adding a new required name blocks every open pull request until its first run. |
| Third-party actions are pinned to a full commit SHA with the version in a comment, `persist-credentials: false` on checkout, untrusted values passed through `env:` and never interpolated into `run:`. | The `oss` settings profile requires SHA pinning; actionlint and zizmor (the `workflows` job in the CI skeleton) check the rest. |
| Tool versions that Dependabot cannot see (an image in a `run:` line, a pinned CLI version) sit in one `env:` block at the top of the workflow with a comment. | They are updated by hand, so a reader must find them in one place. |
| Cache a dependency or browser download only when it saves more than about 20 seconds; do not cache otherwise. | A cache adds an invalidation problem and rarely pays for downloads under 30 seconds. |
| Scheduled workflows have a reason and a failing run gets looked at; Scorecard runs weekly and on branch protection changes, not on every push. | A schedule nobody reads is a failure nobody sees. |
| `.github/dependabot.yml` lists exactly the ecosystems the repository uses: `github-actions` always, plus `npm`, `pip`, `uv`, `docker` per directory with a lockfile or Dockerfile. | Dependabot bumps the tools that sit in `package.json`, a requirements file or a Dockerfile, and nothing else. |

Files in `templates/ci/`:

| File | Use |
|---|---|
| `ci.yml` | CI skeleton with the `workflows` job (actionlint and zizmor) and `dependency-review`; add the repository's own jobs, each with the same `if`, `timeout-minutes` and `permissions`. |
| `pr-title.yml` | Conventional Commits check of the pull request title for repositories that squash-merge into `develop` (require `conventional` on `develop` only). |
| `scorecard.yml` | OpenSSF Scorecard weekly. Replace the repository name in its `if`. |
| `dependabot.yml` | Ecosystem entries to keep or delete. |

The `workflows` job and `dependency-review` job are identical in every repository, which is why they are templates; a reusable workflow would need an allowlist entry in every repository for no gain.

Settings that matter for CI and are not files: SHA pinning required and the Actions allowlist (below), fork pull request approval for all external contributors, `can_approve_pull_request_reviews` on (the promote workflow cannot open its pull request without it), no bypass actors beyond pull requests. For a repository owned by an organization the Actions allowlist is an organization setting: a repository-level `PUT` answers 409 and the `settings` script's allowlist call fails for it, so add patterns on the organization (`PUT /orgs/<org>/actions/permissions/selected-actions`), which then applies to all its repositories. Narrow patterns to the actions actually used (`docker/build-push-action@*`, not `docker/*@*`).

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
5. After the first scan, require the check on `develop`. Pick its exact name in the status check list of the ruleset: Sonar's documentation names it `SonarQube Code Analysis` while community reports name it `SonarCloud Code Analysis` (unverified which one a project shows). Do not require it on `main`: promotion pull requests are not scanned.

Then copy `templates/sonar/sonar-project.properties` to the repository root and fill in the organization and project key (`sonar.test.inclusions` only filters files inside `sonar.tests`, which is why the template sets both to `.` and excludes the test globs from the main code: [analysis scope](https://docs.sonarsource.com/sonarqube-server/10.7/project-administration/analysis-scope), a SonarQube Server page, as the SonarQube Cloud documentation has no page of its own for it), and add `.github/workflows/sonar.yml`:

```yaml
name: Sonar
on:
  pull_request:
    branches: [develop]
  push:
    branches: [develop]
permissions: {}
jobs:
  sonar:
    permissions:
      contents: read
    uses: ESchuderer/repo-baseline/.github/workflows/sonar.yml@<commit sha>
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

The job scans only pushes to `branch` and pull requests into it, whatever the caller triggers on. Inputs: `branch` (`develop`), `project-base-dir` (`.`), `coverage-artifact` (empty). To import coverage, put this job into the repository's test workflow with `needs: <test job>`, upload the report (`coverage/lcov.info` or `coverage.xml`) as an artifact there, and pass its name as `coverage-artifact`. The default Sonar way gate requires 80% coverage and at most 3% duplication on new code ([docs](https://docs.sonarsource.com/sonarqube-cloud/standards/managing-quality-gates/introduction-to-quality-gates)); unverified: whether it fails when no coverage report exists, so import coverage before requiring the check.

Limits:

- Pull requests from forks are not scanned (GitHub withholds secrets from them, [docs](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud)), so a required Sonar check never reports on them; a maintainer merges those with a ruleset bypass or pushes the branch to the repository.
- The scan runs with `fetch-depth: 0` ([action docs](https://github.com/SonarSource/sonarqube-scan-action)) and no `SONAR_HOST_URL`, which SonarQube Cloud does not need.
