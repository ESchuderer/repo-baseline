# repo-baseline

Shared GitHub setup for ESchuderer's and OpenReloading's repositories: reusable workflows a repository calls with a few lines, pinned to a commit. Each module is optional.

## Modules

| Module | File | What it does |
|---|---|---|
| promote | `.github/workflows/promote.yml` | Keeps one open pull request from `develop` to `main` that lists the commits `main` lacks. Merging it with a merge commit is the release. |
| lint-js | `.github/workflows/lint-js.yml`, `templates/lint-js/` | Biome (cognitive complexity, parameters, function length, import cycles), knip, jscpd and a TypeScript strictness gate, with baselines so nothing fails on day one. |
| lint-python | `.github/workflows/lint-python.yml`, `templates/lint-python/` | ruff (bugbear, simplify, complexity and size limits, pathlib, pylint subset) and basedpyright with a baseline file. |
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

## Adopting the code quality modules

lint-js, lint-python and sonar are meant to be rolled out one pull request per repository. The workflows read the rules from files in the repository, so each repository copies the matching files from `templates/` first (merging them into its existing Biome or `pyproject.toml` config) and records its current findings as a baseline. Nothing then fails on day one, and a new violation fails the check.

Tool versions are inputs of the workflows (defaults below), each the newest release at least 7 days old when chosen. Dependabot does not read workflow inputs, so a bump is a pull request here that changes the defaults and the template pins together.

| Tool | Default | Release page |
|---|---|---|
| Biome | 2.5.15 | https://www.npmjs.com/package/@biomejs/biome |
| knip | 6.41.0 | https://www.npmjs.com/package/knip |
| jscpd | 5.4.1 | https://www.npmjs.com/package/jscpd |
| ruff | 0.17.1 | https://pypi.org/project/ruff/ |
| basedpyright | 1.40.2 | https://pypi.org/project/basedpyright/ |
| sonarqube-scan-action | v8.3.0 (`d209202bc7d53ff1cc128f7f907dac145c9d6ae9`) | https://github.com/SonarSource/sonarqube-scan-action/releases |

## lint-js

1. Copy from `templates/lint-js/`: merge `biome-quality.jsonc` into `biome.json` (its override first in `overrides`), copy `knip.json` and `.jscpd.json` to the root, and for TypeScript copy `tsconfig.strict.json` next to each `tsconfig.json` and `tsc-baseline.sh` to `scripts/`.
2. Record the baselines (run in the dev container or CI, after `npm ci`, with the tool versions of the workflow: a baseline written by another version can fail in CI):

```sh
# Biome: one inline `biome-ignore ... baseline` comment per existing finding, in non-test files
git ls-files -z -- '*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.mts' '*.cjs' '*.cts' \
  ':(exclude,glob)**/*.test.*' ':(exclude,glob)**/*.spec.*' ':(exclude,glob)**/test/**' \
  ':(exclude,glob)**/tests/**' ':(exclude,glob)**/e2e/**' |
  xargs -0 npx @biomejs/biome@2.5.15 lint --suppress --reason=baseline \
    --only=complexity/noExcessiveCognitiveComplexity --only=complexity/useMaxParams \
    --only=complexity/noExcessiveLinesPerFunction --only=suspicious/noImportCycles
# jscpd: fingerprints of the clones that exist
npx jscpd@5.4.1 --baseline .jscpd-baseline.json --update-baseline
# TypeScript: errors of the strict config, per tsconfig
sh scripts/tsc-baseline.sh tsconfig.strict.json tsc-baseline.txt --write
```

3. Add `.github/workflows/lint-js.yml`:

```yaml
name: Lint JS
on:
  pull_request:
  push:
    branches: [develop]
permissions: {}
jobs:
  lint-js:
    permissions:
      contents: read
    uses: ESchuderer/repo-baseline/.github/workflows/lint-js.yml@<commit sha>
    with:
      typecheck-command: sh scripts/tsc-baseline.sh tsconfig.strict.json tsc-baseline.txt
```

Inputs: `working-directory` (`.`), `node-version-file` (`.nvmrc`), `node-version` (wins over the file), `install-command` (`npm ci`), `biome`, `knip`, `jscpd` (each `true`), `typecheck-command` (empty: skipped), `biome-version`, `knip-version`, `jscpd-version`.

| Rule | Threshold | Reason |
|---|---|---|
| Biome `noExcessiveCognitiveComplexity` ([docs](https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/)) | 15 | The rule's default. |
| Biome `useMaxParams` ([docs](https://biomejs.dev/linter/rules/use-max-params/)) | 5 | Same limit as ruff `PLR0913`, so both languages read alike. |
| Biome `noExcessiveLinesPerFunction` ([docs](https://biomejs.dev/linter/rules/no-excessive-lines-per-function/)) | 80, blank lines and IIFEs skipped | The default is 50; 80 leaves room for a component or a request handler of about one screen. |
| Biome `noImportCycles` ([docs](https://biomejs.dev/linter/rules/no-import-cycles/)) | on | No tuning; each cycle is a defect. |
| knip ([docs](https://knip.dev/features/rules-and-filters)) | every issue type `warn` | Warnings print but do not fail. Move a type to `error` when its count reaches 0. |
| jscpd ([docs](https://github.com/kucherenko/jscpd/blob/master/docs/rust.md#baseline)) | 100 tokens, JS and TS formats, tests excluded | Shorter matches are mostly idiom (imports, option objects). A baseline file tolerates the clones that exist. |
| TypeScript `strict`, `noUncheckedIndexedAccess` ([docs](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html)) | no new error | Few repositories pass `noUncheckedIndexedAccess` on day one (the pilot has 1,052 errors in one package). `tsc-baseline.sh` compares the error list without line numbers; shrink the baseline as errors are fixed. |

Limits: a Biome suppression covers its function, so a baselined function can get worse without failing. Tests are exempt from the three size and complexity rules through the override; adapt its globs per repository. Biome suppressions in the `--only` run ignore `overrides`, which is why the baseline command leaves test paths out.

## lint-python

1. Merge `templates/lint-python/pyproject-quality.toml` into `pyproject.toml` and adapt `include` and the per-path ignores (the CAD script glob there is an example).
2. Record the baselines with the project's dependencies installed (so imports resolve) and the Python version of the workflow, as another version can change what basedpyright reports:

```sh
pip install ruff==0.17.1 basedpyright==1.40.2
ruff check --add-noqa .       # one `# noqa: CODE` per existing finding
basedpyright --writebaseline  # writes .basedpyright/baseline.json
```

3. Add `.github/workflows/lint-python.yml`:

```yaml
name: Lint Python
on:
  pull_request:
  push:
    branches: [develop]
permissions: {}
jobs:
  lint-python:
    permissions:
      contents: read
    uses: ESchuderer/repo-baseline/.github/workflows/lint-python.yml@<commit sha>
    with:
      install-command: pip install -r requirements.txt
```

Inputs: `working-directory` (`.`), `python-version` (`3.13`), `install-command` (empty), `ruff`, `basedpyright` (each `true`), `ruff-version`, `basedpyright-version`.

Rule families: `E4`, `E7`, `E9`, `F`, `B`, `C4`, `C90`, `SIM`, `RET`, `PTH`, `PERF`, `RUF`, `UP`, `I`, `PT`, `ARG`, the pylint limits `PLR0911`, `PLR0912`, `PLR0913`, `PLR0915` and the families `PLE`, `PLW`, `PLC` ([rules](https://docs.astral.sh/ruff/rules/)). To adopt one family per pull request, leave the others out of `select` until their turn.

| Setting | Value | Reason |
|---|---|---|
| `mccabe.max-complexity` ([docs](https://docs.astral.sh/ruff/rules/complex-structure/)) | 10 | ruff's default (`ruff config lint.mccabe.max-complexity`), written out. |
| `pylint` limits | 5 arguments, 6 returns, 12 branches, 50 statements | ruff's defaults (`ruff config lint.pylint.max-args` and the others), written out so a reader sees them. |
| basedpyright `typeCheckingMode` ([docs](https://docs.basedpyright.com/latest/configuration/config-files/)) | `standard` | `recommended` reports every unannotated or partly unknown value (about 2,350 warnings in the pilot against 106 errors), which buries real mistakes. Raise it once the baseline is small. |
| basedpyright baseline ([docs](https://docs.basedpyright.com/latest/benefits-over-pyright/baseline/)) | `.basedpyright/baseline.json` | Existing errors are listed, a new one fails. |

Limits: `--add-noqa` is a per-line baseline in the code ([docs](https://docs.astral.sh/ruff/linter/#error-suppression)); remove the comments as the code is fixed. Tests and CAD scripts get relaxed limits by path, documented in the template. basedpyright needs the project's dependencies installed, otherwise every import is an error.

## sonar

Owner steps, once per GitHub account and once per repository (nothing here can be done from a workflow):

1. Import the GitHub account into SonarQube Cloud ([getting started](https://docs.sonarsource.com/sonarqube-cloud/getting-started/github), [import guide](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/creating-organization/importing-github-organization)) and choose the OSS plan: unlimited public repositories (no private projects), unlimited branch and pull request analysis, custom quality profiles and gates; its price is unverified; the Free plan analyzes only the main branch ([plans](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans)). Unverified: whether a personal account (not an organization) qualifies for the OSS plan.
2. Per repository: import it as a project, then turn Automatic Analysis off under Administration, Analysis Method. CI analysis and Automatic Analysis cannot run on one project ([docs](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis)).
3. Per repository: add the token as the Actions secret `SONAR_TOKEN` ([docs](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud)), and as a Dependabot secret too, since Dependabot pull requests do not get Actions secrets ([docs](https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions)).
4. After the first scan, require the check on `develop`. Pick its exact name in the status check list of the ruleset: Sonar's documentation names it `SonarQube Code Analysis` while community reports name it `SonarCloud Code Analysis` (unverified which one a project shows). Do not require it on `main`: promotion pull requests are not scanned.

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
