# repo-baseline

Shared GitHub setup for ESchuderer's and OpenReloading's repositories: reusable workflows a repository calls with a few lines, pinned to a commit. Each module is optional.

## Modules

| Module | File | What it does |
|---|---|---|
| promote | `.github/workflows/promote.yml` | Keeps one open pull request from `develop` to `main` that lists the commits `main` lacks. Merging it with a merge commit is the release. |

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
