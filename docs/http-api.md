---
summary: "HTTP API reference (public + CLI endpoints + auth)."
read_when:
  - Adding/changing endpoints
  - Debugging CLI ↔ registry requests
---

# HTTP API

Base URL: `https://clawhub.ai` (default).

All v1 paths are under `/api/v1/...`.
Legacy `/api/...` and `/api/cli/...` remain for compatibility (see `DEPRECATIONS.md`).
OpenAPI: `/api/v1/openapi.json`.

## Public catalog reuse

Third-party directories may use the public read endpoints to list or search ClawHub skills. Please cache results, honor `429`/`Retry-After`, link users back to the canonical ClawHub listing (`https://clawhub.ai/<owner>/skills/<slug>`), and avoid implying ClawHub endorsement of the third-party site. Do not attempt to mirror hidden, private, or moderation-blocked content outside the public API surface.

Web slug shortcuts resolve across registry families, but API clients should use
the canonical URLs returned by read endpoints instead of reconstructing route
precedence.

## Rate limits

Enforcement model:

- Anonymous requests: enforced per IP.
- Authenticated requests (valid Bearer token): enforced per user bucket.
- If token is missing/invalid, behavior falls back to IP enforcement.
- Authenticated write endpoints should not return a bare `Unauthorized` when
  the server knows the reason. Missing tokens, invalid/revoked tokens, and
  deleted/banned/disabled accounts should each get actionable text so CLI
  clients can tell users what blocked them.

- Read: 3000/min per IP, 12000/min per key
- Write: 300/min per IP, 3000/min per key
- Download: 1200/min per IP, 6000/min per key (download endpoints)

Headers:

- Legacy compatibility: `X-RateLimit-Limit`, `X-RateLimit-Reset`
- Standardized: `RateLimit-Limit`, `RateLimit-Reset`
- On `429`: `X-RateLimit-Remaining: 0` and `RateLimit-Remaining: 0`
- On `429`: `Retry-After`

Header semantics:

- `X-RateLimit-Reset`: absolute Unix epoch seconds
- `RateLimit-Reset`: seconds until reset (delay)
- `X-RateLimit-Remaining` / `RateLimit-Remaining`: exact remaining budget when present.
  Sharded successful requests omit this header instead of returning an approximate global value.
- `Retry-After`: seconds to wait before retry (delay) on `429`

Example `429` response:

```http
HTTP/2 429
content-type: text/plain; charset=utf-8
x-ratelimit-limit: 20
x-ratelimit-remaining: 0
x-ratelimit-reset: 1771404540
ratelimit-limit: 20
ratelimit-remaining: 0
ratelimit-reset: 34
retry-after: 34

Rate limit exceeded
```

Client guidance:

- If `Retry-After` exists, wait that many seconds before retry.
- Use jittered backoff to avoid synchronized retries.
- If `Retry-After` is missing, fallback to `RateLimit-Reset` (or compute from `X-RateLimit-Reset`).

IP source:

- Uses trusted client IP headers, including `cf-connecting-ip`, only when the
  deployment explicitly enables trusted forwarded headers.
- ClawHub uses trusted forwarding headers to identify client IPs at the edge.
- If no trusted client IP is available, anonymous requests use fallback buckets
  scoped only by rate-limit kind. These fallback buckets do not include
  caller-supplied paths, slugs, package names, versions, query strings, or other
  artifact parameters.

## Error responses

Public v1 error responses are plain text with `content-type: text/plain; charset=utf-8`.
This includes validation failures (`400`), missing public resources (`404`), auth and
permission failures (`401`/`403`), rate limits (`429`), and blocked downloads. Clients
should read the response body as a human-readable string. Unknown query parameters are
ignored for compatibility, but recognized query parameters with invalid values return
`400`.

## Public endpoints (no auth)

### `GET /api/v1/search`

Query params:

- `q` (required): query string
- `limit` (optional): integer
- `mode` (optional): `exact` for deterministic exact-slug matches
- `highlightedOnly` (optional): `true` to filter to highlighted skills
- `nonSuspiciousOnly` (optional): `true` to hide suspicious (`flagged.suspicious`) skills
- `nonSuspicious` (optional): legacy alias for `nonSuspiciousOnly`

Search modes:

- Omit `mode` for the default relevance-ranked skill search.
- `mode=exact` treats `q` as an exact skill slug and bypasses native semantic/vector recall.
- Invalid `mode` values return `400 Invalid search mode`.

Response:

```json
{
  "results": [
    {
      "score": 0.123,
      "slug": "gifgrep",
      "displayName": "GifGrep",
      "summary": "…",
      "version": "1.2.3",
      "updatedAt": 1730000000000,
      "ownerHandle": "openclaw",
      "owner": {
        "handle": "openclaw",
        "displayName": "OpenClaw",
        "image": "https://example.com/avatar.png"
      }
    }
  ]
}
```

Notes:

- Results are returned in relevance order (embedding similarity + exact slug/name token boosts + a small popularity prior).
- Relevance is stronger than popularity. A precise slug or display-name token match can outrank a looser match with much stronger engagement.
- ASCII text is tokenized on word and punctuation boundaries. For example, `personal-map` contains a standalone `map` token, while `amap-jsapi-skill` contains `amap`, `jsapi`, and `skill`; searching for `map` therefore gives `personal-map` a stronger lexical match than `amap-jsapi-skill`.
- Popularity is log-scaled and capped. High-engagement skills can rank lower when the query text is a weaker match.
- Suspicious or hidden moderation state can remove a skill from public search depending on caller filters and current moderation status.

Publisher discoverability guidance:

- Put the terms users will literally search for in the display name, summary, and tags. Use a standalone slug token only when it is also a stable identity you want to keep.
- Do not rename a slug just to chase one query unless the new slug is a better long-term canonical name. Old slugs become redirect aliases, but the canonical URL, displayed slug, and future search digests use the new slug.
- Rename aliases preserve resolution for old URLs and installs that resolve through the registry, but search ranking is based on the canonical skill metadata after the rename has indexed. Existing stats stay with the skill.
- If a skill is unexpectedly invisible, check moderation state first with `clawhub inspect @owner/slug` while logged in before changing ranking-related metadata.

### `GET /api/v1/skills`

Query params:

- `limit` (optional): integer (1–200)
- `cursor` (optional): pagination cursor for any non-`trending` sort
- `sort` (optional): `updated` (default), `recommended` (alias: `default`), `createdAt` (alias: `newest`), `downloads`, `stars` (alias: `rating`), `name`, legacy install aliases `installsCurrent`/`installs`/`installsAllTime` map to `downloads`, `trending`
- `prefix` (optional): literal skill-slug prefix; results use ascending slug order and require `sort=name` when `sort` is supplied
- `nonSuspiciousOnly` (optional): `true` to hide suspicious (`flagged.suspicious`) skills
- `nonSuspicious` (optional): legacy alias for `nonSuspiciousOnly`

Invalid `sort` values return `400`.

Notes:

- `recommended` uses engagement and recency signals.
- `trending` ranks by installs in the last 7 days (telemetry-based).
- `createdAt` is stable for new-skill crawls; `updated` changes when existing skills are republished.
- Prefix listing is complete across pages: keep following `nextCursor` until it is `null`.
- When `nonSuspiciousOnly=true`, cursor-based sorts may return fewer than `limit` items on a page because suspicious skills are filtered after page retrieval.
- Use `nextCursor` to continue pagination when present. A short page does not by itself mean end-of-results.

Response:

```json
{
  "items": [
    {
      "slug": "gifgrep",
      "displayName": "GifGrep",
      "summary": "…",
      "topics": ["Productivity"],
      "tags": { "latest": "1.2.3" },
      "stats": {},
      "createdAt": 0,
      "updatedAt": 0,
      "latestVersion": { "version": "1.2.3", "createdAt": 0, "changelog": "…" },
      "metadata": { "os": ["macos"], "systems": ["aarch64-darwin"] }
    }
  ],
  "nextCursor": null
}
```

### `GET /api/v1/skills/{slug}`

Response:

```json
{
  "skill": {
    "slug": "gifgrep",
    "displayName": "GifGrep",
    "summary": "…",
    "topics": ["Productivity"],
    "tags": { "latest": "1.2.3" },
    "stats": {},
    "createdAt": 0,
    "updatedAt": 0
  },
  "latestVersion": { "version": "1.2.3", "createdAt": 0, "changelog": "…" },
  "metadata": { "os": ["macos"], "systems": ["aarch64-darwin"] },
  "owner": { "handle": "steipete", "displayName": "Peter", "image": null },
  "moderation": {
    "isSuspicious": false,
    "isMalwareBlocked": false,
    "verdict": "clean",
    "reasonCodes": [],
    "summary": null,
    "engineVersion": "v2.0.0",
    "updatedAt": 0
  }
}
```

Notes:

- Old slugs created by owner rename/merge flows resolve to the canonical skill.
- `metadata.os`: OS restrictions declared in skill frontmatter (e.g. `["macos"]`, `["linux"]`). `null` if not declared.
- `metadata.systems`: Nix system targets (e.g. `["aarch64-darwin", "x86_64-linux"]`). `null` if not declared.
- `metadata` is `null` if the skill has no platform metadata.
- `moderation` is included only when the skill is flagged or the owner is viewing it.

### `GET /api/v1/skills/{slug}/moderation`

Returns structured moderation state.

Response:

```json
{
  "moderation": {
    "isSuspicious": true,
    "isMalwareBlocked": false,
    "verdict": "suspicious",
    "reasonCodes": ["suspicious.dynamic_code_execution"],
    "summary": "Detected: suspicious.dynamic_code_execution",
    "engineVersion": "v2.0.0",
    "updatedAt": 0,
    "legacyReason": null,
    "evidence": [
      {
        "code": "suspicious.dynamic_code_execution",
        "severity": "critical",
        "file": "index.ts",
        "line": 3,
        "message": "Dynamic code execution detected.",
        "evidence": ""
      }
    ]
  }
}
```

Notes:

- Owners and moderators can access moderation details for hidden skills.
- Public callers only get `200` for already-flagged visible skills.
- Evidence is redacted for public callers and only includes raw snippets for owners/moderators.

### `POST /api/v1/skills/{slug}/report`

Report a skill for moderator review. Reports are skill-level, optionally linked
to a version, and feed the skill report queue.

Auth:

- Requires an API token.

Request:

```json
{ "reason": "Suspicious install step", "version": "1.2.3" }
```

Response:

```json
{
  "ok": true,
  "reported": true,
  "alreadyReported": false,
  "reportId": "skillReports:...",
  "skillId": "skills:...",
  "reportCount": 1
}
```

### `GET /api/v1/skills/-/reports`

Moderator/admin endpoint for skill report intake.

Query params:

- `status` (optional): `open` (default), `confirmed`, `dismissed`, or `all`
- `limit` (optional): integer (1-200)
- `cursor` (optional): pagination cursor

Response:

```json
{
  "items": [
    {
      "reportId": "skillReports:...",
      "skillId": "skills:...",
      "skillVersionId": "skillVersions:...",
      "slug": "gifgrep",
      "displayName": "GifGrep",
      "version": "1.2.3",
      "reason": "Suspicious install step",
      "status": "open",
      "createdAt": 1730000000000,
      "reporter": {
        "userId": "users:...",
        "handle": "reporter",
        "displayName": "Reporter"
      },
      "triagedAt": null,
      "triagedBy": null,
      "triageNote": null
    }
  ],
  "nextCursor": null,
  "done": true
}
```

### `POST /api/v1/skills/-/reports/{reportId}/triage`

Moderator/admin endpoint for resolving or reopening skill reports.

Request:

```json
{ "status": "confirmed", "note": "Reviewed and hid affected version.", "finalAction": "hide" }
```

`note` is required for `confirmed` and `dismissed`; it may be omitted when
setting `status` back to `open`. Pass `finalAction: "hide"` with a triaged
report to hide the skill in the same auditable workflow.

### `GET /api/v1/skills/{slug}/versions`

Query params:

- `limit` (optional): integer
- `cursor` (optional): pagination cursor

### `GET /api/v1/skills/{slug}/versions/{version}`

Returns version metadata + files list.

- `version.security` includes normalized scan verification status and scanner details
  (VirusTotal + LLM), when available.

### `GET /api/v1/skills/{slug}/scan`

Returns security scan verification details for a skill version.

Query params:

- `version` (optional): specific version string.
- `tag` (optional): resolve a tagged version (for example `latest`).

Notes:

- If neither `version` nor `tag` is provided, uses the latest version.
- Includes normalized verification status plus scanner-specific details.
- `security.hasScanResult` is `true` only when a scanner produced a definitive verdict (`clean`, `suspicious`, or `malicious`).
- `moderation` is a current skill-level moderation snapshot derived from the latest version.
- When querying a historical version, check `moderation.matchesRequestedVersion` and `moderation.sourceVersion` before treating `moderation` and `security` as the same version context.

### `POST /api/v1/skills/-/scan`

Authenticated submit endpoint for new ClawScan jobs.

Local upload scans are no longer supported. Requests using
`multipart/form-data` or `{ "source": { "kind": "upload" } }` return `410`.

Published scans use JSON:

```json
{
  "source": { "kind": "published", "slug": "gifgrep", "version": "1.2.3" },
  "update": false
}
```

Notes:

- Scan request payloads and downloadable reports expire from the scan-request store after the retention window.
- Published scans require owner/publisher management access, or platform moderator/admin authority.
- Published scans write back only when `update: true` and the scan completes successfully.
- Response is `202` with `{ "ok": true, "scanId": "...", "jobId": "...", "status": "queued", "sourceKind": "published", "update": false, "queue": { "queuedAhead": 0, "queuedAheadIsEstimate": false, "position": 1, "running": 0, "runningIsEstimate": false, "note": "Scans are asynchronous and may take time to complete." } }`.
- Scan jobs are asynchronous. Manual scan requests are prioritized ahead of normal publish/backfill work, but completion still depends on worker availability.

### `GET /api/v1/skills/-/scan/{scanId}`

Authenticated poll endpoint for a submitted scan.

- Returns queued/running/succeeded/failed status.
- Returns `queue.queuedAhead` and `queue.position` while queued so clients can show how many prioritized manual scans are ahead of the request. Very large queues are bounded and reported with `queuedAheadIsEstimate: true`.
- When available, `report` contains `clawscan`, `skillspector`, `staticAnalysis`, and `virustotal` sections.
- Failed scan jobs return `status: "failed"` with `lastError`.

### `GET /api/v1/skills/-/scan/{scanId}/download`

Authenticated report archive endpoint.

- Requires a succeeded scan; non-terminal scans return `409`.
- Returns a ZIP with `manifest.json`, `clawscan.json`, `skillspector.json`, `static-analysis.json`, `virustotal.json`, and `README.md`.

### `GET /api/v1/skills/-/scan/download/{name}?version=<version>&kind=skill|plugin`

Authenticated stored report archive endpoint for submitted versions.

- Requires owner/publisher management access to the skill or plugin, or platform moderator/admin authority.
- Returns stored scan results for the exact submitted version, including blocked or hidden versions.
- `kind` defaults to `skill`; use `kind=plugin` for plugin/package scans.
- Returns the same ZIP shape as scan-request downloads.

### `POST /api/v1/skills/-/scan/batch`

Admin-only canonical batch rescan route. It accepts the same payload shape as legacy `POST /api/v1/skills/-/rescan-batch`.

### `POST /api/v1/skills/-/scan/batch/status`

Admin-only canonical batch status route. It accepts `{ "jobIds": ["..."] }` and returns the same aggregate counters as legacy `POST /api/v1/skills/-/rescan-batch/status`.

### `GET /api/v1/skills/{slug}/verify`

Returns the Skill Card verification envelope used by `clawhub skill verify`.

Query params:

- `ownerHandle` (optional): publisher handle for owner-qualified resolution. Use this when multiple publishers share the slug.
- `version` (optional): specific version string.
- `tag` (optional): resolve a tagged version (for example `latest`).

Notes:

- `ownerHandle` is normalized by trimming whitespace, removing leading `@` characters, and lowercasing.
- `ok` is `true` only when the selected version has a generated Skill Card, is not malware-blocked by moderation, and ClawScan verification is clean.
- Skill identity, publisher identity, and selected version metadata are top-level envelope fields (`slug`, `displayName`, `publisherHandle`, `version`, `resolvedFrom`, `tag`, `createdAt`) so shell automation can read them without unpacking nested wrappers.
- `security` is the top-level ClawScan/security verdict. Automation should key off `ok`, `decision`, `reasons`, and `security.status`.
- `security.signals` contains supporting scanner evidence such as `staticScan`, `virusTotal`, and `skillSpector`.
- `security.signals.dependencyRegistry` is retained for v1 response compatibility, but the dependency registry existence scanner is retired and this key is always `null`.
- `provenance` is `server-resolved-github-import` only when ClawHub resolved and stored a GitHub repo/ref/commit/path during publish or import; otherwise it is `unavailable`.

### `POST /api/v1/skills/-/security-verdicts`

Returns current compact security verdicts for exact skill versions. This
collection endpoint is intended for clients that already know which installed
ClawHub skill versions they need to display, such as OpenClaw Control UI.

Request:

```json
{
  "items": [
    { "slug": "gifgrep", "ownerHandle": "steipete", "version": "1.2.3" },
    { "slug": "gifgrep", "ownerHandle": "another-publisher", "version": "1.2.3" }
  ]
}
```

Notes:

- `ownerHandle` is optional. When present, it selects that publisher's skill before exact-version resolution; omitting it preserves legacy unqualified slug resolution.
- Owner handles are normalized by trimming whitespace, removing leading `@` characters, and lowercasing.
- `items` must contain 1-100 unique `{ ownerHandle?, slug, version }` combinations. The same slug and version may appear under different owners.
- Qualified success and failure items echo the normalized owner as `requestedOwnerHandle`; unqualified items omit that field.
- Results are per item; one missing skill, owner-qualified skill, or version does not fail the whole response.
- The response is security-only. It does not include Skill Card data, generated card status, artifact file lists, or detailed scanner payloads.
- Successful items include top-level `overview`, the canonical audit-page text composed from the ClawScan summary and guidance. Install clients may present this text without reconstructing it from scanner fields.
- `security.signals` contains status-level supporting evidence only; use `/scan` or the ClawHub security-audit page for full scanner details.
- `security.signals.dependencyRegistry` is retained for v1 response compatibility, but the dependency registry existence scanner is retired and this key is always `null`.
- Skill Card absence does not affect this endpoint's `ok`, `decision`, or `reasons`; clients should read installed `skill-card.md` locally when they need card content.
- Use `/verify` when you need the single-skill Skill Card verification envelope, `/card` when you need generated card markdown, and `/scan` when you need detailed scanner data.

Response:

```json
{
  "schema": "clawhub.skill.security-verdicts.v1",
  "items": [
    {
      "ok": true,
      "decision": "pass",
      "reasons": [],
      "requestedSlug": "gifgrep",
      "requestedOwnerHandle": "steipete",
      "slug": "gifgrep",
      "displayName": "GifGrep",
      "publisherHandle": "steipete",
      "publisherDisplayName": "Peter",
      "requestedVersion": "1.2.3",
      "version": "1.2.3",
      "createdAt": 0,
      "checkedAt": 0,
      "skillUrl": "https://clawhub.ai/steipete/skills/gifgrep",
      "securityAuditUrl": "https://clawhub.ai/steipete/skills/gifgrep/security-audit?version=1.2.3",
      "overview": "ClawScan found no material security concerns.\n\nUse least-privileged credentials when configuring this skill.",
      "security": {
        "status": "clean",
        "passed": true,
        "signals": {
          "staticScan": { "status": "clean", "reasonCodes": [] },
          "virusTotal": null,
          "skillSpector": null,
          "dependencyRegistry": null
        }
      }
    },
    {
      "ok": false,
      "decision": "fail",
      "reasons": ["version.not_found"],
      "requestedSlug": "missing-version",
      "requestedOwnerHandle": "another-publisher",
      "requestedVersion": "1.0.0",
      "error": { "code": "version_not_found", "message": "Version not found" },
      "security": null
    }
  ]
}
```

### `GET /api/v1/skills/{slug}/file`

Returns exact stored file bytes as a download. Add `preview=1` to request a bounded escaped-text
preview; any file with valid UTF-8 bytes can be previewed, regardless of its extension or MIME
metadata.

Query params:

- `path` (required)
- `version` (optional)
- `tag` (optional)
- `preview=1` (optional; returns `text/plain` or `415` when the bytes are not valid UTF-8)

Notes:

- Defaults to latest version.
- Raw download limit: 10MB.
- Text preview limit: 200KB.

### `GET /api/v1/packages`

Unified catalog endpoint for:

- skills
- code plugins
- bundle plugins

Query params:

- `limit` (optional): integer (1–100)
- `cursor` (optional): pagination cursor
- `family` (optional): `skill`, `code-plugin`, or `bundle-plugin`
- `channel` (optional): `official`, `community`, or `private`
- `isOfficial` (optional): `true` or `false`
- `sort` (optional): `updated` (default), `recommended`, `trending`, `downloads`, legacy alias `installs`
- `category` (optional): plugin category filter. Supported only when the
  request is scoped to plugin packages (`/api/v1/plugins`,
  `/api/v1/code-plugins`, `/api/v1/bundle-plugins`, or package endpoints with
  `family=code-plugin`/`family=bundle-plugin`). Controlled categories and
  legacy v1 filter aliases are documented under `GET /api/v1/plugins`.

Notes:

- Invalid values for `family`, `channel`, `isOfficial`, `featured`,
  `highlightedOnly`, or `sort` return `400`. Unknown query parameters are ignored.
- `GET /api/v1/code-plugins` and `GET /api/v1/bundle-plugins` remain fixed-family aliases.
- Skill entries stay backed by the skill registry and can still be published only through `POST /api/v1/skills`.
- `POST /api/v1/packages` is still only for code-plugin and bundle-plugin releases.
- Anonymous callers only see public package channels.
- Authenticated callers can see private packages for publishers they belong to in list/search results.
- `channel=private` only returns packages the authenticated caller can read.

### `GET /api/v1/packages/search`

Unified catalog search across skills + plugin packages.

Query params:

- `q` (required): query string
- `limit` (optional): integer (1–100)
- `family` (optional): `skill`, `code-plugin`, or `bundle-plugin`
- `channel` (optional): `official`, `community`, or `private`
- `isOfficial` (optional): `true` or `false`
- `category` (optional): plugin category filter. Supported only when the
  request is scoped to plugin packages. Controlled categories and legacy v1
  filter aliases are documented under `GET /api/v1/plugins`.

Notes:

- Invalid values for `family`, `channel`, `isOfficial`, `featured`, or
  `highlightedOnly` return `400`. Unknown query parameters are ignored.
- Anonymous callers only see public package channels.
- Authenticated callers can search private packages for publishers they belong to.
- `channel=private` only returns packages the authenticated caller can read.

### `GET /api/v1/plugins`

Plugin-only catalog browse across code-plugin and bundle-plugin packages.

Query params:

- `limit` (optional): integer (1-100)
- `cursor` (optional): pagination cursor
- `isOfficial` (optional): `true` or `false`
- `sort` (optional): `recommended` (default), `trending`, `downloads`, `updated`, legacy alias `installs`
- `category` (optional): plugin category filter. Current values:
  `channels`, `models`, `memory`, `context`, `voice`, `media`, `web`,
  `tools`, `runtime`, `gateway`, `security`, `other`.

Legacy v1 filter aliases remain accepted on read endpoints:

- `mcp-tooling`, `data`, and `automation` resolve to `tools`.
- `observability` and `deployment` resolve to `gateway`.
- `dev-tools` resolves to `runtime`.

`trending` is a seven-day install/download leaderboard and does not use all-time totals.
On the unified `/api/v1/packages` endpoint it is plugin-only; use
`/api/v1/skills?sort=trending` for the skill catalog.

Legacy aliases are not accepted as stored or author-declared category values.

### `GET /api/v1/plugins/categories`

Returns the canonical plugin discovery taxonomy in display order. Each category
contains `slug`, `label`, `description`, a bare Lucide `icon` key, and numeric
`order`.

### `GET /api/v1/skills/export`

Bulk export of latest public skills for offline analysis.

Auth:

- API token required.

Query params:

- `startDate` (required): Unix milliseconds lower bound for skill `updatedAt`.
- `endDate` (required): Unix milliseconds upper bound for skill `updatedAt`.
- `limit` (optional): integer (1-250), default `250`.
- `cursor` (optional): pagination cursor from the previous response.

Response:

- Body: ZIP archive.
- Each exported skill is rooted at `{publisher}/{slug}/`.
- Hosted skills include the latest stored version files and are listed in
  `_manifest.json` with `sourceRef: "public-clawhub"`.
- Current GitHub-backed skills with a `clean` or `suspicious` scan include
  `_source_handoff.json` with `sourceRef: "public-github"`, repo, commit, path,
  content hash, and archive URL. They do not include ClawHub-hosted source files.
- Each skill includes `_export_skill_meta.json`.
- Archive entry paths are limited to 900 bytes in their signed JSON encoding;
  files beyond that limit are reported in `_errors.json`.
- `_manifest.json` is always included at the ZIP root.
- `_errors.json` is included when individual skills or files could not be
  exported before the archive manifest is sealed. `X-Export-Errors` reports
  those same pre-stream errors.
- Once streaming starts, every hosted file is bound to the signed archive
  manifest by path, size, and SHA-256. If a signed file disappears or fails an
  integrity check, the stream terminates and the client must discard the
  partial ZIP and retry; the proxy never emits a completed archive whose
  `_manifest.json` or `X-Export-Errors` misstates its contents.

Headers:

- `X-Next-Cursor`
- `X-Has-More`
- `X-Total-Returned`
- `X-Date-Range`
- `X-Export-Errors`

### `GET /api/v1/plugins/export`

Bulk export of latest public plugin releases for offline analysis.

Auth:

- API token required.

Query params:

- `startDate` (required): Unix milliseconds lower bound for plugin `updatedAt`.
- `endDate` (required): Unix milliseconds upper bound for plugin `updatedAt`.
- `limit` (optional): integer (1-250), default `250`.
- `cursor` (optional): pagination cursor from the previous response.
- `family` (optional): `code-plugin` or `bundle-plugin`. Omitted means both
  plugin families.

Response:

- Body: ZIP archive.
- Each exported plugin is rooted at `{family}/{packageName}/`.
- Each exported plugin includes the latest release's stored files.
- Per-plugin export metadata is stored at
  `__clawhub_export/{family}/{packageName}/plugin_meta.json`.
- `_manifest.json` is always included at the ZIP root.
- `_errors.json` is included when individual plugins or files could not be
  exported.

Headers:

- `X-Next-Cursor`
- `X-Has-More`
- `X-Total-Returned`
- `X-Date-Range`
- `X-Export-Errors`

### `GET /api/v1/plugins/search`

Plugin-only search across code-plugin and bundle-plugin packages.

Query params:

- `q` (required): query string
- `limit` (optional): integer (1-100)
- `isOfficial` (optional): `true` or `false`
- `category` (optional): plugin category filter. Current values:
  `channels`, `models`, `memory`, `context`, `voice`, `media`, `web`,
  `tools`, `runtime`, `gateway`, `security`, `other`.

Notes:

- The legacy v1 filter aliases documented under `GET /api/v1/plugins` are also
  accepted.
- Category filtering is a real API filter backed by plugin category digest
  rows, not a search-query rewrite.
- Results are returned in relevance order and do not currently paginate.
- Browser UI sort controls for plugin search reorder the loaded relevance results,
  matching the current `/skills` browse behavior.

### `GET /api/v1/packages/{name}`

Returns package detail metadata.

Notes:

- Skills can also resolve through this route in the unified catalog.
- Private packages return `404` unless the caller can read the owning publisher.

### `DELETE /api/v1/packages/{name}`

Soft-deletes a package and all releases.

Notes:

- Requires an API token for the package owner, an org publisher owner/admin,
  platform moderator, or platform admin.

### `GET /api/v1/packages/{name}/versions`

Returns version history.

Query params:

- `limit` (optional): integer (1–100)
- `cursor` (optional): pagination cursor

Notes:

- Private packages return `404` unless the caller can read the owning publisher.

### `GET /api/v1/packages/{name}/versions/{version}`

Returns one package version, including file metadata, compatibility,
verification, artifact metadata, and scan data.

Notes:

- `version.artifact.kind` is `legacy-zip` for old-world package archives or
  `npm-pack` for ClawPack-backed releases.
- ClawPack releases include npm-compatible `npmIntegrity`, `npmShasum`, and
  `npmTarballName` fields.
- `version.sha256hash` is deprecated compatibility metadata for old clients. It
  hashes the exact ZIP bytes returned by `/api/v1/packages/{name}/download`.
  Modern clients should use `version.artifact.sha256`, which identifies the
  canonical release artifact.
- `version.vtAnalysis`, `version.llmAnalysis`, and `version.staticScan` are
  included when scan data exists.
- Private packages return `404` unless the caller can read the owning publisher.

### `GET /api/v1/packages/{name}/versions/{version}/security`

Returns the exact package release security and trust summary for install
clients. This is the public OpenClaw consumption surface for deciding whether a
resolved release can be installed.

Auth:

- Public read endpoint. No owner, publisher, moderator, or admin token is
  required.

Response:

```json
{
  "overview": "ClawScan found no material security concerns.\n\nUse least-privileged credentials when configuring this plugin.",
  "securityAuditUrl": "https://clawhub.ai/openclaw/plugins/example-plugin/security-audit?version=1.2.3",
  "package": {
    "name": "@openclaw/example-plugin",
    "displayName": "Example Plugin",
    "family": "code-plugin"
  },
  "release": {
    "releaseId": "packageReleases:...",
    "version": "1.2.3",
    "artifactKind": "npm-pack",
    "artifactSha256": "0123456789abcdef...",
    "npmIntegrity": "sha512-...",
    "npmShasum": "0123456789abcdef0123456789abcdef01234567",
    "npmTarballName": "example-plugin-1.2.3.tgz",
    "createdAt": 1730000000000
  },
  "trust": {
    "scanStatus": "malicious",
    "moderationState": "quarantined",
    "blockedFromDownload": true,
    "reasons": ["manual:quarantined", "scan:malicious"],
    "pending": false,
    "stale": false
  }
}
```

Response fields:

- `overview` is the canonical summary-and-guidance text shown by the package
  security-audit page. Install clients may present it without reconstructing
  audit text from scanner fields.
- `securityAuditUrl` links to the exact release's package security-audit page.
- `package.name`, `package.displayName`, and `package.family` identify the
  resolved registry package.
- `release.releaseId`, `release.version`, and `release.createdAt` identify the
  exact release that was evaluated.
- `release.artifactKind`, `release.artifactSha256`, `release.npmIntegrity`,
  `release.npmShasum`, and `release.npmTarballName` are present when known for
  the release artifact.
- `trust.scanStatus` is the effective trust status derived from scanner inputs
  and manual release moderation.
- `trust.moderationState` is nullable. It is `null` when no manual release
  moderation exists.
- `trust.blockedFromDownload` is the install block signal. OpenClaw and other
  install clients should block installation when this value is `true` instead of
  re-deriving blocking rules from scanner or moderation fields.
- `trust.reasons` is the user-facing and audit explanation list. Reason codes
  are stable, compact strings such as `manual:quarantined`, `scan:malicious`,
  and `package:malicious`.
- `trust.pending` means one or more trust inputs are still awaiting completion.
- `trust.stale` means the trust summary was computed from outdated inputs and
  should be treated as requiring refresh before a high-confidence allow decision.

Notes:

- This endpoint is version-exact. Clients should call it after resolving the
  package version they intend to install, not just after reading the latest
  package metadata.
- Private packages return `404` unless the caller can read the owning publisher.
- This endpoint is intentionally narrower than owner/moderator moderation
  endpoints. It exposes the install decision and public explanation, not
  reporter identities, report bodies, private evidence, or internal review
  timelines.

### `GET /api/v1/packages/{name}/versions/{version}/artifact`

Returns the explicit artifact resolver metadata for a package version.

Notes:

- Legacy package versions return a `legacy-zip` artifact and a legacy ZIP
  `downloadUrl`.
- ClawPack versions return an `npm-pack` artifact, npm integrity fields, a
  `tarballUrl`, and the legacy ZIP compatibility URL.
- This is the OpenClaw resolver surface; it avoids guessing archive format from
  a shared URL.

### `GET /api/v1/packages/{name}/versions/{version}/artifact/download`

Downloads the version artifact through the explicit resolver path.

Notes:

- ClawPack versions stream the exact uploaded npm-pack `.tgz` bytes.
- Legacy ZIP versions redirect to `/api/v1/packages/{name}/download?version=`.
- Uses the download rate bucket.

### `GET /api/v1/packages/{name}/readiness`

Returns computed readiness for future OpenClaw consumption.

Readiness checks cover:

- official channel status
- latest version availability
- ClawPack npm-pack artifact availability
- artifact digest
- source repo and commit provenance
- OpenClaw compatibility metadata
- host targets
- scan state

Response:

```json
{
  "package": {
    "name": "@openclaw/example-plugin",
    "displayName": "Example Plugin",
    "family": "code-plugin",
    "isOfficial": true,
    "latestVersion": "1.2.3"
  },
  "ready": false,
  "checks": [
    {
      "id": "clawpack",
      "label": "ClawPack artifact",
      "status": "fail",
      "message": "Latest version is legacy ZIP-only."
    }
  ],
  "blockers": ["clawpack"]
}
```

### `GET /api/v1/packages/migrations`

Moderator endpoint for listing official OpenClaw plugin migration rows.

Auth:

- Requires an API token for a moderator or admin user.

Query params:

- `phase` (optional): `planned`, `published`, `clawpack-ready`,
  `legacy-zip-only`, `metadata-ready`, `blocked`, `ready-for-openclaw`, or
  `all` (default).
- `limit` (optional): integer (1-100)
- `cursor` (optional): pagination cursor

Response:

```json
{
  "items": [
    {
      "migrationId": "officialPluginMigrations:...",
      "bundledPluginId": "core.search",
      "packageName": "@openclaw/search-plugin",
      "packageId": "packages:...",
      "owner": "platform",
      "sourceRepo": "openclaw/openclaw",
      "sourcePath": "plugins/search",
      "sourceCommit": "abc123",
      "phase": "blocked",
      "blockers": ["missing ClawPack"],
      "hostTargetsComplete": true,
      "scanClean": false,
      "moderationApproved": false,
      "runtimeBundlesReady": false,
      "notes": null,
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000
    }
  ],
  "nextCursor": null,
  "done": true
}
```

### `POST /api/v1/packages/migrations`

Admin endpoint for creating or updating an official plugin migration row.

Auth:

- Requires an API token for an admin user.

Request body:

```json
{
  "bundledPluginId": "core.search",
  "packageName": "@openclaw/search-plugin",
  "owner": "platform",
  "sourceRepo": "openclaw/openclaw",
  "sourcePath": "plugins/search",
  "sourceCommit": "abc123",
  "phase": "blocked",
  "blockers": ["missing ClawPack"],
  "hostTargetsComplete": true,
  "scanClean": false,
  "moderationApproved": false,
  "runtimeBundlesReady": false,
  "notes": "waiting on publisher upload"
}
```

Notes:

- `bundledPluginId` is normalized to lowercase and is the stable upsert key.
- `packageName` is npm-name normalized; the package can be missing for planned
  migrations.
- This tracks migration readiness only. It does not mutate OpenClaw or generate
  ClawPacks.

### `GET /api/v1/packages/moderation/queue`

Moderator/admin endpoint for package release review queues.

Auth:

- Requires an API token for a moderator or admin user.

Query params:

- `status` (optional): `open` (default), `blocked`, `manual`, or `all`
- `limit` (optional): integer (1-100)
- `cursor` (optional): pagination cursor

Status meanings:

- `open`: suspicious, malicious, pending, quarantined, revoked, or reported releases.
- `blocked`: quarantined, revoked, or malicious releases.
- `manual`: any release with a manual moderation override.
- `all`: any release with a manual override, non-clean scan state, or package report.

Response:

```json
{
  "items": [
    {
      "packageId": "packages:...",
      "releaseId": "packageReleases:...",
      "name": "@openclaw/example-plugin",
      "displayName": "Example Plugin",
      "family": "code-plugin",
      "channel": "community",
      "isOfficial": false,
      "version": "1.2.3",
      "createdAt": 1730000000000,
      "artifactKind": "npm-pack",
      "scanStatus": "malicious",
      "moderationState": "quarantined",
      "moderationReason": "manual review",
      "sourceRepo": "openclaw/example-plugin",
      "sourceCommit": "abc123",
      "reportCount": 2,
      "lastReportedAt": 1730000001000,
      "reasons": ["manual:quarantined", "scan:malicious", "reports:2"]
    }
  ],
  "nextCursor": null,
  "done": true
}
```

### `POST /api/v1/packages/{name}/report`

Report a package for moderator review. Reports are package-level, optionally
linked to a version. They feed the moderation queue but do not auto-hide or
block downloads by themselves; moderators should use release moderation to
approve, quarantine, or revoke artifacts.

Auth:

- Requires an API token.

Request:

```json
{ "reason": "Suspicious native binary", "version": "1.2.3" }
```

Response:

```json
{
  "ok": true,
  "reported": true,
  "alreadyReported": false,
  "packageId": "packages:...",
  "releaseId": "packageReleases:...",
  "reportCount": 1
}
```

### `GET /api/v1/packages/reports`

Moderator/admin endpoint for package report intake.

Auth:

- Requires an API token for a moderator or admin user.

Query params:

- `status` (optional): `open` (default), `confirmed`, `dismissed`, or `all`
- `limit` (optional): integer (1-100)
- `cursor` (optional): pagination cursor

Response:

```json
{
  "items": [
    {
      "reportId": "packageReports:...",
      "packageId": "packages:...",
      "releaseId": "packageReleases:...",
      "name": "@openclaw/example-plugin",
      "displayName": "Example Plugin",
      "family": "code-plugin",
      "version": "1.2.3",
      "reason": "Suspicious native binary",
      "status": "open",
      "createdAt": 1730000000000,
      "reporter": {
        "userId": "users:...",
        "handle": "reporter",
        "displayName": "Reporter"
      },
      "triagedAt": null,
      "triagedBy": null,
      "triageNote": null
    }
  ],
  "nextCursor": null,
  "done": true
}
```

### `GET /api/v1/packages/{name}/moderation`

Owner/moderator endpoint for package moderation visibility.

Auth:

- Requires an API token for the package owner, publisher member, moderator, or
  admin user.

Response:

```json
{
  "package": {
    "packageId": "packages:...",
    "name": "@openclaw/example-plugin",
    "displayName": "Example Plugin",
    "family": "code-plugin",
    "channel": "community",
    "isOfficial": false,
    "reportCount": 2,
    "lastReportedAt": 1730000001000,
    "scanStatus": "malicious"
  },
  "latestRelease": {
    "releaseId": "packageReleases:...",
    "version": "1.2.3",
    "artifactKind": "npm-pack",
    "scanStatus": "malicious",
    "moderationState": "quarantined",
    "moderationReason": "manual review",
    "blockedFromDownload": true,
    "reasons": ["manual:quarantined", "scan:malicious", "reports:2"],
    "createdAt": 1730000000000
  }
}
```

### `POST /api/v1/packages/reports/{reportId}/triage`

Moderator/admin endpoint for resolving or reopening package reports.

Request:

```json
{
  "status": "confirmed",
  "note": "Reviewed and quarantined affected release.",
  "finalAction": "quarantine"
}
```

`note` is required for `confirmed` and `dismissed`; it may be omitted when
setting `status` back to `open`. Pass `finalAction: "quarantine"` or
`finalAction: "revoke"` with a confirmed report to apply release moderation in the
same auditable workflow.

Response:

```json
{
  "ok": true,
  "reportId": "packageReports:...",
  "packageId": "packages:...",
  "status": "confirmed",
  "reportCount": 0
}
```

### `POST /api/v1/packages/{name}/versions/{version}/moderation`

Moderator/admin endpoint for package release review.

Request:

```json
{ "state": "quarantined", "reason": "Suspicious native payload." }
```

Supported states:

- `approved`: manually reviewed and allowed.
- `quarantined`: blocked pending follow-up.
- `revoked`: blocked after a release was previously trusted.

Quarantined and revoked releases return `403` from artifact download routes.
Every change writes an audit log entry.

### `GET /api/v1/packages/{name}/file`

Returns exact stored package file bytes as a download. Add `preview=1` to request the same bounded
UTF-8 text preview used for skill files.

Query params:

- `path` (required)
- `version` (optional)
- `tag` (optional)
- `preview=1` (optional; returns `text/plain` or `415` when the bytes are not valid UTF-8)

Notes:

- Defaults to the latest release.
- Uses the read rate bucket, not the download bucket.
- Raw download limit: 10MB.
- Text preview limit: 200KB; opaque files return `415` only for preview requests.
- Pending VirusTotal scans do not block reads; malicious releases may still be withheld elsewhere.
- Private packages return `404` unless the caller can read the owning publisher.

### `GET /api/v1/packages/{name}/download`

Downloads the legacy deterministic ZIP archive for a package release.

Query params:

- `version` (optional)
- `tag` (optional)

Notes:

- Defaults to the latest release.
- Skills redirect to `GET /api/v1/download`.
- Plugin/package archives are zip files with a `package/` root so old OpenClaw
  clients keep working.
- This route stays ZIP-only. It does not stream ClawPack `.tgz` files.
- Responses include `ETag`, `Digest`, `X-ClawHub-Artifact-Type`, and
  `X-ClawHub-Artifact-Sha256` headers for resolver integrity checks.
- Registry-only metadata is not injected into the downloaded archive.
- Pending VirusTotal scans do not block downloads; malicious releases return `403`.
- Private packages return `404` unless the caller is the owner.

### `GET /api/npm/{package}`

Returns an npm-compatible packument for ClawPack-backed package versions.

Notes:

- Only versions with uploaded ClawPack npm-pack tarballs are listed.
- Legacy ZIP-only versions are intentionally omitted.
- `dist.tarball`, `dist.integrity`, and `dist.shasum` use npm-compatible
  fields so users can point npm at the mirror if they choose.
- Scoped package packuments support both `/api/npm/@scope/name` and npm's
  encoded `/api/npm/@scope%2Fname` request path.

### `GET /api/npm/{package}/-/{tarball}.tgz`

Streams the exact uploaded ClawPack tarball bytes for npm mirror clients.

Notes:

- Uses the download rate bucket.
- Download headers include ClawHub SHA-256 plus npm integrity/shasum metadata.
- Moderation and private package access checks still apply.

### `GET /api/v1/resolve`

Used by the CLI to map a local fingerprint to a known version.

Query params:

- `slug` (required)
- `hash` (required): 64-char hex sha256 of the bundle fingerprint

Response:

```json
{ "slug": "gifgrep", "match": { "version": "1.2.2" }, "latestVersion": { "version": "1.2.3" } }
```

### `GET /api/v1/download`

Downloads a hosted skill version ZIP, or returns a GitHub source handoff for a
current GitHub-backed skill with a `clean` or `suspicious` scan and no hosted
version.

Query params:

- `slug` (required)
- `version` (optional): semver string
- `tag` (optional): tag name (e.g. `latest`)

Notes:

- If neither `version` nor `tag` is provided, the latest version is used.
- Soft-deleted versions return `410`.
- Hosted skill versions return a streamed deterministic ZIP with
  `Content-Disposition: attachment; filename="<slug>-<version>.zip"`. ClawHub
  applies moderation, rate limiting, and download metering before streaming.
- GitHub-backed skill handoffs do not proxy or mirror bytes. The JSON response
  includes `sourceRef: "public-github"`, `repo`, `commit`, `path`, `contentHash`,
  and `archiveUrl`; scan/current state is a gate and is not included as success
  payload metadata.
- Download stats are counted as unique identities per UTC day (`userId` when API token is valid, otherwise IP).

## Auth endpoints (Bearer token)

All endpoints require:

```
Authorization: Bearer clh_...
```

### `GET /api/v1/whoami`

Validates token and returns the user handle.

### `POST /api/v1/skills`

Publishes a new version.

- Preferred: `multipart/form-data` with `payload` JSON + `files[]` blobs.
- JSON body with `files` (storageId-based) is also accepted.
- Optional payload field: `ownerHandle`. When present, the API resolves that
  publisher server-side and requires the actor to have publisher access.
- Optional payload field: `migrateOwner`. When `true` with `ownerHandle`, an
  existing skill may move to that owner if the actor is an admin/owner on both
  the current and target publishers. Without this opt-in, owner changes are
  rejected.

### `POST /api/v1/packages`

Publishes a code-plugin or bundle-plugin release.

- Requires Bearer token auth.
- Requires `multipart/form-data`.
- Allowed form fields are `payload`, repeated `files` blobs, or one `clawpack`
  tarball reference. `clawpack` may be a `.tgz` blob or a storage id returned by
  the upload-url flow. Staged storage-id publishes must also include the
  `clawpackUploadTicket` returned with that upload URL.
- Use either `files` or `clawpack`, never both in the same request.
- JSON bodies and caller-supplied `payload.files` / `payload.artifact`
  metadata are rejected.
- Direct multipart publish requests are capped at 4MB because the public API is
  served through Vercel functions, which reject larger request bodies with
  `413` before ClawHub sees them. Larger ClawPack tarballs must use the
  upload-url flow, up to the 120MB tarball cap.
- Optional payload field: `ownerHandle`. The actor must have publish access to the selected publisher.

Validation highlights:

- `family` must be `code-plugin` or `bundle-plugin`.
- Plugin packages require `openclaw.plugin.json`. ClawPack `.tgz` uploads must
  contain it at `package/openclaw.plugin.json`.
- Code plugins require `package.json`, source repo metadata, source commit
  metadata, config schema metadata, `openclaw.compat.pluginApi`, and
  `openclaw.build.openclawVersion`.
- `openclaw.hostTargets` and `openclaw.environment` are optional metadata.
- Only the `openclaw` org publisher and current `openclaw` org members'
  personal publishers may publish to the `official` channel.
- On-behalf publishes still validate official-channel eligibility against the target owner account.

### `POST /api/v1/publish/attempts/{id}/recover`

Recover a failed staged OpenClaw plugin release with a normal user Bearer token
and current package publish access. The only accepted JSON field is:

```json
{ "manualOverrideReason": "Retry the retained artifacts after workflow failure" }
```

The reason must contain 1–500 characters after trimming. A new successor returns
`202`; an exact authorized replay returns `200` and its existing outcome.
Responses contain `ok`, `attemptId`, `recoveredFromAttemptId`, `packageId`,
`releaseId`, `name`, `version`, `status`, `publicationStatus`, and `reused`.
Follow the successor with `GET /api/v1/publish/attempts/{id}` using the same user
token. Pending is not published; fresh security checks and current authorization
must pass before the retained release becomes public.

Invalid bodies return `400`, invalid credentials `401`, undisclosed or missing
attempts `404`, and conflicting or ineligible recovery state `409`.

### `DELETE /api/v1/skills/{slug}` / `POST /api/v1/skills/{slug}/undelete`

Soft-delete / restore a skill (owner, moderator, or admin).

Optional JSON body:

```json
{ "reason": "Held for moderation pending legal review." }
```

When present, `reason` is stored as the skill moderation note and copied into the audit log.
Owner-initiated soft deletes reserve the slug for 30 days, then the slug can be claimed by
another publisher. The delete response includes `slugReservedUntil` when this expiry applies.
Moderator/admin hides and security removals do not expire this way.

Delete response:

```json
{ "ok": true, "slugReservedUntil": 1730000000000 }
```

Status codes:

- `200`: ok
- `401`: unauthorized
- `403`: forbidden
- `404`: skill/user not found
- `500`: internal server error

### `POST /api/v1/users/publisher`

Admin-only. Ensures an org publisher exists for a handle. If the handle still points at a
legacy shared user/personal publisher, the endpoint migrates it into an org publisher first.
For a newly-created org, provide `memberHandle`; the acting admin is not added as a member.
`memberRole` defaults to `owner`.

- Body: `{ "handle": "openclaw", "displayName": "OpenClaw", "memberHandle": "alice", "memberRole": "owner", "trusted": true }`
- Response: `{ "ok": true, "publisherId": "...", "handle": "openclaw", "created": true, "migrated": false, "trusted": true, "member": { "userId": "...", "handle": "alice", "role": "owner" } }`

### `POST /api/v1/publishers`

Authenticated self-serve org publisher creation. Creates a new org publisher and adds the
caller as owner. This endpoint does not migrate existing user/personal handles and does
not mark the publisher trusted/official.

- Body: `{ "handle": "opik", "displayName": "Opik" }`
- Response: `{ "ok": true, "publisherId": "...", "handle": "opik", "created": true, "trusted": false }`
- Returns `409` when the handle is already used by a publisher, user, or personal publisher.

### `POST /api/v1/users/reserve`

Admin-only. Reserves root slugs and package names for a rightful owner without publishing a
release. Package names become private placeholder packages with no release rows, so the same
owner can later publish the real code-plugin or bundle-plugin release into that name.

- Body: `{ "handle": "openclaw", "slugs": ["diffs"], "packageNames": ["@openclaw/diffs"], "reason": "reserved for official OpenClaw plugin" }`
- Response: `{ "ok": true, "succeeded": 2, "failed": 0, "results": [{ "kind": "slug", "name": "diffs", "ok": true, "action": "reserved" }] }`

### `POST /api/v1/users/publisher-recovery`

Admin-only. Recovers a personal publisher for a verified replacement GitHub OAuth principal
without editing Convex Auth account rows. The request must name both immutable GitHub
provider account ids; mutable handles are only used as an operator-facing guard.

The endpoint defaults to dry-run. Applying recovery requires `dryRun: false` and
`confirmIdentityVerified: true` after staff independently verify continuity between both
GitHub principals. Recovery fails closed when the destination user's current personal
publisher has skills, packages, or GitHub skill sources.
Recovery also migrates legacy `ownerUserId` fields for the recovered publisher's skills,
skill slug aliases, packages, package inspector warnings, and derived search digest rows so
direct-owner paths agree with the new publisher authority. An active protected-handle
reservation for the recovered handle is also reassigned to the replacement user so later
profile synchronization cannot restore the former user's competing authority. Each primary table is bounded to
100 rows per apply transaction; larger recoveries must first use a resumable owner migration.
GitHub skill sources are publisher-scoped and reported as checked rather than rewritten.

- Body: `{ "handle": "gingiris", "nextUserHandle": "gingiris-1031", "previousGitHubProviderAccountId": "123", "nextGitHubProviderAccountId": "456", "reason": "Verified account continuity for issue #2555", "confirmIdentityVerified": true, "dryRun": false }`
- Response: `{ "ok": true, "dryRun": false, "recovered": true, "publisherId": "...", "handle": "gingiris", "previousUser": { "userId": "...", "handle": "gingiris", "nextHandle": "gingiris-recovered", "githubProviderAccountId": "123", "authAccountCount": 1 }, "nextUser": { "userId": "...", "handle": "gingiris-1031", "nextHandle": "gingiris", "githubProviderAccountId": "456", "authAccountCount": 1 }, "retiredPersonalPublisher": null, "resourceOwnerMigration": { "limitPerTable": 100, "skills": 1, "skillSlugAliases": 1, "packages": 0, "packageInspectorWarnings": 0, "githubSourcesChecked": 1, "handleReservations": 1 }, "identityVerified": true, "reason": "Verified account continuity for issue #2555" }`

### Owner slug management endpoints

- `POST /api/v1/skills/{slug}/rename`
  - Body: `{ "newSlug": "new-canonical-slug" }`
  - Response: `{ "ok": true, "slug": "new-canonical-slug", "previousSlug": "old-slug" }`
- `POST /api/v1/skills/{slug}/merge`
  - Body: `{ "targetSlug": "canonical-target-slug" }`
  - Response: `{ "ok": true, "sourceSlug": "old-slug", "targetSlug": "canonical-target-slug" }`

Notes:

- Both endpoints require API token auth and only work for the skill owner.
- `rename` preserves the previous slug as a redirect alias.
- `merge` hides the source listing and redirects the source slug to the target listing.

### Transfer ownership endpoints

- `POST /api/v1/skills/{slug}/transfer`
  - Body: `{ "toUserHandle": "target_handle", "message": "optional" }`
  - Response: `{ "ok": true, "transferId": "skillOwnershipTransfers:...", "toUserHandle": "target_handle", "expiresAt": 1730000000000 }`
- `POST /api/v1/skills/{slug}/transfer/accept`
- `POST /api/v1/skills/{slug}/transfer/reject`
- `POST /api/v1/skills/{slug}/transfer/cancel`
  - Response (accept/reject/cancel): `{ "ok": true, "skillSlug": "demo-skill?" }`
- `GET /api/v1/transfers/incoming`
- `GET /api/v1/transfers/outgoing`
  - Response shape: `{ "transfers": [{ "_id": "...", "skill": { "slug": "demo", "displayName": "Demo" }, "fromUser"|"toUser": { "handle": "..." }, "message": "...", "requestedAt": 0, "expiresAt": 0 }] }`

### `POST /api/v1/users/ban`

Ban a user and hard-delete owned skills (moderator/admin only).

Body:

```json
{ "handle": "user_handle", "reason": "optional ban reason" }
```

or

```json
{ "userId": "users_...", "reason": "optional ban reason" }
```

Response:

```json
{ "ok": true, "alreadyBanned": false, "deletedSkills": 3 }
```

### `POST /api/v1/users/unban`

Unban a user and restore eligible skills (admin only).

Body:

```json
{ "handle": "user_handle", "reason": "optional unban reason" }
```

or

```json
{ "userId": "users_...", "reason": "optional unban reason" }
```

Response:

```json
{ "ok": true, "alreadyUnbanned": false, "restoredSkills": 3 }
```

### `POST /api/v1/users/reclassify-ban`

Change the stored reason for an existing ban without unbanning or restoring
content (admin only). Defaults to dry-run unless `dryRun` is `false`.

Body:

```json
{ "handle": "user_handle", "reason": "bulk publishing spam", "dryRun": true }
```

or

```json
{ "userId": "users_...", "reason": "bulk publishing spam", "dryRun": false }
```

Response:

```json
{
  "ok": true,
  "dryRun": false,
  "userId": "users_...",
  "handle": "user_handle",
  "previousReason": "malware auto-ban",
  "nextReason": "bulk publishing spam",
  "changed": true
}
```

### `POST /api/v1/users/role`

Change a user role (admin only).

Body:

```json
{ "handle": "user_handle", "role": "moderator" }
```

or

```json
{ "userId": "users_...", "role": "admin" }
```

Response:

```json
{ "ok": true, "role": "moderator" }
```

### `GET /api/v1/users`

List or search users (admin only).

Query params:

- `q` (optional): search query
- `query` (optional): alias for `q`
- `limit` (optional): max results (default 20, max 200)

Response:

```json
{
  "items": [
    {
      "userId": "users_...",
      "handle": "user_handle",
      "displayName": "User",
      "name": "User",
      "role": "moderator"
    }
  ],
  "total": 1
}
```

### `POST /api/v1/stars/{slug}` / `DELETE /api/v1/stars/{slug}`

Add/remove a Bookmark. The legacy `stars` route and response field names remain
for compatibility. Both endpoints are idempotent.

Responses:

```json
{ "ok": true, "starred": true, "alreadyStarred": false }
```

```json
{ "ok": true, "unstarred": true, "alreadyUnstarred": false }
```

## Legacy CLI endpoints (deprecated)

Still supported for older CLI versions:

- `GET /api/cli/whoami`
- `POST /api/cli/upload-url`
- `POST /api/cli/publish`
- `POST /api/cli/telemetry/install` — also used by the current CLI for install events.
- `POST /api/cli/skill/delete`
- `POST /api/cli/skill/undelete`

See `DEPRECATIONS.md` for removal plan.

`POST /api/cli/upload-url` returns `uploadUrl` and `uploadTicket`. Package
publishes that stage a ClawPack tarball must send the resulting storage id as
`clawpack` and the returned ticket as `clawpackUploadTicket`. GitHub Actions
publishes use separate upload- and publish-scoped credentials; the server
accepts the ticket only when both credentials belong to the same authorization
transaction.

## Registry discovery (`/.well-known/clawhub.json`)

The CLI can discover registry/auth settings from the site:

- `/.well-known/clawhub.json` (JSON, preferred)
- `/.well-known/clawdhub.json` (legacy)

Schema:

```json
{ "apiBase": "https://clawhub.ai", "authBase": "https://clawhub.ai", "minCliVersion": "0.0.5" }
```

If you self-host, serve this file (or set `CLAWHUB_REGISTRY` explicitly; legacy `CLAWDHUB_REGISTRY`).
