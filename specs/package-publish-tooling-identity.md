# Package Publish Tooling Identity

OpenClaw automated package publication uses a version 2 identity plus an
immutable parent authorization receipt. The identity describes the child,
candidate, tooling, and parent. It cannot select an authorization policy.

The version 2 identity contains exactly:

- `version`: `2`
- `repository`: `openclaw/openclaw`
- `workflow`: `.github/workflows/plugin-clawhub-release.yml`
- `runId` and `runAttempt`: exact child run attempt
- `ref`, `fullRef`, and `sha`: exact child workflow ref and commit
- `candidateRepository` and `candidateSha`: frozen package payload source
- `toolingRef`, `toolingFullRef`, and `toolingSha`: reviewed release tooling
- `parentRepository`: `openclaw/openclaw`
- `parentWorkflow`: `.github/workflows/openclaw-release-publish.yml`
- `parentRunId` and `parentRunAttempt`: exact release parent attempt

The candidate SHA may differ from the child and tooling SHA. This split-ref
route lets reviewed tooling publish packages built from a frozen release
candidate without pretending that the candidate executed the workflow.

## Parent Authorization Receipt

The parent uploads the receipt only after it has discovered the dispatched
child run and exact package transactions. The artifact name is:

`openclaw-clawhub-parent-authorization-v2-<parentRunId>-<parentRunAttempt>-<childRunId>-<childRunAttempt>`

The archive contains only `authorization.json`. Its version 2 object contains
exactly:

- parent repository, workflow, run, attempt, ref, full ref, and head SHA
- child repository, workflow, run, attempt, ref, full ref, and head SHA
- candidate repository and SHA
- tooling ref, full ref, and SHA
- `authorizationRoute`: `automated-awaited` or `automated-detached`
- non-empty `packages`: exact `{name, version, inventoryDigest}` transactions

The parent receipt is bounded at 64 KiB of UTF-8 JSON, matching the backend,
with at most 512 package transactions. Workflow file preflight and JSON parsing
both enforce that limit. Child identity and recovery approval receipts retain
their separate 8 KiB workflow bounds.

The inventory digest is SHA-256 over package files sorted by path. Each line is
`<path>\0<size>\0<lowercase file sha256>`, joined with `\n`.

ClawHub resolves the artifact from the exact parent run, verifies the GitHub
artifact SHA-256 before reading it, requires the archive to contain only the
receipt, and matches every field to the live child, parent, candidate, tooling,
and requested package transaction.

GitHub's run API does not prove the complete ref qualifier. The receipt is the
full-ref authority; run metadata must not be used to infer it.

## Recovery Approval Receipt

The live child actor selects the route. Actors typed as `Bot` or `App`, and
logins ending in `[bot]`, use the automated parent route and never recovery.
A human dispatch always uses `explicit-recovery`; the identity cannot select
or bypass that policy, even while the parent is active or successful.

A human child must cross the `clawhub-plugin-release` environment through the
`approve_plugins_clawhub_release` job. That job uploads:

`openclaw-clawhub-recovery-approval-<childRunId>-<childRunAttempt>`

The archive contains only `approval.json`, bounded at 8 KiB. Its version 2
object contains exactly:

- `version`: `2`; `kind`: `openclaw-clawhub-recovery-approval`
- `repository`, `workflow`, `runId`, `runAttempt`: the recovery child identity
- `actor`: the live child actor login
- `environment`: `clawhub-plugin-release`
- `approvalJob`: `approve_plugins_clawhub_release`
- `authorizationRoute`: `explicit-recovery`
- `parentRunId`, `parentRunAttempt`: the identity's exact parent attempt
- `authorizedChildRunId`, `authorizedChildRunAttempt`: positive-integer strings
  naming the original child attempt authorized by that parent

Version 1 is rejected. It never supported end-to-end recovery and has no
shipped release-tag compatibility contract.

A completed parent cannot upload another artifact. Recovery therefore resolves
the existing parent receipt using the approval's authorized child:

`openclaw-clawhub-parent-authorization-v2-<parentRunId>-<parentRunAttempt>-<authorizedChildRunId>-<authorizedChildRunAttempt>`

Only the receipt's child run ID and attempt may differ from the recovery
identity. The parent attempt, child repository and workflow, child ref/full
ref/SHA, candidate repository/SHA, tooling ref/full ref/SHA, and exact package
transaction must all still match. A human approval cannot authorize different
workflow code, payload, tooling, package, version, or inventory. The parent
receipt retains its automated route; the verified human approval establishes
`explicit-recovery` for this child.

## State Policy

ClawHub derives parent state policy from the live actor and verified receipts.
Automated children use their own child-bound parent receipt and never fetch a
recovery artifact. Human children require their own recovery artifact before
resolving the original child-bound parent receipt. Submission and public
visibility are separate boundaries:

- submission:
  - `automated-awaited`: parent must be active
  - `automated-detached`: parent may be active or completed successfully
  - `explicit-recovery`: parent may be active, successful, or failed
- public finalization:
  - both automated routes require the exact parent attempt to be completed
    successfully
  - explicit recovery requires the exact parent attempt to be completed
    successfully or failed with the protected recovery evidence

Cancelled parents are never authorized. Unknown routes, states, conclusions,
fields, and versions fail closed. An active parent can authorize only a
non-public staged release.

## Server Authorization

Workflow and CLI checks are diagnostics. They do not authorize a registry
mutation.

For each upload or publish credential request, ClawHub verifies GitHub OIDC,
the exact v2 identity, the live child and parent attempts, actor-derived route,
immutable receipts, the package transaction, and the current tooling ref. It then mints a
short-lived credential bound to:

- upload or publish scope
- child run and attempt
- parent run and attempt
- candidate repository and SHA
- package name, version, and inventory digest
- receipt artifact id and digest
- derived authorization route

Each scope can be minted once for an exact authorization transaction. The
transaction key includes the recovery child's own run ID and attempt, so a new
approved recovery child gets a fresh transaction while reuse of the same
child/scope is rejected. The returned artifact ID and digest identify the
original parent receipt. Replay and cross-package, cross-version, or
changed-inventory minting fail closed.
The server records a first-class transaction key on each scoped credential.
Large-artifact upload tickets bind to that key, so the upload-scoped credential
that creates the ticket and the distinct publish-scoped credential that
consumes it must prove the same repository, workflow run attempt, package,
version, and inventory transaction. Fresh ticket consumption rechecks token
scope, expiry, revocation, consumption, and OpenClaw v2 authorization. A retry
may reuse the same ticket only for the exact storage object already recorded.

Immediately before staging, the ClawHub server repeats the live v2 verification
from the identity stored with the publish credential. The mutation then
rechecks the credential, current trusted-publisher config, package, version,
inventory, expiry, and consumption state, and consumes the credential in the
same Convex transaction as the non-public release insert. A failed mutation
rolls back consumption.

Version 2 OpenClaw publishes always use staged publication. After security
checks pass, the finalizer revalidates the stored exact transaction and
requires the parent attempt to have reached an immutable authorized terminal
outcome. The pending release itself stores its consumed v2 token and inventory
binding. The promotion mutation atomically rereads that token, its revocation
state, package/version/inventory transaction, and current trusted publisher
before changing the release to public. Active parents remain pending. Cancelled
or otherwise unauthorized terminal parents fail the attempt while the release
remains non-public. GitHub API or other transient verification failures remain
retryable. The scheduled pre-publication worker retries ready finalizations
every five minutes.

The terminal outcome removes the cross-system cancellation race: successful
GitHub Actions run attempts do not become cancelled after completion, so the
subsequent Convex publication mutation cannot outlive a mutable active-parent
authorization.

The package source recorded by the registry comes from
`candidateRepository`/`candidateSha`, not the tooling workflow SHA.

## Terminal outcomes

An automated-route attempt whose exact parent attempt completed without success
is terminal: the attempt becomes `failed`, the release remains non-public, and
finalization never retries it. In particular, a failed bot parent reports
`OpenClaw release parent terminal state completed/failure is not authorized by automated-awaited`,
not a missing recovery artifact. Cancellation is terminal on both routes.

## Operator discard

`maintenance:listStalePackagePublishAttemptsInternal` lists non-terminal package
attempts for an exact version and optional slug prefix. Attempt documents are
large: a roughly 600-row incident scan exhausted the 16 MiB read budget. The
query shares a default 200-row budget (maximum 500) across the three active
statuses, then applies the package/version/prefix filters. It is a bounded
window, not an exhaustive inventory; explicit attempt IDs use point reads
through the same filters. Missing releases are returned with a null publication
status.

`maintenance:discardStalePackagePublishAttemptsInternal` and the admin-only
`discardStalePackagePublishAttempts` action default to a dry run. Applying
requires `dryRun: false` and a trimmed, non-empty reason of at most 500
characters. The result identifies candidates and actual retired attempts,
including whether each release or newly created empty package was deleted.

The package owner mutation rechecks attempt ownership and non-terminal state
before deleting a pending release and its storage. It retires the attempt in
the same mutation, even if the release is already gone, clearing both claim
families and storing the reason as the publisher-visible attempt status error.
Without an explicit attempt ID it finds active owners by the package's stored
name and release version; a missing release allows lookup by name and release
ID. If both parent and release are gone, an explicit attempt ID is required.
Terminal attempts, published releases, and publish tokens are outside this
operation. The worker's missing-target and terminal-finalization paths share
the same failure patch.

## Manual Route And Cutover

Ordinary callers remain compatible. Every OpenClaw GitHub Actions OIDC publish
requires v2, including the pre-cutover reusable-workflow revision. The only
non-v2 OpenClaw route is a directly authenticated ClawHub user supplying an
explicit manual override.

OpenClaw must add the v2 identity, post-dispatch parent receipt, package
inventory list, and child inputs before this server gate is deployed. The v2 child must
accept the staged response instead of waiting inline for publication, so the
awaited parent can finish successfully. Published-artifact verification must
run from a detached post-parent route after ClawHub finalization, not from the
still-awaited child run. Merge and deployment of the ClawHub verifier alone
must not move the OpenClaw pin.

## Manual recovery of failed staged packages

`POST /api/v1/publish/attempts/<id>/recover` accepts an ordinary ClawHub user API token and exactly `{ "manualOverrideReason": "..." }` (trimmed, 1–500 characters). It creates a successor only for the current failed staged OpenClaw plugin attempt. The caller must currently have publisher access to the package; platform administrator status does not replace publisher membership. The ordinary GitHub account-age rule also applies. Unauthorized attempt IDs remain undisclosed, and the original attempt status endpoint retains its actor-only visibility.

Recovery retains the failed attempt and consumed v2 token unchanged. The old token, including an expired or revoked token, establishes immutable package/version/artifact provenance only. It grants no recovery authority and is never revived. The new attempt instead records the current user, API token, publisher ownership, and explicit manual reason. Admission and the final publication mutation revalidate this independent authority, current moderation, exact original storage IDs/inventory, and ownership. No request-supplied artifact, identity, or authorization override is accepted.

The successor reuses the staged release and immutable bytes, starts fresh checks, and bypasses cached prior scan results. Only its current claimed clean checks and live finalization claim can publish. Current API-token revocation, lost publisher membership, ownership changes, blocked scans, or moderation prevent publication. The failed automated parent is never represented as successful. No new package version, deleted history, or reset of an active attempt is involved.

A fresh successor returns HTTP 202. An exact replay by the same API token and actor with the same reason returns HTTP 200 and the current successor status; it does not create another attempt. Both responses include `attemptId`, `recoveredFromAttemptId`, `packageId`, `releaseId`, `name`, `version`, `status`, `publicationStatus`, and `reused`. Follow the successor with the existing publish-attempt status endpoint. An independently failed successor may itself be recovered through a fresh explicit request subject to the same checks.
