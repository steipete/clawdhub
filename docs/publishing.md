---
summary: "How ClawHub publishing works for skills, plugins, owners, scopes, releases, and review."
read_when:
  - Publishing a skill or plugin
  - Debugging owner or package scope errors
  - Adding publish UI, CLI, or backend behavior
---

# Publishing

Publishing sends a skill folder or plugin package to ClawHub under the owner you
choose. ClawHub checks that your token can publish for that owner, validates the
metadata, name, version, files, and source information, then stores the release
and starts automated security checks.

If validation fails, nothing is published. New releases may also stay out of
normal install and download surfaces until review finishes.

## Skills

The simplest publishing path is the CLI. Sign in, then publish a local skill
folder:

```bash
clawhub login
clawhub skill publish ./my-skill \
  --slug my-skill \
  --name "My Skill" \
  --owner <owner>
```

Use `--owner <handle>` when publishing to an org owner. Omit it to publish as
the authenticated user. Publishing skips unchanged content. A new skill starts
at `1.0.0`, and later changes automatically publish the next patch version. Pass
`--version` only when you need an explicit version.

### Skill catalog metadata

Categories place a skill in the category filters on the ClawHub skills browse
page. Topics become the filter chips offered inside a selected category. Set both
when you publish:

```bash
clawhub skill publish ./my-skill \
  --categories development,operations \
  --topics "git,worktree,cleanup"
```

Both flags take comma-separated values. Categories must be slugs from this list,
matched exactly, so `Development` is rejected. Topics are free-form labels;
ClawHub stores what you pass and displays the normalized form, so `Git Worktree`
appears as `#git-worktree`.

| Slug            | Description                                                               |
| --------------- | ------------------------------------------------------------------------- |
| `integrations`  | Connect services, fetch data, reconcile records, and operate APIs.        |
| `automation`    | Build repeatable processes, scheduled jobs, pipelines, and orchestration. |
| `research`      | Search, browse, scrape, summarize, monitor, and extract web information.  |
| `development`   | Inspect, edit, test, build, debug, and operate codebases.                 |
| `productivity`  | Manage tasks, calendars, email, meetings, projects, and business work.    |
| `communication` | Message, publish, and operate social or communication services.           |
| `creative`      | Create and edit images, video, audio, music, design, and writing.         |
| `knowledge`     | Work with documents, notes, knowledge bases, teaching, and learning.      |
| `agents`        | Change how an agent plans, reflects, learns, remembers, or collaborates.  |
| `operations`    | Inspect, monitor, deploy, and operate local systems or infrastructure.    |
| `security`      | Audit, scan, authenticate, and protect systems or data.                   |
| `finance`       | Work with payments, budgets, banking, shopping, markets, and commerce.    |
| `lifestyle`     | Travel, health, fitness, cooking, sports, home, and daily-life utilities. |
| `other`         | Skills that do not yet fit another browse category.                       |

Rules ClawHub applies to both fields:

- A skill can carry at most 3 categories and at most 5 topics.
- An unknown category slug fails the publish. `--dry-run` does not check slugs;
  the registry validates them when the publish runs.
- `other` is dropped when it is passed alongside a specific category. The
  3-category limit is applied after that, so `other,development,operations`
  stores two categories rather than failing.
- Repeats are dropped rather than rejected, and they are matched after
  normalization, so `git,Git` is one topic. Both limits count what is left after
  that, not what you passed.
- Each topic is at most 48 characters, and topics cannot contain invisible
  formatting characters.
- These topic names are reserved by ClawHub and are rejected: `approved`,
  `audited`, `certified`, `clawhub`, `community`, `curated`, `endorsed`,
  `featured`, `official`, `officials`, `openclaw`, `recommended`, `staff-pick`,
  `trusted`, `trusted-publisher`, `verified`. The check runs on the normalized
  form, so `Official` and `staff pick` are rejected too.
- A skill first published without `--categories` is stored as `other`, so it only
  appears under the Other category.
- On a later publish, omitting `--categories` or `--topics` keeps the values
  already stored. Pass the flag again to change them. Passing an empty value
  clears the field: `--categories ""` returns the skill to `other`, and
  `--topics ""` removes its topics.
- Passing either flag publishes even when the files have not changed, so fixing
  metadata this way creates a new patch version.

Skill owners can also edit categories and topics from the skill's settings page
on ClawHub. That is the quickest fix for a skill that was already published into
`other`.

### Publishing from a catalog repo

For catalog repos, use ClawHub's reusable
[`skill-publish.yml` workflow](https://github.com/openclaw/clawhub/blob/main/.github/workflows/skill-publish.yml).
It calls `skill publish` for each immediate skill folder under `root` (default:
`skills`), or only the folder supplied as `skill_path`.

```yaml
jobs:
  publish:
    uses: openclaw/clawhub/.github/workflows/skill-publish.yml@main
    with:
      owner: <owner>
      dry_run: false
    secrets:
      clawhub_token: ${{ secrets.CLAWHUB_TOKEN }}
```

Use `dry_run: true` to preview new and changed skills without publishing.

The workflow forwards optional `changelog`, `categories`, and `topics` inputs to
`skill publish`, plus `clear_categories` and `clear_topics` for removing metadata
a skill already carries. A skill first published without `categories` is stored
as `other`, the same as [`clawhub sync`](./cli.md#sync); you can also set catalog
metadata later from the skill's settings page.

Like `tags`, `categories` and `topics` apply to **every** skill the run
publishes, and supplying them suspends the unchanged-skill skip — the run
releases a new patch version of each selected skill, including skills whose files
did not change. Pass `skill_path` to bound that to one skill. See the
[workflow notes](./cli.md#github-actions-1) for the full behavior.

## Plugins

Plugins use npm-style package names. Scoped package names include the owner in
the first part of the name:

```text
@owner/package-name
```

The scope must match the selected publish owner. If your package is named
`@openclaw/dronzer`, it can only be published as `@openclaw`. If you publish as
`@vintageayu`, rename the package to `@vintageayu/dronzer`.

This prevents a package from claiming an org namespace that the publisher does
not control.

If you are the rightful owner of an org, brand, package scope, owner handle, or
namespace that is already claimed or reserved on ClawHub, open an
[Org / Namespace Claim issue](https://github.com/openclaw/clawhub/issues/new?template=org-namespace-claim.yml)
with public, non-sensitive proof. See
[Org and Namespace Claims](./namespace-claims.md) for what to include and what
to keep out of public issues.

### Before Publishing a Plugin

- Pick an owner that matches the package scope.
- A code plugin's manifest `id` must be unique within that publisher's packages.
  Different publishers can distribute the same runtime id under distinct scoped
  package names. Choose the explicit scoped name to install a community package;
  known bare OpenClaw aliases select the official package. One OpenClaw
  installation still uses one plugin for each runtime id.
- Include `openclaw.plugin.json`. Code plugins also need `package.json` with
  `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion`.
- To show a custom plugin catalog icon on the homepage and plugin list pages,
  add `icon` to `openclaw.plugin.json` with any HTTPS image URL.
- Include source repository and exact commit metadata, or use the CLI from a
  GitHub-backed checkout so it can detect them.
- Run `clawhub package validate <source>` before publishing. For package,
  manifest, SDK import, or artifact findings, see
  [Plugin validation fixes](./plugin-validation-fixes.md).
- Run `clawhub package publish <source> --dry-run` before creating a release.
- Expect new releases to stay out of public install surfaces until automated
  security checks and verification finish.

An inspector operational failure reports the failing stage. A temporary-workspace
cleanup failure also blocks publication and appears alongside any original
inspection findings; it does not erase the primary error. These failures are
distinct from plugin policy findings. Report the stage and Convex request id
when asking maintainers to investigate; do not include credentials or package
contents in diagnostic reports.

### Trusted Publishing for Packages

Package trusted publishing is a two-step setup:

1. Publish the package once through normal manual or token-authenticated
   `clawhub package publish`. This creates the package row and establishes the
   package managers who can change its trusted publisher config.
2. A package manager sets the GitHub Actions trusted publisher config:

```bash
clawhub package trusted-publisher set @owner/package-name \
  --repository owner/repo \
  --workflow-filename package-publish.yml
```

After config is set, future supported GitHub Actions publishes can use
OIDC/trusted publishing without storing a long-lived ClawHub token in the
repository. The configured repository and workflow filename must match the
GitHub Actions OIDC claim. If you also pass `--environment <name>`, the GitHub
Actions environment claim must match that name exactly.

ClawHub verifies the configured GitHub repository when trusted publisher config
is set. Public repositories can be verified through public GitHub metadata.
Private repositories require ClawHub to have GitHub access to that repository,
for example through a future ClawHub GitHub App installation or another
authorized GitHub integration.

The current reusable package publish workflow supports secretless trusted
publishing for `workflow_dispatch` publishes when `id-token: write` is
available. Tag-push real publishes still need `clawhub_token`, so keep
`CLAWHUB_TOKEN` available for tag releases, first publishes, untrusted packages,
or break-glass publishes.

Real publishes through the reusable workflow wait for the staged attempt to
become public by default. The workflow fails when security checks block or fail
the attempt, the attempt expires, or the 30-minute publication deadline is
reached. Callers can adjust the deadline with `publication_timeout_minutes`.
The maximum is 40 minutes, leaving 35 minutes of reusable job time for setup,
upload, and output capture.
Set `wait_for_publication: false` only for an intentional asynchronous publish.

Inspect or remove the config with:

```bash
clawhub package trusted-publisher get @owner/package-name
clawhub package trusted-publisher delete @owner/package-name
```

Deleting trusted publisher config is the rollback path. It disables future
trusted publish token minting until a package manager sets config again.

### OpenClaw release recovery

OpenClaw automated releases stay non-public until their exact release-parent
attempt succeeds. If that parent fails or is cancelled, the publish attempt
fails permanently. A human recovery dispatch requires protected environment
approval and a version 2 recovery receipt identifying the original authorized
child. Recovery must use the same workflow ref and SHA, candidate, tooling, and
package inventory. That workflow route does not accept cancelled parents.

Already-failed staged plugin attempts can instead be recovered under fresh
publisher authority, without changing the old workflow or its outcome:

```sh
clawhub package recover <attempt-id> \
  --manual-override-reason "Retry the retained release artifacts after workflow failure" \
  --wait --json
```

This uses a normal ClawHub user token and current package publish access.
It creates a successor with the same retained artifacts and version, runs new
security checks, and preserves the failed attempt and original authorization
as audit history. Current token or publisher-access revocation still blocks
publication. It cannot override moderation or revive an active attempt.
Without `--wait`, the result is explicitly pending. The equivalent HTTP route is
[`POST /api/v1/publish/attempts/{id}/recover`](http-api.md#post-%2Fapi%2Fv1%2Fpublish%2Fattempts%2F%7Bid%7D%2Frecover).

Operators can preview orphaned package attempts, supplying an exact `version`,
optional `slugPrefix` or `attemptIds`, and a `reason`:

```sh
bunx convex run --prod maintenance:discardStalePackagePublishAttemptsInternal \
  '{"version":"2026.9.1","slugPrefix":"@openclaw/","reason":"Release parent failed after staging"}'
```

It defaults to a dry run; add `"dryRun":false` to discard each pending release
and retire its attempt. Signed-in admins can run the same operation as the
`maintenance:discardStalePackagePublishAttempts` action. The reason appears as
`error` at `/api/v1/publish/attempts/<id>`, so use publisher-facing wording.
Published releases and terminal attempts are never discarded by this operation.

## FAQ

### Package scope must match selected owner

If the package scope and selected owner do not match, ClawHub rejects the
publish:

```text
Package scope "@openclaw" must match selected owner "@vintageayu".
Publish as "@openclaw" or rename this package to "@vintageayu/dronzer".
```

To fix it, either choose the owner named by the package scope, or rename the
package so the scope matches the owner you can publish as.

If the package name already has the right scope but the package is owned by the
wrong publisher, transfer ownership instead:

```sh
clawhub package transfer @opik/opik-openclaw --to opik
```

Package transfers require admin access to both the current owner and the
destination publisher, unless performed by a platform admin. Use `--to <owner>`
to select an existing, active destination publisher. Scoped package names can
transfer only to the publisher matching their scope. See
[`package transfer`](./cli.md#package-transfer-%3Cname%3E) for details.

Skills use the separate [ownership transfer workflow](./cli.md#transfer).
Transfers to another user normally require recipient acceptance.

If you do not have access to the current owner but believe your org, project, or
brand is the rightful namespace owner, open an
[Org / Namespace Claim issue](https://github.com/openclaw/clawhub/issues/new?template=org-namespace-claim.yml)
with public, non-sensitive proof for staff review. See
[Org and Namespace Claims](./namespace-claims.md) before filing.

This protects org namespaces. A package named `@openclaw/dronzer` claims the
`@openclaw` namespace, so only publishers with access to the `@openclaw` owner
can publish it.
