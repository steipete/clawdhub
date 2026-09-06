---
summary: "Security + moderation controls (reports, bans, upload gating)."
read_when:
  - Working on moderation or abuse controls
  - Reviewing upload restrictions
  - Troubleshooting hidden/removed skills
---

# Security + Moderation

See also: [acceptable-usage.md](./acceptable-usage.md) for the marketplace policy on prohibited skill categories.

## Roles + permissions

- user: upload skills (subject to GitHub age gate), report skills/packages.
- moderator: hide/restore skills, view hidden skills, unhide, soft-delete, ban users (except admins).
- admin: all moderator actions + hard delete skills, change owners, change roles.

## Ban + unban batches

- Ban/unban skill batches are paginated and may continue after the mutation that
  started them has committed.
- Unban restore pages must re-read the owner before processing. If the owner is
  missing, banned again, or deactivated, the stale page must abort without
  restoring skills or scheduling another page.
- Restore pages only clear the exact `softDeletedAt` timestamp from the ban
  being lifted and only for skills hidden with `moderationReason = "user.banned"`.

## Exact-version revocation

- Staff can permanently revoke one hosted skill version without deleting the
  publisher account or preventing a later corrected version.
- Revocation soft-deletes the `skillVersions` row and records
  `manualRevocation` evidence with the reason, reviewer, and timestamp. Revoked
  versions must remain unavailable from exact-version metadata, raw-file, and
  ZIP download paths.
- If the revoked version is current, `latestVersionId`, `latest` tags, card
  metadata, embeddings, and search state move to the highest remaining
  non-revoked, non-malicious version.
- If no usable version remains, the skill gets its own
  `moderationReason = "manual.version_revoked"` hold and no latest pointer.
  This hold is intentionally independent from `user.banned`, so account unban
  cannot re-expose the revoked skill history.
- Publishing a new version may make that corrected version current and clear
  the skill-level hold. It must never clear `manualRevocation` or
  `softDeletedAt` from older revoked versions.

## Account and publisher deletion

- User and org deletion are soft-delete flows. They must not hard-delete users,
  publishers, memberships, skills, packages/plugins, reports, or audit rows.
- Deleting a personal account hides personal publisher resources and any orgs
  where that user is the sole owner. Multi-owner orgs stay active.
- Deleting an org publisher marks the publisher deleted/deactivated and hides
  resources owned by that publisher. Skills are hidden with
  `moderationReason = "publisher.deleted"` and packages/plugins with
  `softDeletedReason = "publisher.deleted"`.
- Public/user-facing browse, detail, install, raw-file, and package download
  paths must continue to exclude soft-deleted resources regardless of whether
  the deletion came from moderation, account deletion, or org deletion.

## Publisher abuse scoring

- Publisher abuse scoring classifies bulk-publishing abuse for staff review and
  warning-first automatic enforcement. Scheduled pressure scoring runs daily.
  Temporal traffic detection has two entrypoints: a read-only bounded preview
  and one resumable scheduled pipeline that is the sole writer of signal rows.
  The scheduled pipeline persists bounded source pages, exact percentile
  samples, and candidate observations, then
  resumes through percentile and classification phases. Temporary scan rows
  expire after seven days. A failed step retries from the last persisted cursor
  with bounded backoff; any successfully persisted page resets the consecutive
  failure count. A watchdog treats fifteen minutes without persisted progress as
  a failed attempt. After five consecutive failed attempts, the run becomes
  terminal, retains the last error for the staff UI, emits the structured
  `publisher_temporal_abuse_scan_failed` operator event.
  Moderators can start this same full signal pipeline from the staff Signals tab.
  New manual starts record the actor; requests made while a temporal scan is
  already active return that run without starting a competing worker. Stale
  recovery continues the same durable run instead of replacing it, and
  cursor-guarded writes prevent overlapping late workers from duplicating work.
  Explicitly bounded previews remain diagnostic-only. Moderators can cancel the
  displayed running signal scan without deleting recorded evidence. Cancellation
  uses the shared terminal state so scheduled work stops, records the actor, and
  is a no-op if that exact run has already finished or been replaced. A signal run
  from an older model must not lock the control that starts its replacement.
  New scan indexes must ship in a staging-only release before any function
  queries them. Keep the indexes marked `staged: true`, deploy that schema,
  and wait until Convex reports every index ready. Only a later release may
  activate and query them. This applies to
  `by_run_id_and_excess7_downloads`,
  `by_run_id_and_synchrony_eligible_and_owner_key`, and
  `by_owner_key_and_signal_type`.
  The `review` label remains a calibration/manual-review signal. The
  `potential_ban_candidate` label is an
  enforcement signal only for pressure-score nominations: the first eligible
  enforcement sweep must warn the linked non-staff user by email and persist the
  warning score/run/deadline on the nomination. A later sweep may automatically
  ban only after the warning deadline has passed and a newer pressure score
  still places the publisher in `potential_ban_candidate`. A stale warning by
  itself is not enough to ban.
- Temporal download percentiles use the full active-skill population, including
  zero-download, official, staff-owned, and personal skills. Publisher
  exclusions apply only to review candidates, not to the platform benchmark.
  Partial scans must not archive signals or present their top-download slice as
  a platform percentile.
- Temporal download signals compare each skill with both its own frozen history
  and the full active-skill population. A 7-day surge requires both its growth
  multiple and its absolute downloads above the frozen baseline to exceed the
  platform P99, regardless of install count. A standalone skill signal must also
  reach at least 6,400 downloads in seven days or 7/30 of ten times the platform
  30-day download P99, whichever is higher. The lower proportional floor of
  7/30 of the sustained-traffic threshold is only enough to participate in a
  publisher-wide synchronization check; it never creates a standalone skill
  signal. These requirements prevent a tiny baseline or a low platform
  percentile from turning modest isolated traffic into a signal. The stored
  `download_spike_flat_installs` identifier is retained only so existing signal
  rows keep their identity. Sustained traffic uses the 30 days before the current
  30-day observation period as a frozen baseline, so a month-long rise cannot
  raise its own comparison point. Each of the latest 14 days is compared with a
  threshold derived from the platform P95 growth multiple and P95 absolute
  excess; at least 10 days must exceed that threshold. The same skill must also
  reach a distributed download total within those same 14 days of at least
  6,400 or ten times the platform 30-day download P99, whichever is higher.
  Each day's contribution to this decision is capped at one tenth of that
  required total; reported download counts remain uncapped. Older downloads
  cannot satisfy this gate, and one recent burst cannot turn otherwise modest
  traffic into a sustained signal. Uneven daily traffic may still qualify;
  there is no additional minimum volume required on each abnormal day.
  At most 5 installs are allowed in the 14-day window. The standalone surge
  detector is independent and uses uncapped counts, so one extreme day can
  still trigger a surge signal without qualifying as sustained. These
  volume requirements prevent broad crawler traffic from being presented
  as a publisher-specific anomaly. This
  catches traffic that arrives at a steady, exceptionally high rate after a
  cold start instead of only detecting a spike on the day it begins. These
  signals record anomalous traffic for staff visibility, not publisher
  attribution or an enforcement decision.
- The Signals tab is read-only telemetry. New signal rows do not have snooze,
  dismissal, notification, ownership, or reply state. Legacy temporal
  nominations remain readable and remain ineligible for autoban so existing
  production records survive this rollout; the shared review tables continue
  to serve aggregate pressure scoring. Removing legacy temporal records requires
  a separate, explicitly approved production migration.
- The completed temporal pipeline also checks for publisher-wide synchronization
  among scan candidates that either have a sustained anomaly or clear the lower
  proportional 7-day spike floor plus both platform P99 comparisons.
  The synchronized group must cover at least 15% of the publisher's currently
  published skills and more than half of its eligible scan candidates. Each
  member's normalized trailing 60-day curve must have Pearson correlation of at
  least 0.98 with the portfolio's median normalized curve, and the largest
  seven-day rolling peak must be no more than 1.25 times the smallest. At least
  two skills are required only because a trend comparison needs a group; there
  is no fixed catalogue-size threshold. The full 60-day curve is captured during
  the existing catalogue read and carried in the temporary scan candidate. Synchrony then
  reads those candidates in bounded pages instead of querying each skill again.
  A publisher above 8,000 synchrony candidates is skipped with the structured
  `publisher_temporal_abuse_synchrony_owner_skipped` operator event, and the
  scan continues with later publishers. This bounds one action without turning
  a single oversized portfolio into a terminal full-scan failure.
  Page size never
  becomes an eligibility ceiling, and each publisher is evaluated once per run
  even when its candidates span several source pages. Candidate reads use the
  publisher-and-run index, so retained observations from older runs do not add
  work to the current scan. Median-reference comparison keeps detector work near
  linear as a portfolio grows. This produces one
  `owner_synchronized_download_trends` signal for the publisher, not one extra
  signal per skill. The majority and similar-peak requirements avoid treating a
  small coincidental subset or shared direction alone as evidence.
- Publisher abuse scoring must skip staff-linked and official publishers before
  nominations are created. Publisher abuse autoban must process pending
  `potential_ban_candidate` pressure nominations without waiting for the score
  run to finish. It must not warn or autoban `review` nominations, historical
  backfill temporal nominations, partial current temporal nominations,
  nominations without a linked user account, or candidates whose linked user has
  no email address. Skipped pending nominations must be moved out of pending
  status with an explanatory review event so the cron does not retry them
  forever.
- Publisher abuse automatic bans must still use the account ban flow, including
  token revocation, owned listing hiding, audit logging, and the normal
  suspension/appeal email.
- Publisher abuse Signals are read-only staff telemetry. They must not feed
  automatic ban pressure, create a review queue, notify staff or publishers, or
  expose workflow actions. The Signals view lists every stored observation and
  shows bounded evidence in a detail drawer. For skill-level signals, the drawer
  loads daily downloads and installs for the trailing 30 days from the bounded
  daily-stat index. When a model version renames an equivalent signal type, it
  must reuse the existing row so one observation keeps a stable identity across
  detector versions.
- Every `publisher-abuse-temporal.*` model version, including legacy rows,
  remains ineligible for warning-first automatic enforcement. A future decision
  to enforce temporal traffic signals requires an explicit policy and code
  change; increasing a temporal score cannot silently cross the existing
  pressure-model autoban boundary.
- Aggregate publisher spam-abuse labels start at the 200-skill pivot. Below
  that pivot, publishers can contribute to the population baseline, but they
  cannot receive aggregate spam reason codes or be nominated by this score path.
- At or above the pivot, catalog volume raises pressure multiplicatively while
  installs, stars, and downloads lower it. Legitimate high-adoption publishers
  with large catalogs should stay below review thresholds.
- Engagement expectations scale sublinearly with catalog size. The scorer must
  not require every extra skill to have the same per-skill installs/stars as the
  first 200 skills; a few successful skills can lower pressure for the broader
  catalog. Catalog size still raises pressure, so large low-adoption catalogs
  remain eligible for review or ban-candidate labels.
- Official publishers are excluded from publisher abuse scoring and
  enforcement. An excluded publisher must not contribute to score-run cohort
  statistics, receive a score label/rank, open or update a nomination, appear in
  the dashboard/detail state, or be actionable through a stale nomination id.
- The exclusion is backend-enforced. The management UI must derive its publisher
  abuse list from the filtered backend dashboard state instead of applying a
  separate client-side official-org filter.

## Reporting + auto-hide

- Reports are unique per user + target (skill/package).
- Report reason required (trimmed, max 500 chars). Abuse of reporting may result in account bans.
- Per-user cap: 20 **active** reports.
  - Active skill report = skill exists, not soft-deleted, not `moderationStatus = removed`,
    and the owner is not banned.
  - Active package report = package exists, not soft-deleted, and the owner is
    not banned/deactivated.
- Auto-hide: when unique reports exceed 3 (4th report):
  - skill report flow:
    - soft-delete skill (`softDeletedAt`)
    - set `moderationStatus = hidden`
    - set `moderationReason = auto.reports`
    - set embeddings visibility `deleted`
    - audit log entry: `skill.auto_hide`
- Package reports feed `clawhub-admin package moderation-queue` and audit `package.report`,
  but do not auto-hide or block downloads. Moderators can review a formal report
  with an explicit final action to quarantine or revoke the affected release.
- Package reports can be moved to `confirmed` or `dismissed` with a moderator
  note. Only `open` reports count toward `packages.reportCount` and user active
  report limits; confirming or dismissing a report decrements the open count.
- Skill reports now follow the same formal lifecycle: `open`, `confirmed`, or
  `dismissed`, with a single recorded `triageNote` used as the official outcome
  note. Moderators can review a formal report with an explicit final action to
  hide the affected skill. Skill report timelines are stored in
  `skillModerationEventLogs`.
- Package owners and publisher members can read package moderation status via
  API/CLI, including open report count, latest release moderation state, and
  download-block reasons. Reporter identities and report bodies remain moderator
  intake data.
- Package publish actions may spend time validating and scanning before the
  final release write. The final `insertReleaseInternal` mutation must re-read
  the publish actor, owner user, and owner publisher and reject if any of those
  principals are banned, deactivated, or deleted.
- OpenClaw install clients can read the exact-release public trust endpoint at
  `GET /api/v1/packages/{name}/versions/{version}/security` without owner or
  moderator credentials. The endpoint returns only package identity, exact
  release artifact identifiers, and the install-consumable trust summary.
- `trust.blockedFromDownload` is the canonical install block signal for package
  releases. OpenClaw must use it instead of re-deriving blocking behavior from
  individual scan or moderation fields. `trust.reasons` is the compact user and
  audit explanation list, for example `manual:quarantined`, `scan:malicious`,
  or `package:malicious`; public trust responses must not expose open report
  counts.
- Successful exact package-release security reads expose the audit page's
  canonical summary-and-guidance copy as top-level `overview` and link the
  exact release through `securityAuditUrl`; neither field changes trust decisions.
- The legacy skill/package appeal tables and backend routes remain for
  compatibility, but the first-class CLI and docs surface is deprecated.
  Publisher recovery for false positives should use reports or out-of-band
  support, while account bans require out-of-band support.
- Any ClawScan path that determines a skill or plugin release is malicious must
  block that candidate version and notify the publisher with local
  `clawhub scan` remediation guidance. Scanner-triggered emails are
  artifact-level and must not link to account appeals. Account-level autoban,
  token revocation, and appeal email only happen after the silent escalation
  thresholds: two distinct malicious artifacts or three malicious attempts on
  the same artifact. Static scan findings are ClawScan input context only and
  must not schedule account autobans or set public/install-blocking trust by
  themselves.
- Pending skill ownership transfers must not be accepted when the requesting
  owner is deleted/deactivated or when the skill is malicious, hidden, or
  removed. The accept path is the final shared gate before ownership changes,
  so it must cancel the pending transfer before reporting the rejection.
- User-submitted `POST /api/v1/skills/-/scan` upload scans are authenticated but
  ephemeral. They store uploaded files only on `skillScanRequests`, feed the
  normal ClawScan worker, and must never create or patch public `skills`,
  `skillVersions`, moderation, or trust state. Expired `skillScanRequests` rows
  must be pruned by cron so uploaded file payloads do not become durable skill
  storage. Published scan requests may patch a version only when the caller can
  manage the skill and explicitly sets `update: true`; local uploads must reject
  update mode.
- GitHub-backed skill verification also uses ephemeral `skillScanRequests` to
  feed exact current skill-folder bytes into the normal ClawScan worker. Large
  file manifests use a prepare, bounded child-chunk append, and finalize sequence
  rather than one oversized Convex document or function argument. The request
  must exist before blob storage begins, each bounded chunk is durably attached
  as it is stored, descriptor metadata is capped at 4 MiB, and worker claims
  hydrate one signed-URL-heavy job at a time. A recently prepared request remains
  leased until finalization so concurrent syncs cannot replace it. Unlike
  user-submitted upload scans, its completed ClawScan, SkillSpector, and static
  context are persisted on `githubSkillScans` by skill and content hash so the
  public Security audit remains available after request files are pruned through
  bounded continuation batches. Cleanup cancels the linked worker job before
  deleting the first chunk. Legacy source-backed statuses without a durable
  `githubSkillScans` result must return to pending on sync rather than remain
  trusted. Explicit owner/moderator rescans use the manual worker queue.
  GitHub-backed verification must not create or patch a hosted `skillVersions`
  row, and static findings remain input context rather than a blocking verdict.
- `auditLogs` remains the global compliance/security ledger. Product-facing
  moderation timelines live in `skillModerationEventLogs` and
  `packageModerationEventLogs`.
- Ownership-adjacent identity changes must also write `auditLogs`: user profile
  sync/update/ensure/delete, personal publisher create/sync, and org trusted
  publisher set/unset. Personal publisher sync should log meaningful create,
  change, link, or membership events, not routine login refreshes.
- Public queries hide non-active moderation statuses; moderators can still access via
  admin-only queries and unhide/restore/delete/ban.
- Public skill raw-file, README, package-compat file, and zip download reads must
  honor the same malware/pending/hidden/removed download block. Metadata routes
  may keep exposing malware-blocked skill summaries for transparency, but they
  must not serve the blocked artifact payload to public callers. Exact-version
  skill and package metadata routes must also block when the requested version is
  the moderated source version.
- Skill version tags and `latestVersionId` are only valid when the referenced
  `skillVersions` row belongs to the same skill and is not soft-deleted. Writers
  must reject cross-skill tag targets, and public readers should treat stale
  cross-skill pointers as missing versions.
- Legacy report rows with `status: "triaged"` are read as `confirmed` for
  compatibility while new writes store `confirmed`.
- Skills directory supports an optional "Hide suspicious" filter to exclude
  active-but-flagged (`flagged.suspicious`) entries from browse/search results.

## Skill publish upload boundary

- CLI skill publishing stages each file through the direct Convex HTTP surface,
  keeping file bodies off the Vercel request path. Each file remains capped at
  10MB and the complete publish remains capped at 50MB.
- The server creates a short-lived, user-bound ticket before accepting a file.
  The upload action enforces the declared path, byte size, content type, and
  SHA-256 before attaching the resulting storage id to that ticket.
- Storage metadata SHA-256 values may be hex or base64 depending on the Convex
  runtime. Attachment validation compares the decoded digest bytes while the
  ticket and public publish contract remain canonical lowercase hex.
- JSON skill publishes must present the matching ticket for every staged file.
  Ticket ownership and file metadata are revalidated, and ticket consumption is
  committed atomically with the new skill version.
- Unconsumed staged files are deleted when their tickets expire. Failed
  attachment attempts delete the just-created storage blob immediately.

## Package publish upload boundary

- Package publish is multipart-only. `POST /api/v1/packages` must reject JSON
  request bodies, including bodies that reference pre-existing storage IDs.
- Public HTTP package publish payloads must not accept caller-supplied `files`
  or `artifact` metadata. Internal publish actions may receive that metadata
  only after the HTTP boundary derives it from uploaded multipart bytes or a
  staged ClawPack blob.
- Package publish accepts either multipart `files` uploads or one `clawpack`
  tarball reference, never both in the same request. `clawpack` may be a direct
  `.tgz` file part or a Convex storage id created by the upload-url flow. The
  storage-id path must include the matching `clawpackUploadTicket`, and the
  server must reject tickets from a different auth context, expired or used
  tickets, and storage blobs created before the ticket.
- The inline multipart budget (`MAX_PACKAGE_MULTIPART_BYTES`) must stay below
  the 4.5 MB request body cap of the Vercel functions that front `clawhub.ai`.
  Anything larger goes through the upload-url flow, which uploads straight to
  Convex storage; the CLI picks the route from the same shared constant.
- Direct package publish multipart bytes are capped at 18MB so callers get a
  clear ClawHub validation error before hitting Convex's 20MB HTTP action body
  cap. ClawPack tarballs keep the 120MB package tarball cap through staged
  storage uploads.
- For tarball uploads, ClawHub stores the uploaded tarball, derives its
  artifact hashes and npm metadata, and derives package file metadata from the
  tarball contents.
- Experimental `family: claw` publication requires one already-built npm-pack
  `.tgz` plus the publisher-computed canonical lowercase SHA-256. It must not
  accept source directories, GitHub checkout sources, extracted-file
  publication, or the legacy public-action path. The HTTP boundary recomputes
  the digest from the accepted tarball bytes before creating or reusing any
  release state.
- A Claw staged-attempt key binds actor, owner, normalized package name,
  version, and verified tarball digest. Only that exact tuple may reuse an
  active pending attempt or active published release. Different artifacts or
  owners and terminal, soft-deleted, blocked, quarantined, revoked, or
  malicious state whose target still exists must preserve the version conflict
  rather than being reused or discarded. Hard deletion removes package and
  release rows but retains the publish attempt as audit history; an attempt
  whose referenced package or release no longer exists is audit-only and must
  neither reserve that package version nor be reused.
- Claw pending and final publication responses expose the verified artifact
  SHA-256. Polling must preserve the same digest, and the package artifact
  download must serve the exact stored tarball bytes whose SHA-256 matches that
  value. Trusted publish tokens accepted by an idempotent retry are revoked on
  the same success boundary as a newly created attempt.
- A staged publish attempt is not a successful release. ClawHub dispatches an
  exact pre-publication worker through the production GitHub App as soon as the
  attempt becomes pending; the scheduled worker remains recovery for missed
  dispatches.
- For pending-check and ready-finalization attempts, duplicate targeted recovery
  against a live foreign lease returns no work. It preserves the existing claim
  ID and expiry without falling through to another claim path; the same claim
  may resume its own lease.
- Authenticated package publishers can read only their own exact publish
  attempt, or the exact package and version authorized by a GitHub Actions
  publish token. The response exposes one normalized pending, published,
  blocked, failed, or expired publication state without exposing another
  publisher's attempt identifiers or scan details.
- Release automation must wait for the authoritative attempt to become
  published or terminally fail. A pending upload response alone must never make
  a package publication workflow succeed.

## Skill moderation pipeline

- New skill publishes now persist a deterministic static scan result on the version.
- Static findings are internal evidence for Codex-backed ClawScan only. They do
  not hide, block, set public security status, affect installability, or trigger
  user autobans.
- Public artifact pages present SkillSpector findings, VirusTotal malware telemetry,
  and ClawScan-powered risk review as one consolidated Security audit page.
  This is a product-facing model only; scanner storage, moderation decisions,
  and worker behavior remain separate internally.
- ClawScan verdicts come from a GitHub Actions Codex worker, not a single
  hosted LLM call. Codex reviews the materialized artifact workspace with
  SkillSpector, A.I.G, and static scan evidence as context.
- ClawScan is the sole authority for the stored risk-analysis verdict and its
  moderation consequences. A.I.G is required supporting evidence for skill
  scans: missing, failed, or malformed A.I.G output fails the worker through
  the normal retry lifecycle, but an A.I.G finding never independently blocks,
  hides, or changes installability. Package releases skip the skill-only A.I.G
  scanner.
- Production workers install A.I.G and its complete Python dependency set from
  the reviewed, hash-locked worker requirements file. Updating the scanner or a
  dependency requires an explicit lock update; a mutable package-index artifact
  must not enter a credentialed scan worker.
- A.I.G 0.2.1 is affected by CVE-2026-84809 and cannot inspect packaged Python
  bytecode. While that version remains pinned, both worker paths must reject
  skill targets containing `.pyc`, `.pyo`, or `.pyd` files before invoking
  A.I.G. ClawScan's static scanner independently flags packaged Python bytecode,
  but that defense does not remove the worker-boundary rejection requirement.
- In the external Codex security worker, package-release SkillSpector runs scan
  only normalized bundled-skill roots declared by the stored plugin manifest
  summary. The plugin package root is never a fallback SkillSpector target;
  packages with no bundled roots provide ClawScan an explicit not-applicable
  result. This is not a prepublication-worker contract.
- Current skill and plugin scans are queued through `securityScanJobs` and
  completed by the external Codex worker.
- VirusTotal telemetry remains a separate Security audit signal and is not an
  input to the production ClawScan profile or judge.
- The worker's explicit artifact-only OSS ClawScan route accepts every claimed
  target kind and source through the same completion/failure contract. Skill
  versions and scan requests use the isolated `artifact` root; extracted
  ClawPack releases use `artifact/package`.
- Both workers disambiguate directories containing `SKILL.md` and
  `openclaw.plugin.json` by selecting the manifest matching the claimed target
  kind. ClawScan still scans the full directory. Single-manifest directory
  scans and the separate bundled-SkillSpector directory base remain unchanged.
- OSS ClawScan is the only security-scan implementation. Every claimed target
  kind and source runs through the same ClawScan profile and completion/failure
  contract. ClawScan failures use the existing failure/retry lifecycle; there
  is no per-job fallback or alternate legacy route.
- On Unix runners, ClawScan commands run in isolated process groups. A timeout
  must terminate the full process group so surviving scanner or judge
  descendants cannot hold a worker slot after the timeout is recorded.
- The production scan-worker timeout defaults to 15 minutes. Package-release
  SkillSpector runs can validly exceed four minutes, so a lower timeout must not
  be used as the normal capacity control.
- A ClawScan judge result is complete only when ClawScan verifies
  a workspace-only inspection challenge and the SHA-256 of a required artifact
  file. Missing or mismatched inspection receipts fail the judge and use the
  normal scan failure/retry lifecycle; a low-confidence verdict cannot replace
  successful artifact inspection.
- Every worker run publishes a GitHub Actions summary and uploads a structured
  summary with its secret-scanned diagnostics. The summary reports ClawScan
  completions, failures, timeouts, scanner-stage and judge-stage failures,
  duration, throughput, queue health, and verdict totals. Queue-health lookup
  failures are diagnostic-only and must not change persistence, retries, or the
  worker exit result.
- Retained worker diagnostics preserve complete redacted ClawScan artifacts and
  per-scanner outputs without per-file or aggregate-size truncation. Bounded
  metadata/error fields may remain capped. Artifact upload still requires the
  existing verified-secret scan to pass.
- Claimable queue work edge-triggers a coalesced GitHub Actions worker dispatch.
  Successful completion requests another dispatch while queued work remains; a
  five-minute Convex cron is only a recovery watchdog for lost dispatch signals.
  Convex emits the narrowly typed `clawhub-security-scan`
  `repository_dispatch` event using the production GitHub App. Event-driven
  dispatch stays disabled until that installation is verified to have Contents
  write permission. GitHub Actions concurrency is scoped per worker shard so a
  delayed runner allocation cannot block every shard; each shard still keeps at
  most one running and one pending drain wave.
- Queue source priority is `manual`, `backfill`, `publish`, `vt-update`, then
  `bulk-rescan`. A later VirusTotal update may make a waiting publish job
  claimable immediately, but it must not demote that job from publish priority.
- Bulk rescans stay lowest priority and use the bounded operator campaign flow,
  which enqueues one page at a time and waits for that page before continuing.
- ClawScan worker concurrency is an operator-controlled compute concern. The
  backend claim path must cap only a single worker claim size and must not impose
  a global active-scan ceiling; horizontal capacity is controlled by worker
  dispatch count, worker batch limit, provider quotas, and cost monitoring.
- The Skill Card verification envelope exposes ClawScan as the top-level
  `security` verdict for install automation, with deterministic and third-party
  scanner evidence grouped under `security.signals`. Clients should key install
  decisions off `ok`, `decision`, `reasons`, and `security.status` instead of
  re-deriving trust from individual signal payloads.
- Exact-version security verdict reads preserve the complete skill identity.
  Batch callers may qualify a request with the publisher handle; owner, slug,
  and version form the dedupe identity, and qualified success or failure results
  echo the normalized requested owner. Unqualified reads retain legacy slug
  resolution, including fail-closed ambiguity, for older clients.
- Successful exact-version security verdicts expose the audit page's canonical
  summary-and-guidance copy as top-level `overview`; install clients consume that
  field instead of reconstructing audit text from scanner details.
- Security verdicts are version-scoped scanner results. ClawHub has no manual
  trust override: staff moderation may change availability or resolve an appeal,
  but it must not replace a version's scanner verdict or let a later publish
  inherit an earlier review decision. Historical staff actions remain in the
  audit log only.
- ClawScan verdicts treat purpose-aligned notes as user guidance, not a
  suspicious verdict. Medium-only material concerns are visible
  `flagged.review` guidance and must not set `isSuspicious`; high or critical
  concerns remain `flagged.suspicious` and are hidden by the suspicious filter.
- VirusTotal is telemetry only. It is included in the Codex workspace as signal,
  but VT alone must never hide, block, or set malicious/suspicious public status.
  The public Security audit UI may summarize vendor engine counts, including
  non-zero malicious or suspicious counts, but that display does not make VT a
  blocking verdict source.
- VirusTotal engine stats with zero malicious and zero suspicious detections and
  one or more undetected engines are resolved no-detections telemetry, not an
  in-progress scan. ClawHub should cache them as clean VT results instead of
  leaving public badges pending.
- All-active daily VirusTotal sweeps are disabled. Any future recurring VT
  freshness job must be bounded or delta-driven, and must not starve
  publish-triggered ClawScan jobs.
- Prompt-injection pre-scan hits are also context for Codex, not a deterministic
  post-Codex veto. The release worker must not downgrade a benign Codex verdict
  solely from regex telemetry.
- Artifacts remain visible while Codex runs unless another non-scanner moderation
  hold applies. Codex malicious verdicts block the candidate version. On updates,
  the previous clean/current public version remains live; on first versions,
  nothing public is promoted.
- `skillSearchDigest.publicVersion` is a derived public-browse cache, not a
  moderation source of truth. `available` points to the exact approved public
  `skillVersions` row and `unavailable` fails closed; a missing value exists only
  during rollout/backfill and uses the legacy resolver. Skill visibility changes
  and version scan-status changes must refresh the cache so hot browse/search
  queries never need to walk version history.
- Plugins under `@openclaw/*` owned by the OpenClaw publisher are trusted by
  default. They may still be audited, but scanner telemetry alone must not
  downgrade them.
- Operators can schedule ClawScan rescans through `securityScanJobs`: single
  skill/package rescans for a chosen artifact, or paged all-active-latest skill
  rescan batches. The old suspicious LLM bucket tools (`all`, `llm-only`,
  `vt-only`, `both`) are retired.
- Package/plugin scan backfills may recompute deterministic static scan results for older releases,
  but those results remain ClawScan context and are not public trust status.
- ClawPack package releases materialize parsed npm-pack artifact entries into the release file
  surface. Static scan, LLM review, package inspect/file APIs, and Codex package ClawScan use those
  stored artifact entries instead of metadata-only `package.json` / `openclaw.plugin.json` rows.
  VirusTotal still scans the exact uploaded `.tgz`; ClawHub also retains the stored ClawPack artifact
  so scanner workers can download/extract it for artifact-backed review.
- Packages cache VirusTotal undetected-only engine results as clean VT telemetry.
  ClawHub does not request or consume VirusTotal AI/code-insight results; VT is
  engine/vendor telemetry only.
- Skill moderation state stores a structured ClawScan moderation snapshot:
  - `moderationVerdict`: `clean | suspicious | malicious`
  - `moderationReasonCodes[]`: canonical machine-readable reasons
  - `moderationEvidence[]`: capped file/line evidence when ClawScan produces it
  - `moderationSummary`, engine version, evaluation timestamp, source version id
- Structured moderation is rebuilt from current signals instead of appending stale scanner codes.
- Legacy moderation flags remain in sync for existing public visibility and suspicious-skill filtering:
  - `flagged.review`: visible review guidance, not hidden by default.
  - `flagged.suspicious`: hidden by the suspicious filter.
  - `blocked.malware`: hidden/blocked malicious state.
- Operators can force-rebuild skill moderation from the latest version to clear stale aggregate rows
  after ClawScan policy changes. Conservative cleanup may soft-hide exact test/placeholder
  suspicious skills, but broad duplicate-looking families require separate human review.
- Static scan evidence must identify a concrete risky source/sink, not just adjacent primitives:
  - declared provider credentials and declared provider base URLs are not credential-harvest findings by themselves.
  - user-directed provider uploads are not exfiltration unless the source is broad/private/sensitive, automatic, or sent to an unrelated/hidden destination.
  - Basic Auth/base64 credential encoding and provider-response base64 decoding are normal integration behavior.
  - scoped uninstall cleanup under a skill-owned `.openclaw` path is not a destructive-delete finding unless it deletes a broad/protected path or hides impact.
  - Browser automation, stealth browsing, and anti-bot/crawling behavior are not classified by ClawHub's static scanner. SkillSpector owns that browser-automation analysis lane; ClawHub static rules should only preserve non-browser-specific concrete source/sink evidence.
- Static malware detection still records deterministic findings such as
  obfuscated shell payload prompts, but those findings are context for ClawScan,
  not a standalone hard block or uploader moderation trigger.

## Bans

- Banning a user:
  - hard-deletes all owned skills
  - soft-deletes all owned packages/plugins with a ban-specific reason marker
    and revokes package publish tokens
    - the first package batch may run before `users.deletedAt` is committed;
      later paginated package batches must match the current ban timestamp
    - packages already hidden by an earlier user ban are retimestamped to the
      current ban so the next matching unban can restore them
  - retimestamps already ban-hidden owned skills to the current ban marker so
    a later matching unban can restore them
  - revokes API tokens
  - sets `deletedAt` on the user
- Admins can manually unban (`deletedAt` + `banReason` cleared); revoked API tokens
  stay revoked and should be recreated by the user.
- The external appeals site may query ban context and accept account-ban appeals
  through the dedicated `CLAWHUB_BAN_APPEALS_TOKEN` service path. Accepted
  appeals record the Discord reviewer id in audit metadata; the token must not
  authorize any other moderation action. Accepted appeals must use the same
  matching-ban restore behavior as admin unbans for skills and packages/plugins
  and must only clear accounts with a current `user.ban`,
  `user.autoban.malware`, or `user.autoban.publisher_abuse` audit matching
  the ban timestamp.
  Package/plugin restore audit entries from this service path are actorless;
  reviewer provenance belongs on the `user.unban` service audit metadata, not
  on the restored user's package audit rows.
  Ban context lookup must tolerate duplicate Convex Auth account rows by
  selecting the currently banned user with matching ban audit evidence.
- Ban notification emails must be public-safe: include the high-level action
  reason, affected skill/plugin when known, the external appeals link, and
  scanner context when the account was escalated from repeated malicious
  artifacts. Artifact-level scanner emails must instead say the version was
  blocked, keep appeals out of the copy, and link existing CLI scan docs. Emails
  must not expose raw moderator notes, reporter identifiers, internal finding
  ids, or other staff-only ban reason text.
- Unban restore batches only restore packages/plugins hidden by the matching
  ban timestamp and must stop if the user has been banned again.
- Stale unban restore batches must stop if the user was banned again before a
  later page runs.
- Optional ban reason is stored in `users.banReason` and audit logs.
- Admins can reclassify an existing ban reason without unbanning or restoring
  content. This preserves the ban while removing users from remediation flows
  that key off a specific historical reason such as `malware auto-ban`.
- Moderators cannot ban admins; nobody can ban themselves.
- Report counters effectively reset because deleted/banned skills are no longer
  considered active in the per-user report cap.

## User account deletion

- User-initiated deletion is irreversible.
- Deletion flow:
  - sets `deactivatedAt` + `purgedAt`
  - revokes API tokens
  - clears profile/contact fields
  - clears telemetry
- Deleted accounts cannot be restored by logging in again.
- Published skills remain public.

## Upload gate (GitHub account age)

- Skill publish actions require GitHub account age ≥ 14 days.
- Lookup uses GitHub `created_at` fetched by the immutable GitHub numeric ID (`providerAccountId`)
  and caches on the user:
  - `githubCreatedAt` (source of truth)
- Gate applies to web uploads, CLI publish, and GitHub import.
- If GitHub responds `403` or `429`, publish fails with:
  - `GitHub API rate limit exceeded — please try again in a few minutes`
- To reduce rate-limit failures, configure the ClawHub GitHub App in Convex env:
  `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`.
  Account-age/profile lookups prefer short-lived GitHub App installation
  tokens, then fall back to `GITHUB_TOKEN`, then to unauthenticated public
  requests where safe. Trusted-publisher repository identity lookups also
  prefer authenticated GitHub App or token requests for public repository
  metadata, then retry without App auth when that lookup is rejected. They must
  only accept public repository responses; private repositories need a separate
  GitHub authorization or installation flow before ClawHub can configure trusted
  publishing for them.
- If configured GitHub API auth is rejected with `401`, retry the account-age
  lookup without auth before failing. Never fall back to mutable GitHub usernames
  for this gate; use the operator backfill to cache missing ages for existing users.

## Empty-skill cleanup (backfill)

- Cleanup uses quality heuristics plus trust tier to identify very thin/templated
  skills.
- Word counting is language-aware (`Intl.Segmenter` with fallback), reducing
  false positives for non-space-separated languages.
