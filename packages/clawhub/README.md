# `clawhub`

ClawHub CLI — install, update, search, and publish agent skills plus OpenClaw packages.

## Install

```bash
# From this repo (shortcut script at repo root)
bun clawhub --help

# Once published to npm
# npm i -g clawhub
```

## Auth (publish)

```bash
clawhub login
# or
clawhub auth login

# Explicit device approval (same as the default)
clawhub login --device

# or (token paste / headless)
clawhub login --token clh_...

# print the stored token for CI setup
clawhub token
```

Notes:

- Login defaults to device approval: open the printed verification URL on this or
  another device, sign in with GitHub if needed, and select **Authorize** for the
  one-time code. `--device` explicitly selects the same flow.
- The CLI verifies and stores the token after approval. See the
  [auth guide](../../docs/auth.md#cli-login) for details.
- Default config path:
  - macOS: `~/Library/Application Support/clawhub/config.json`
  - Linux/XDG: `$XDG_CONFIG_HOME/clawhub/config.json` or `~/.config/clawhub/config.json`
  - Windows: `%APPDATA%\\clawhub\\config.json`
- Legacy fallback: if `clawhub/config.json` does not exist yet but `clawdhub/config.json` does, the CLI reuses the legacy path.
- Override via `CLAWHUB_CONFIG_PATH` (legacy `CLAWDHUB_CONFIG_PATH`).

## Examples

```bash
clawhub search "postgres backups"
clawhub install @openclaw/demo
clawhub pin bear-notes --reason "scanner-flagged while awaiting moderation"
clawhub update --all
clawhub update --all --no-input --force
clawhub unpin bear-notes
clawhub skill publish ./my-skill-pack --slug my-skill-pack --name "My Skill Pack" --changelog "Fixes + docs"
clawhub skill publish ./org-skill --owner openclaw --changelog "Org publish"
clawhub sync --all --dry-run
clawhub sync --all
clawhub package explore --family skill
clawhub package explore --family code-plugin
clawhub package inspect @openclaw/example-plugin
clawhub package download @openclaw/example-plugin --tag latest
clawhub package verify ./example-plugin-1.0.0.tgz --package @openclaw/example-plugin --version 1.0.0
clawhub package validate ./example-plugin
clawhub package publish openclaw/example-plugin
clawhub package publish openclaw/example-plugin@v1.0.0
clawhub package publish https://github.com/openclaw/example-plugin --dry-run
clawhub package publish ./example-plugin-1.0.0.tgz --dry-run
clawhub package publish ./example-plugin
```

## Publish code plugins

For ClawPack publish, create the npm-pack tarball yourself and upload that
exact `.tgz`:

```bash
npm pack
clawhub package publish ./my-plugin-1.0.0.tgz --family code-plugin --dry-run
clawhub package publish ./my-plugin-1.0.0.tgz --family code-plugin
```

For local plugin folders, start with a dry run:

```bash
clawhub package publish ./my-plugin --family code-plugin --dry-run
clawhub package publish ./my-plugin --family code-plugin
```

For code plugins, folder publish builds and uploads a ClawPack artifact from
the package folder. Bundle-plugin folders still use the extracted-file publish
path.

Experimental Claws use an exact-artifact flow. Build with OpenClaw, then give
ClawHub the resulting `.tgz`; Claw source-folder publication is rejected:

```bash
openclaw claws validate .
openclaw claws build . --out ./my-claw-1.0.0.tgz
clawhub package publish ./my-claw-1.0.0.tgz --family claw --dry-run
clawhub package publish ./my-claw-1.0.0.tgz --family claw --wait
```

Use `clawhub package download` to resolve the published artifact through
ClawHub's explicit artifact route. ClawPack downloads are verified against npm
integrity/shasum plus ClawHub SHA-256; legacy package versions still download
as ZIPs.

`code-plugin` packages must declare these `package.json` fields:

- `openclaw.compat.pluginApi`
- `openclaw.build.openclawVersion`

Minimal example:

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

`package.json.version` does not replace these OpenClaw-specific fields. Add
`openclaw.compat.minGatewayVersion` and
`openclaw.build.pluginSdkVersion` when you want richer compatibility metadata,
but they are not required for publish.

## GitHub Actions

This repo also provides an official reusable workflow for plugin repos:

- [`.github/workflows/package-publish.yml`](../../.github/workflows/package-publish.yml)

Use `dry_run: true` on pull requests and reserve real publishes for trusted events
such as `workflow_dispatch` or tag pushes with a `CLAWHUB_TOKEN` secret.
For monorepos, pass `source_path` to publish the plugin package folder, for
example `source_path: extensions/codex`.

Package trusted publishing starts after the first normal authenticated publish
creates the package row. Then a package manager can attach GitHub Actions OIDC
config for future supported publishes:

```bash
clawhub package trusted-publisher set @openclaw/example-plugin \
  --repository openclaw/example-plugin \
  --workflow-filename package-publish.yml \
  --environment release

clawhub package trusted-publisher get @openclaw/example-plugin
clawhub package trusted-publisher delete @openclaw/example-plugin
```

`--environment` is optional and exact-match sensitive. If configured, the
GitHub Actions environment in the OIDC claim must match. Tag-push real publishes
still need `clawhub_token` unless the reusable workflow adds tag OIDC support.

## Recover a staged publication

An authorized package publisher can recover artifacts staged by a failed
OpenClaw release workflow using the original attempt ID:

```bash
clawhub package recover <attempt-id> \
  --manual-override-reason "Retry after the release workflow was interrupted" \
  --wait --json
```

Recovery uses the retained artifact and version, preserves the failed attempt's
audit history, and runs fresh security checks. It requires your normal ClawHub
login and current publish access; it cannot override moderation or restore
revoked access. The audit reason must contain 1 through 500 characters.

Without `--wait`, the command reports the new attempt as pending. With `--wait`,
it waits up to 30 minutes and succeeds only after publication; use
`--wait-timeout <seconds>` to set another deadline. Repeating the same authorized
recovery request returns its existing successor attempt.

## Maintainers

The `clawhub` npm package is released separately from the ClawHub app deploy.

- Release workflow: [`.github/workflows/clawhub-cli-npm-release.yml`](../../.github/workflows/clawhub-cli-npm-release.yml)
- Release model: manual-only, stable tags only (`vX.Y.Z`), with a preflight run before the real publish
- Publish auth: npm trusted publishing through the `npm-release` GitHub environment

## Development

The supported verification flow for this package is package-local:

```bash
bun run --cwd packages/clawhub test
bun run --cwd packages/clawhub verify:build
bun run --cwd packages/clawhub test:artifact
bun run --cwd packages/clawhub verify
```

`test` runs source tests only. `test:artifact` builds `dist/` and runs a small smoke suite against the built CLI entrypoint.

## Defaults

- Site: `https://clawhub.ai` (override via `--site` or `CLAWHUB_SITE`, legacy `CLAWDHUB_SITE`)
- Registry: discovered from `/.well-known/clawhub.json` on the site (legacy `/.well-known/clawdhub.json`; override via `--registry` or `CLAWHUB_REGISTRY`)
- Workdir: current directory (falls back to Clawdbot workspace if configured; override via `--workdir` or `CLAWHUB_WORKDIR`)
- Install dir: `./skills` under workdir (override via `--dir`)
