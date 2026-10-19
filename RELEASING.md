# Releasing

Release automation mirrors Agent of Empires core and the sibling plugins: a
maintainer dispatches one workflow with a version, reviews the generated PR, and
merging it tags, publishes, and opens the featured-index PR.

## One-time setup

Configure these in the repository settings before the first release:

- **Secret `RELEASE_TOKEN`**: a PAT with `contents: write` and
  `pull-requests: write` on this repo. The release-staging push, PR and tag push
  use it so they trigger workflows (a tag pushed with the default
  `GITHUB_TOKEN` does not trigger `release.yml`).
- **Secret `AOE_FEATURED_PR_TOKEN`**: a PAT with `contents: write` and
  `pull-requests: write` on `agent-of-empires/agent-of-empires`, used to open
  the featured-index PR. If unset, the release still publishes and the featured
  PR is skipped with a warning; pin the tree hash from the release notes by hand.
- **Environment `release`** with a required reviewer. It gates the release PR
  and the featured PR.

`agent-of-empires.kanban` is a reserved namespace, so the plugin only installs
once AoE's `plugins/featured.toml` pins the release. The featured PR adds that
pin, creating the plugin's entry on the first release.

## Cutting a release

1. **Actions → Prepare Release → Run workflow** with the version without the
   `v` (e.g. `1.0.0`), then approve the `release` gate. It opens a
   `release-staging/vX.Y.Z` PR that bumps `package.json`, `package-lock.json`
   and `aoe-plugin.toml`, and regenerates `CHANGELOG.md`.
2. **Review and merge** the PR once CI is green.
3. `tag-release-pr.yml` checks that all versions and the PR's `release-version`
   marker agree, then pushes the `vX.Y.Z` tag.
4. The tag triggers `release.yml`. It reruns the checks, hashes the tagged tree
   with `aoe plugin hash`, and publishes a GitHub Release (source archive,
   sha256, git-cliff notes, tree hash and the manifest's `aoe_version`). Then it
   opens a PR on `agent-of-empires/agent-of-empires` pinning the tree hash.
5. **Merge the featured-index PR** in the AoE repo. The plugin is now installable
   at that version.

The tree hash comes from the aoe release pinned as `AOE_HASH_TOOL` in
`release.yml`, checked against `AOE_HASH_TOOL_SHA256`. Bump both together, and
only when core changes the hash algorithm.
