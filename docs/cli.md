---
summary: "CLI reference: commands, flags, config, and lockfile behavior."
read_when:
  - Using the ClawHub CLI
  - Debugging install, update, or publish
---

# CLI

CLI package: `clawhub`, bin: `clawhub`.

Install it globally with npm or pnpm:

```bash
npm i -g clawhub
# or
pnpm add -g clawhub
```

Then verify it:

```bash
clawhub --help
clawhub login
clawhub whoami
```

## Global flags

- `--workdir <dir>`: working directory (default: cwd; falls back to Clawdbot workspace if configured)
- `--dir <dir>`: install dir under workdir (default: `skills`)
- `--site <url>`: site base URL for registry discovery and device verification (default: `https://clawhub.ai`)
- `--registry <url>`: API base URL (default: discovered, else `https://clawhub.ai`)
- `--no-input`: disable prompts

Env equivalents:

- `CLAWHUB_SITE` (legacy `CLAWDHUB_SITE`)
- `CLAWHUB_REGISTRY` (legacy `CLAWDHUB_REGISTRY`)
- `CLAWHUB_WORKDIR` (legacy `CLAWDHUB_WORKDIR`)

### HTTP proxy

The CLI respects standard HTTP proxy environment variables for systems behind
corporate proxies or restricted networks:

- `HTTPS_PROXY` / `https_proxy`
- `HTTP_PROXY` / `http_proxy`
- `NO_PROXY` / `no_proxy`

When any of these variables is set, the CLI routes outbound requests through
the specified proxy. `HTTPS_PROXY` is used for HTTPS requests, `HTTP_PROXY`
for plain HTTP. `NO_PROXY` / `no_proxy` is respected to bypass the proxy for
specific hosts or domains.

This is required on systems where direct outbound connections are blocked
(e.g. Docker containers, Hetzner VPS with proxy-only internet, corporate
firewalls).

Example:

```bash
export HTTPS_PROXY=http://proxy.example.com:3128
export NO_PROXY=localhost,127.0.0.1
clawhub search "my query"
```

When no proxy variable is set, behavior is unchanged (direct connections).

## Config file

Stores your API token + cached registry URL.

- macOS: `~/Library/Application Support/clawhub/config.json`
- Linux/XDG: `$XDG_CONFIG_HOME/clawhub/config.json` or `~/.config/clawhub/config.json`
- Windows: `%APPDATA%\\clawhub\\config.json`
- Legacy fallback: if `clawhub/config.json` does not exist yet but `clawdhub/config.json` does, the CLI reuses the legacy path
- override: `CLAWHUB_CONFIG_PATH` (legacy `CLAWDHUB_CONFIG_PATH`)

## Commands

### `login` / `auth login`

- Default: prints a one-time code and verification URL. Open the printed URL
  on this or another device, sign in with GitHub if needed, and select **Authorize**.
  The CLI polls for approval, verifies the API token via `whoami`, and saves it
  in your config. It does not open a browser or start a local callback server.
- `--device`: explicitly selects the default device flow.
- `--no-browser`: accepted without `--token`; device login already prints the URL.
- `--label <label>`: labels the token created by device login (default:
  `CLI device login`). Does not rename a token supplied with `--token`.
- Unattended/CI: `clawhub login --token <token>` verifies and stores an existing
  API token. `--no-input` alone still waits for device approval.

See [CLI login](./auth.md#cli-login) for the approval steps and expiry guidance.

### `whoami`

- Verifies the stored token via `/api/v1/whoami`.

### `token`

- Prints the stored API token to stdout.
- Useful for piping a local login token into CI secret setup commands.

### `star <skill>` / `unstar <skill>`

- Adds/removes a skill from your Bookmarks. Command names remain `star` and
  `unstar` for compatibility.
- Calls `POST /api/v1/stars/<slug>` and `DELETE /api/v1/stars/<slug>`.
- `--yes` skips confirmation.

### `search <query...>`

- Calls `/api/v1/search?q=...`.
- Output includes the skill slug, owner handle, display name, and relevance score.
- Search favors exact slug/name token matches before download popularity. A standalone slug token such as `map` matches `personal-map` more strongly than the substring inside `amap`.
- Popularity is a small ranking prior, not a guarantee of top placement.
- `--prefix`: lists a deterministic page of matching slugs through `/api/v1/skills`; pass the printed `--cursor` to continue until no cursor remains.
- `--exact`: restricts relevance search to exact slug matches.
- `--prefix` and `--exact` are mutually exclusive.
- `--cursor` is valid only with `--prefix`.
- If a skill should appear but does not, run `clawhub inspect @owner/slug` while logged in to check owner-visible moderation diagnostics before renaming metadata.

### `explore`

- Lists newest skills via `/api/v1/skills?limit=...&sort=createdAt` (sorted by `createdAt` desc).
- Flags:
  - `--limit <n>` (1-200, default: 25)
  - `--sort newest|updated|rating|downloads|trending` (default: newest). Legacy install sort aliases still work for compatibility.
  - `--json` (machine-readable output)
- Output: `<ownerHandle>/<slug>  v<version>  <age>  <summary>` (summary truncated to 50 chars).

### `inspect @owner/slug`

- Fetches skill metadata and version files without installing.
- `--version <version>`: inspect a specific version (default: latest).
- `--tag <tag>`: inspect a tagged version (e.g. `latest`).
- `--versions`: list version history (first page).
- `--limit <n>`: max versions to list (1-200).
- `--files`: list files for the selected version.
- `--file <path>`: fetch raw file bytes (10MB limit).
- `--json`: machine-readable output; `--file` includes exact bytes as base64 and UTF-8 text when available.

### `install @owner/slug`

- Resolves latest version for the named owner and skill.
- Downloads zip via `/api/v1/download`.
- Extracts into `<workdir>/<dir>/<slug>`.
- Refuses to overwrite pinned skills; run `clawhub unpin <skill>` first.
- Writes:
  - `<workdir>/.clawhub/lock.json` (legacy `.clawdhub`)
  - `<skill>/.clawhub/origin.json` (legacy `.clawdhub`)

### `uninstall <skill>`

- Removes `<workdir>/<dir>/<slug>` and deletes the lockfile entry.
- Does not send uninstall telemetry or decrement ClawHub install counts.
  Running `clawhub sync` does not reconcile removals.
- Interactive: asks for confirmation.
- Non-interactive (`--no-input`): requires `--yes`.

### `list`

- Reads `<workdir>/.clawhub/lock.json` (legacy `.clawdhub`).
- Shows `pinned` next to skills frozen with `clawhub pin`, including the optional reason.

### `pin <skill>`

- Marks an installed skill as pinned in the lockfile.
- `--reason <text>` records why the skill is frozen.
- Pinned skills are skipped by `update --all` and rejected by direct `update <skill>`.
- Pinned skills also reject `install --force` so the local bytes cannot be replaced accidentally.

### `unpin <skill>`

- Removes the lockfile pin from an installed skill so future updates can modify it.

### `update [@owner/slug]` / `update --all`

- Computes fingerprint from local files.
- If fingerprint matches a known version: no prompt.
- If fingerprint does not match:
  - refuses by default
  - overwrites with `--force` (or prompt, if interactive)
- Pinned skills are never updated by `--force`.
- `update <skill>` fails fast for pinned skills and tells you to run `clawhub unpin <skill>` first.
- `update --all` skips pinned slugs and prints a summary of what stayed frozen.

### `skill publish <path>`

- Compares the local bundle fingerprint with ClawHub and exits successfully when
  the content is already published.
- New skills default to `1.0.0`; changed skills default to the next patch
  version.
- `--version <version>` explicitly selects a version and publishes even when the
  content matches an existing version.
- `--dry-run` resolves the publish without uploading; `--json` prints a
  machine-readable result.
- `--owner <handle>` publishes under an org/user publisher handle when the
  actor has publisher access.
- `--migrate-owner` moves an existing skill to `--owner` while publishing a new
  version. Requires admin/owner access on both publishers.
- `--categories <slugs>` and `--topics <topics>` take comma-separated values and
  set where the skill appears in browse filters. A skill first published without
  `--categories` is stored as `other`; a later publish that omits the flag keeps
  whatever is already stored. Valid category slugs, the limits, and the reserved
  topic names are listed in
  [Skill catalog metadata](./publishing.md#skill-catalog-metadata).
- Owner and review behavior is explained in `docs/publishing.md`.
- Publishing a skill means it is released under `MIT-0` on ClawHub.
- Published skills are free to use, modify, and redistribute without attribution.
- ClawHub does not support paid skills or per-skill pricing.
- Legacy alias: `publish <path>`.

```bash
clawhub skill publish ./my-skill --dry-run
clawhub skill publish ./my-skill
clawhub skill publish ./my-skill --version 2.0.0
```

#### GitHub Actions

ClawHub's reusable
[`skill-publish.yml`](https://github.com/openclaw/clawhub/blob/main/.github/workflows/skill-publish.yml)
workflow calls `skill publish` for one `skill_path`, or for each immediate skill
folder under `root` (default: `skills`). It skips unchanged skills and uses the
same automatic patch-version behavior.

Set `dry_run: true` to preview without a token. Real publishes require the
`clawhub_token` secret.

Optional `changelog`, `categories`, and `topics` inputs map to the matching
`skill publish` flags, and `clear_categories` / `clear_topics` remove metadata a
skill already carries. A skill first published without `categories` is stored as
`other`, the same as `sync`. Because catalog metadata applies to every skill the
run publishes and suspends the unchanged-skill skip described above, see the
notes under [GitHub Actions](#github-actions-1) before setting it catalog-wide.

### `sync`

- Scans the current workdir, the configured skills directory, and any
  `--root <dir>` folders for local skill folders containing `SKILL.md` or
  `skill.md`.
- Compares each local skill fingerprint with ClawHub and publishes only new or
  changed skills.
- New skills publish as `1.0.0`; changed skills publish the next patch version
  by default. Use `--bump minor|major` for update batches that should move by a
  larger semver step.
- `--dry-run` shows the publish plan without uploading; `--json` prints a
  machine-readable plan.
- `--all` publishes every new or changed skill without prompting. Without
  `--all`, interactive terminals let you select the skills to publish.
- `--owner <handle>` publishes under an org/user publisher handle when the
  actor has publisher access.
- `sync` is one-way publish only. It does not install, update, download, or
  report install/download telemetry.
- `sync` has no `--categories` or `--topics`. Skills first published through
  `sync` are stored as `other` until someone sets
  [skill catalog metadata](./publishing.md#skill-catalog-metadata) on them.

```bash
clawhub sync --all --dry-run
clawhub sync --all
clawhub sync --root ./skills --owner openclaw --bump minor
```

### `scan --slug <slug>`

- Requires `clawhub login`.
- Runs ClawHub ClawScan through `POST /api/v1/skills/-/scan`, then polls until the scan is terminal.
- Scans are asynchronous and may take time to complete. While queued, the terminal spinner shows the current prioritized scan position and how many scans are ahead.
- Published scans require ownership or publisher management access. Moderators/admins can use the same backend through `clawhub-admin`.
- `--update` is valid only with `--slug`; it writes successful published scan results back to the selected version.
- `--output <file.zip>` downloads the full report archive with `manifest.json`, `clawscan.json`, `skillspector.json`, `static-analysis.json`, `virustotal.json`, and `README.md`.
- `--json` prints the full poll response for automation.
- Local path scans are no longer supported. Upload a new version, then use `scan download` to retrieve the stored scan results for that submitted version.

```bash
clawhub scan --slug gifgrep
clawhub scan --slug gifgrep --version 1.2.3
clawhub scan --slug gifgrep --update --output report.zip
```

### `scan download <name>`

- Requires `clawhub login`.
- Downloads the stored scan report ZIP for a submitted skill or plugin version, including versions that were blocked or hidden by ClawHub security checks.
- Skill downloads use the skill slug and default to `--kind skill`.
- Plugin downloads use the package name and require `--kind plugin`.
- `--version` is required so authors inspect the exact submitted version that ClawHub blocked.
- `--output <file.zip>` chooses the destination path.

```bash
clawhub scan download gifgrep --version 1.2.3
clawhub scan download @scope/demo --version 2.0.0 --kind plugin --output report.zip
```

#### GitHub Actions

ClawHub ships an official reusable workflow at
[`/.github/workflows/skill-publish.yml`](../.github/workflows/skill-publish.yml)
for skill repos and catalog repos.

Typical catalog setup:

```yaml
name: Skill Publish

on:
  pull_request:
  workflow_dispatch:

jobs:
  dry-run:
    if: github.event_name == 'pull_request'
    uses: openclaw/clawhub/.github/workflows/skill-publish.yml@v1
    with:
      owner: nvidia
      dry_run: true

  publish:
    if: github.event_name == 'workflow_dispatch'
    uses: openclaw/clawhub/.github/workflows/skill-publish.yml@v1
    with:
      owner: nvidia
      dry_run: false
      changelog: "Describe the changes in this release."
      categories: "automation"
      topics: "code-review,linting"
    secrets:
      clawhub_token: ${{ secrets.CLAWHUB_TOKEN }}
```

Notes:

- `root` defaults to `skills` for catalog repos.
- Pass `skill_path: skills/review-helper` to process one skill folder.
- `owner` maps to the CLI `--owner` flag; omit it to publish as the authenticated user.
- `changelog`, `categories`, and `topics` map to the matching `skill publish`
  flags and are optional. Omitting them leaves the published metadata untouched.
- Like `tags`, these three apply to **every** skill the run publishes. Pass
  `skill_path` when the values describe one skill rather than the whole catalog.
- **`categories` and `topics` suspend the "skips unchanged skills" behavior
  described above.** The CLI treats supplied catalog metadata as authoritative
  and bypasses its already-published short-circuit, so a catalog-wide run
  publishes a **new patch version of every selected skill**, including skills
  whose files did not change. The `clear_categories` and `clear_topics` flags
  count as supplied metadata and do the same. `changelog` does not: a run that
  passes only `changelog` still reports unchanged skills as `alreadySynced`.
  Use `skill_path` to keep a metadata edit from releasing a whole catalog.
- `changelog` reaches the CLI verbatim, the way `skill publish --changelog`
  stores it, so Markdown indentation and trailing hard-break spaces survive the
  workflow; a value that is only whitespace counts as omitted. `categories` and
  `topics` are trimmed instead, being slug lists.
- Categories and topics are comma-separated and validated server-side, so an
  unknown category slug or a topic over the per-skill limit fails the publish
  after the run has already built and validated the skill.
- To remove categories or topics already on a skill, set `clear_categories: true`
  or `clear_topics: true`. A workflow input cannot distinguish `categories: ""`
  from an omitted `categories`, so the empty string keeps meaning "leave them
  alone" and the boolean is what sends the CLI's `--categories ""`. Setting a
  non-empty value and its `clear_` flag together fails the run rather than
  picking one silently. `changelog` has no such flag: the CLI already reads an
  omitted `--changelog` as empty.
- The run logs echo the resolved `skill publish` command for each target, so a
  forwarded flag is visible in CI output. Keep the values non-sensitive.
- V1 skill publishing uses `clawhub_token`; GitHub OIDC trusted publishing is package-only for now.

### `delete <skill>`

- Without `--version`, soft-delete a skill (owner, moderator, or admin).
- Calls `DELETE /api/v1/skills/{slug}`.
- Owner-initiated soft deletes reserve the slug for 30 days; the command prints the expiry time.
- `--version <version>` withdraws one owned non-latest version through a fail-closed,
  version-specific route. The version number remains reserved and cannot be republished with
  different contents. Publish a replacement before deleting the current latest version. Platform
  staff do not bypass ownership for this version-only flow.
- `--reason <text>` records a moderation note on a whole-skill soft-delete and audit log.
- `--note <text>` is an alias for `--reason`.
- `--yes` skips confirmation.
- The legacy `POST /api/cli/skill/delete` endpoint rejects a supplied `version` instead of
  interpreting it as a whole-skill delete.

### `undelete <skill>`

- Restore a hidden skill (owner, moderator, or admin).
- Calls `POST /api/v1/skills/{slug}/undelete`.
- `--version <version>` restores only the exact retained artifact previously withdrawn by the same
  owner actor. It does not make the restored version latest or recreate removed tags.
- Version restore calls `POST /api/v1/skills/{slug}/versions/{version}/restore`.
- `--reason <text>` records a moderation note on the skill and audit log.
- `--note <text>` is an alias for `--reason`.
- `--yes` skips confirmation.

### `skill tag <skill> <version>`

- Moves an owned skill tag to an existing public version; `latest` is the default.
- Calls `POST /api/v1/skills/{slug}/tags/{tag}`.
- Org publishers require owner or admin membership, matching version withdrawal.
- Use this to roll `latest` back after an accidental higher-version publish; publishing a lower
  version alone intentionally does not replace the highest-semver latest version.
- `--tag <tag>` selects another tag.
- `--yes` skips confirmation.

Example:

```bash
clawhub skill tag @owner/example 1.2.3 --yes
```

### `hide <skill>`

- Hide a skill (owner, moderator, or admin).
- Alias for `delete`.

### `unhide <skill>`

- Unhide a skill (owner, moderator, or admin).
- Alias for `undelete`.

### `skill rename <skill> <new-name>`

- Rename an owned skill and keep the previous slug as a redirect alias.
- Calls `POST /api/v1/skills/{slug}/rename`.
- `--yes` skips confirmation.

### `skill merge <source> <target>`

- Merge one owned skill into another owned skill.
- The source slug stops listing publicly and becomes a redirect alias to the target.
- Calls `POST /api/v1/skills/{sourceSlug}/merge`.
- `--yes` skips confirmation.

### `transfer`

- Ownership transfer workflow.
- Requests to another user normally create a pending request that the recipient accepts.
- Requests to an org or your own personal publisher use a direct publisher move.
  API callers can also select this path explicitly with `toOwner` or `toPublisherHandle`.
- Direct publisher moves apply immediately and require admin access to both the
  current owner and destination publisher, unless performed by a platform admin.
  The destination must be active; moderation restrictions still apply.
- Subcommands:
  - `transfer request <skill> <handle> [--message "..."] [--yes]`
  - `transfer list [--outgoing]`
  - `transfer accept <skill> [--yes]`
  - `transfer reject <skill> [--yes]`
  - `transfer cancel <skill> [--yes]`
- Endpoints:
  - `POST /api/v1/skills/{slug}/transfer`
  - `POST /api/v1/skills/{slug}/transfer/accept`
  - `POST /api/v1/skills/{slug}/transfer/reject`
  - `POST /api/v1/skills/{slug}/transfer/cancel`
  - `GET /api/v1/transfers/incoming`
  - `GET /api/v1/transfers/outgoing`

### `package explore [query...]`

- Browses or searches the unified package catalog via `GET /api/v1/packages` and `GET /api/v1/packages/search`.
- Use this for plugins and other package-family entries; top-level `search` remains the skill search surface.
- Flags:
  - `--family skill|code-plugin|bundle-plugin`
  - `--official`
  - `--executes-code`
  - `--target <target>`, `--os <os>`, `--arch <arch>`, `--libc <libc>`
  - `--requires-browser`, `--requires-desktop`, `--requires-native-deps`
  - `--requires-external-service`, `--external-service <name>`
  - `--binary <name>`, `--os-permission <name>`
  - `--artifact-kind legacy-zip|npm-pack`
  - `--npm-mirror`
  - `--limit <n>` (1-100, default: 25)
  - `--json`

Examples:

```bash
clawhub package explore --family code-plugin
clawhub package explore --family code-plugin --os darwin --requires-desktop
clawhub package explore --family code-plugin --artifact-kind npm-pack
clawhub package explore --npm-mirror
clawhub package explore episodic-claw --family code-plugin
```

### `package inspect <name>`

- Fetches package metadata without installing.
- Use this for plugin metadata, compatibility, verification, source, and version/file inspection.
- `--version <version>`: inspect a specific version (default: latest).
- `--tag <tag>`: inspect a tagged version (e.g. `latest`).
- `--versions`: list version history (first page).
- `--limit <n>`: max versions to list (1-100).
- `--files`: list files for the selected version.
- `--file <path>`: fetch a bounded UTF-8 text preview (200KB limit).
- `--json`: machine-readable output.

### `package download <name>`

- Resolves a package version through
  `GET /api/v1/packages/{name}/versions/{version}/artifact`.
- Downloads the artifact from the resolver's `downloadUrl`.
- Verifies ClawHub SHA-256 for all artifacts.
- For ClawPack npm-pack artifacts, also verifies npm `sha512` integrity,
  npm shasum, and the tarball's `package.json` name/version.
- Legacy ZIP versions download through the legacy ZIP route.
- Flags:
  - `--version <version>`: download a specific version.
  - `--tag <tag>`: download a tagged version (default: `latest`).
  - `-o, --output <path>`: output file or directory.
  - `--force`: overwrite an existing output file.
  - `--json`: machine-readable output.

Examples:

```bash
clawhub package download @openclaw/example-plugin --tag latest
clawhub package download @openclaw/example-plugin --version 1.2.3 -o artifacts/
```

### `package verify <file>`

- Computes ClawHub SHA-256, npm `sha512` integrity, and npm shasum for a local
  artifact.
- With `--package`, resolves expected metadata from ClawHub and compares the
  local file against the published artifact metadata.
- With direct digest flags, verifies without a network lookup.
- Flags:
  - `--package <name>`: package name to resolve expected artifact metadata.
  - `--version <version>` or `--tag <tag>`: expected package version.
  - `--sha256 <hex>`: expected ClawHub SHA-256.
  - `--npm-integrity <sri>`: expected npm integrity.
  - `--npm-shasum <sha1>`: expected npm shasum.
  - `--json`: machine-readable output.

Examples:

```bash
clawhub package verify ./example-plugin-1.2.3.tgz --package @openclaw/example-plugin --version 1.2.3
clawhub package verify ./example-plugin-1.2.3.tgz --sha256 <hex>
```

### `package validate <source>`

- Runs the ClawHub CLI's bundled Plugin Inspector against a local plugin package
  folder.
- Defaults to offline/static validation, without locating or importing a local
  OpenClaw checkout.
- Hard compatibility errors exit non-zero. Warning-only findings are printed but
  exit zero.
- Flags:
  - `--out <dir>`: write Plugin Inspector reports to this directory.
  - `--openclaw <path>`: inspect against an explicit local OpenClaw checkout.
  - `--runtime`: enable runtime capture; imports plugin code.
  - `--allow-execute`: allow runtime capture in an isolated workspace.
  - `--no-mock-sdk`: disable mocked OpenClaw SDK during runtime capture.
  - `--json`: machine-readable output.

Example:

```bash
clawhub package validate ./example-plugin
```

If validation reports a package, manifest, SDK import, or artifact finding, see
[Plugin validation fixes](./plugin-validation-fixes.md), then rerun the command.

### `package delete <name>`

- Without `--version`, soft-deletes a package and all releases.
- `--version <version>` withdraws one owned non-latest release through a fail-closed,
  version-specific route. The version number remains reserved and cannot be republished with
  different contents. Publish a replacement before deleting the current latest version. This
  version-only flow requires the package owner or an org publisher admin; platform staff do not
  bypass package ownership.
- Whole-package soft-delete requires the package owner, an org publisher owner/admin, platform
  moderator, or platform admin.
- Flags:
  - `--version <version>`: withdraw one non-latest version.
  - `--yes`: skip confirmation.
  - `--json`: machine-readable output.

Example:

```bash
clawhub package delete @openclaw/example-plugin --yes
clawhub package delete @openclaw/example-plugin --version 1.2.3 --yes
```

### `package undelete <name>`

- Restores a soft-deleted package and releases.
- Requires the package owner, an org publisher owner/admin, platform moderator,
  or platform admin.
- Calls `POST /api/v1/packages/{name}/undelete`.
- `--version <version>` restores only the exact retained release previously withdrawn by the same
  owner actor. It does not make the release latest or recreate removed package tags/dist-tags.
- Version restore calls `POST /api/v1/packages/{name}/versions/{version}/restore`.
- Flags:
  - `--version <version>`: restore one owner-withdrawn release.
  - `--yes`: skip confirmation.
  - `--json`: machine-readable output.

Example:

```bash
clawhub package undelete @openclaw/example-plugin --yes
```

### `package transfer <name>`

- Transfers a package to another publisher.
- Requires admin access to both the current package owner and destination
  publisher, unless performed by a platform admin.
- Scoped package names must transfer to the matching scope owner.
- Calls `POST /api/v1/packages/{name}/transfer`.
- Flags:
  - `--to <owner>`: destination publisher handle.
  - `--reason <text>`: optional audit reason.
  - `--json`: machine-readable output.

Example:

```bash
clawhub package transfer @openclaw/example-plugin --to openclaw
```

### `package report`

- Authenticated command for reporting a package to moderators.
- Calls `POST /api/v1/packages/{name}/report`.
- Reports are package-level, optionally tied to a version, and become visible
  to moderators for review.
- Reports do not auto-hide packages or block downloads by themselves.
- Flags:
  - `--version <version>`: optional package version to attach to the report.
  - `--reason <text>`: required report reason.
  - `--json`: machine-readable output.

Example:

```bash
clawhub package report @openclaw/example-plugin --version 1.2.3 --reason "suspicious native payload"
```

### `package moderation-status`

- Owner command for checking package moderation visibility.
- Calls `GET /api/v1/packages/{name}/moderation`.
- Shows current package scan state, open report count, latest release manual
  moderation state, download block state, and moderation reasons.
- Flags:
  - `--json`: machine-readable output.

Example:

```bash
clawhub package moderation-status @openclaw/example-plugin
```

### `package readiness <name>`

- Checks whether a package is ready for future OpenClaw consumption.
- Calls `GET /api/v1/packages/{name}/readiness`.
- Reports blockers for official status, ClawPack availability, artifact digest,
  source provenance, OpenClaw compatibility, host targets, environment metadata,
  and scan state.
- Flags:
  - `--json`: machine-readable output.

Example:

```bash
clawhub package readiness @openclaw/example-plugin
```

### `package migration-status <name>`

- Shows operator-oriented migration status for a package that may replace a
  bundled OpenClaw plugin.
- Calls the same computed readiness endpoint as `package readiness`, but prints
  migration-focused status, latest version, official-package state, checks, and
  blockers.
- Flags:
  - `--json`: machine-readable output.

Example:

```bash
clawhub package migration-status @openclaw/example-plugin
```

### `publisher create <handle>`

- Creates an org publisher owned by the authenticated user.
- The handle is normalized to lowercase and may be passed with or without `@`.
- Newly created org publishers are not trusted/official by default.
- Fails if the handle is already used by an existing publisher, user, or reserved route.

```bash
clawhub publisher create opik --display-name "Opik"
```

### `package publish <source>`

- Publishes a code plugin or bundle plugin via `POST /api/v1/packages`.
- `<source>` accepts:
  - Local folder path: `./my-plugin`
  - Local ClawPack npm-pack tarball: `./my-plugin-1.2.3.tgz`
  - GitHub repo: `owner/repo` or `owner/repo@ref`
  - GitHub URL: `https://github.com/owner/repo`
- Metadata is auto-detected from `package.json`, `openclaw.plugin.json`, and
  real OpenClaw bundle markers such as `.codex-plugin/plugin.json`,
  `.claude-plugin/plugin.json`, and `.cursor-plugin/plugin.json`.
- `.tgz` sources are treated as ClawPack. The CLI uploads the exact npm-pack
  bytes and uses the extracted `package/` contents only for validation and
  metadata prefill.
- Experimental Claws must be published from an already-built `.tgz`. Claw
  source folders and GitHub sources are rejected; use `openclaw claws build`
  first. The publish request binds the local SHA-256, and ClawHub returns that
  digest after accepting the exact bytes.
- Code-plugin folders are packed into a ClawPack npm tarball before upload so
  OpenClaw installs can verify the exact artifact. Bundle-plugin folders still
  use the extracted-file publish path.
- For GitHub sources, source attribution is auto-populated from the repo, resolved commit, ref, and subpath.
- For local folders, source attribution is auto-detected from local git when the origin remote points at GitHub.
- External code plugins must declare `openclaw.compat.pluginApi` and
  `openclaw.build.openclawVersion` explicitly.
  Top-level `package.json.version` is not used as a fallback for publish validation.
- `--dry-run` previews the resolved publish payload without uploading.
- `--json` emits machine-readable output for CI.
- `--wait` waits for pre-publication security checks and returns only after the
  release is published or reaches a terminal failure state.
- `--wait-timeout <seconds>` sets the `--wait` deadline (default: 1800).
- `--owner <handle>` publishes under a user or org publisher handle when the actor has publisher access.
- `--categories <slugs>` and `--topics <topics>` behave as they do for
  `skill publish`, but code-plugin and bundle-plugin categories are matched
  against the plugin list, not the skill one: `channels`, `models`, `memory`,
  `context`, `voice`, `media`, `web`, `tools`, `runtime`, `gateway`,
  `security`, `other`. Experimental [`--family claw`](./claws.md) publishes
  skip that category check and store the passed slugs as-is. The topic rules
  in [Skill catalog metadata](./publishing.md#skill-catalog-metadata) —
  limits, reserved names, republish behavior — apply to every family,
  including `claw`.
- Scoped package names must match the selected owner. See `docs/publishing.md`.
- Existing flags (`--family`, `--name`, `--version`, `--source-repo`, `--source-commit`, `--source-ref`, `--source-path`) still work as overrides.
- Private GitHub repos require `GITHUB_TOKEN`.

```bash
clawhub package publish ./plugin.tgz --owner openclaw
```

#### Recommended local flow

Use `--dry-run` first so you can confirm the resolved package metadata and
source attribution before creating a live release:

```bash
npm pack
clawhub package publish ./my-plugin-1.2.3.tgz --family code-plugin --dry-run
clawhub package publish ./my-plugin-1.2.3.tgz --family code-plugin --wait
```

#### Local folder flow

For code plugins, folder publish builds and uploads a ClawPack artifact from
the package folder. This convenience does not apply to Claws:

```bash
clawhub package publish ./my-plugin --family code-plugin --dry-run
clawhub package publish ./my-plugin --family code-plugin
```

#### Minimal `package.json` for `--family code-plugin`

External code plugins need a small amount of OpenClaw metadata in
`package.json`. This minimal manifest is enough for a successful publish:

```json
{
  "name": "@myorg/openclaw-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "compat": {
      "pluginApi": ">=2026.3.24-beta.2"
    },
    "build": {
      "openclawVersion": "2026.3.24-beta.2"
    }
  }
}
```

Required fields:

- `openclaw.compat.pluginApi`
- `openclaw.build.openclawVersion`

Notes:

- `package.json.version` is your package release version, but it is not used as
  a fallback for OpenClaw compatibility/build validation.
- `openclaw.hostTargets` and `openclaw.environment` are optional metadata.
  ClawHub may surface them when present, but they are not required for publish.
- `openclaw.compat.minGatewayVersion` and
  `openclaw.build.pluginSdkVersion` are optional extras if you want to publish
  more detailed compatibility metadata.
- If you are using an older `clawhub` CLI release, upgrade before publishing so
  the local preflight checks run before upload.
- If validation reports a remediation code, see
  [Plugin validation fixes](./plugin-validation-fixes.md).

#### GitHub Actions

ClawHub also ships an official reusable workflow at
[`/.github/workflows/package-publish.yml`](../.github/workflows/package-publish.yml)
for plugin repos.

Typical caller setup:

```yaml
name: Package Publish

on:
  pull_request:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  dry-run:
    if: github.event_name == 'pull_request'
    uses: openclaw/clawhub/.github/workflows/package-publish.yml@v0.12.0
    with:
      dry_run: true

  publish:
    if: github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/')
    permissions:
      contents: read
      id-token: write
    uses: openclaw/clawhub/.github/workflows/package-publish.yml@v0.12.0
    with:
      dry_run: false
    secrets:
      clawhub_token: ${{ secrets.CLAWHUB_TOKEN }}
```

To attach release and catalog metadata, add the matching CLI values to the
job's existing `with` block. Keep `dry_run: true` on pull-request jobs; use
`dry_run: false` only on the trusted publish job shown above.

```yaml
with:
  changelog: "Describe the changes in this release."
  categories: "tools"
  topics: "automation,productivity"
```

Notes:

- The reusable workflow defaults `source` to the caller repo.
- For monorepos, pass `source_path` so the workflow publishes the plugin
  package folder, for example `source_path: extensions/codex`.
- `changelog`, `categories`, and `topics` are optional. When present, the
  workflow forwards them to the matching package publish CLI flags. Categories
  and topics use comma-separated values; omitting them preserves the existing
  workflow behavior.
- To remove previously declared metadata, set `clear_categories: true` or
  `clear_topics: true`. A clear input cannot be combined with its matching
  value input.
- Pin the reusable workflow to a stable tag or full commit SHA. Do not run release publishing from `@main`.
- `pull_request` should use `dry_run: true` so CI stays non-polluting.
- Real publishes should be limited to trusted events such as `workflow_dispatch` or tag pushes.
- Trusted publishing without a secret only works on `workflow_dispatch`; tag pushes still need `clawhub_token`.
- Keep `clawhub_token` available for first publish, untrusted packages, or break-glass publishes.
- Real publishes wait for definitive publication by default. Set
  `wait_for_publication: false` only when a caller intentionally wants the
  legacy submit-and-return behavior.
- `publication_timeout_minutes` controls the publication wait deadline and
  defaults to 30 minutes (maximum: 40).
- The workflow uploads the JSON result as an artifact and exposes it as workflow outputs.

### `package trusted-publisher get <name>`

- Shows the GitHub Actions trusted publisher config for a package.
- Use this after setting config to confirm the repository, workflow filename,
  and optional environment pin.
- Flags:
  - `--json`: machine-readable output.

Example:

```bash
clawhub package trusted-publisher get @openclaw/example-plugin
```

### `package trusted-publisher set <name>`

- Attaches or replaces GitHub Actions trusted publisher config for an existing
  package.
- The package must be created first through normal manual or token-authenticated
  `clawhub package publish`.
- After config is set, future supported GitHub Actions publishes can use
  OIDC/trusted publishing without a long-lived ClawHub token.
- `--repository <repo>` must be `owner/repo`.
- `--workflow-filename <file>` must match the workflow file name in
  `.github/workflows/`.
- `--environment <name>` is optional. When configured, the GitHub Actions
  environment in the OIDC claim must match exactly.
- ClawHub verifies the configured GitHub repository when this command runs.
  Public repositories can be verified through public GitHub metadata. Private
  repositories require ClawHub to have GitHub access to that repository, for
  example through a future ClawHub GitHub App installation or another authorized
  GitHub integration.
- Flags:
  - `--repository <repo>`: GitHub repository, for example `openclaw/example-plugin`.
  - `--workflow-filename <file>`: workflow file name, for example `package-publish.yml`.
  - `--environment <name>`: optional exact-match GitHub Actions environment.
  - `--json`: machine-readable output.

Example:

```bash
clawhub package trusted-publisher set @openclaw/example-plugin \
  --repository openclaw/example-plugin \
  --workflow-filename package-publish.yml \
  --environment release
```

### `package trusted-publisher delete <name>`

- Removes trusted publisher config from a package.
- Use this as rollback if the workflow, repository, or environment pin needs to
  be disabled or re-created.
- Future real publishes must use normal authenticated publishing until config is
  set again.
- Flags:
  - `--json`: machine-readable output.

Example:

```bash
clawhub package trusted-publisher delete @openclaw/example-plugin
```

### Install telemetry

- Sent after `clawhub install <slug>` when logged in, unless
  `CLAWHUB_DISABLE_TELEMETRY=1` is set.
- Reporting is best-effort. Install commands do not fail if telemetry is
  unavailable.
- Details: `docs/telemetry.md`.
