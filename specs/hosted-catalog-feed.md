---
summary: "ClawHub publication contract for the stable OpenClaw hosted plugin, skill, and promotions feeds."
read_when:
  - Publishing an OpenClaw hosted feed
  - Changing feed entries, cache headers, or publication workflow
  - Wiring registry.openclaw.ai to ClawHub
---

# Hosted Feeds

ClawHub is the canonical producer for the initial OpenClaw plugin and skill
feeds and the runtime promotions feed. The feeds
are projections of existing public package, release, skill, and promotion
records; they are not second catalogs.

## Contract

- Feed id: `clawhub-official`
- Schema version: `1`
- Initial scope: `code-plugin` and `bundle-plugin` packages plus official skills
- Source profiles: `public-clawhub` for ClawHub-hosted artifacts and
  `public-github` for source-backed skills available through the public feed
- Entry identity: normalized ClawHub package name
- Install coordinate: package name plus exact release version
- Integrity: `sha256:<artifact sha256>`
- Publisher trust: `official`, derived from ClawHub's official publisher state
- Initial entry state: `available`
- Required feed metadata: `generatedAt`, monotonic `sequence`, and `expiresAt`

`schemaVersion` is a cross-repo wire contract with the OpenClaw hosted feed
consumer. Do not bump it until matching OpenClaw parser and validation support
has shipped, or current clients will reject the hosted feed and fall back to
bundled data.
Any pull request changing `CATALOG_FEED_SCHEMA_VERSION` must carry the
`schema-version-approved` label, added only after explicit approval confirms
that the matching OpenClaw parser and validation work is coordinated. A new
commit that changes the schema version automatically removes the label so the
current revision must be approved again.

The producer excludes soft-deleted packages, inactive releases, releases without
an artifact digest, and releases blocked by ClawHub security or moderation
state. The feed contains no registry URLs, credentials, source tokens, or
bootstrap trust keys.

The feed emits RFC 19's canonical entry shape. OpenClaw's hosted-feed adapter
also accepts optional `entry.openclaw` metadata. The strict schema in this
repository is a private workspace package used by the producer, not a published
ClawHub client SDK; the ClawHub CLI does not consume these feeds. Changes still
need compatibility checks against the OpenClaw reader before publication.

### Provider setup and model previews

Eligible code-plugin entries may include `openclaw.plugin`, `openclaw.providers`,
and `openclaw.modelCatalog.providers`. They are projections of the selected
release's immutable `openclaw.plugin.json`, not another hand-maintained provider
registry. The release runtime id must match the manifest id, and only provider
ids declared by that manifest are eligible. Bundle plugins and packages without
usable provider declarations keep their ordinary install entry.

Provider metadata carries declared environment variable **names**, explicit auth
choices, and their bounded labels, grouping, CLI hints, onboarding scopes, and
manual app-setup presentation. It never contains environment values, credentials,
executable discovery flags such as `appGuidedDiscovery`, or runtime settings.
The manifest's install coordinates are not copied: the outer `install.candidates`
entry remains the sole exact package/version/artifact-digest binding. Discovery
does not install or execute the plugin.

Model previews carry only `id`, `name`, `input` (`text`, `image`, or `document`),
`reasoning`, `contextWindow`, `maxTokens`, and a `defaultModel` present in that
preview. They are a display subset for pre-install discovery, not a complete
model catalog or an instruction to populate runtime model configuration. API
types, endpoints, headers, costs, compatibility flags, utility defaults, and
runtime status are excluded. Full model behavior remains owned by the installed
plugin and OpenClaw's existing model catalog.

Each plugin projects at most 32 providers and 16 auth choices per provider.
Provider and choice ids are deduplicated and sorted before applying those caps;
declared environment-variable priority is preserved. The complete `openclaw`
metadata for an entry is capped at 64 KiB of UTF-8 JSON. Setup metadata is admitted
first, skipping whole providers or auth choices that do not fit without changing
retained fields; model previews use only the remaining budget. Each provider preview has
at most 64 models, and all model previews for an entry together fit in 16 KiB of
UTF-8 JSON. Models are selected deterministically with the declared default
first, then model id; providers without room for a model are omitted from the
preview, not from setup discovery. Ordinary strings are at most 256 characters,
URL display fields are credential-free HTTPS URLs of at most 2048 characters,
including after canonical URL encoding, and string lists contain at most 16 items.

The indexed eligibility query passes a private manifest storage reference with
the exact release's runtime id, file size, and SHA-256 to the publication action.
The action reads files sequentially within the existing 10 MiB published-file
limit, verifies size and digest, and parses the original JSON before projection.
Missing files, digest/size mismatches, or invalid JSON fail publication visibly
and leave the previous snapshot intact. Storage ids are never published.

The extracted metadata is intentionally not a fallback: its depth truncation and
object-key rewriting can lose or misattribute model declarations. The exact
manifest also remains available through the existing version-pinned package-file
route with its stored file hash; the catalog does not duplicate that full blob.

The skills feed uses the same envelope and `/v1/feeds/skills` route. It emits
`type: "skill"` entries with `@<publisher>/<slug>` ids and ClawHub install
coordinates. It includes only skills with an active latest published version,
non-empty files, a SHA-256 integrity hash, and an active official publisher
record. Both verified organization and personal publishers are included;
unverified publishers are excluded.

GitHub-backed skills are emitted only when the current upstream content is
available through the public feed gate: `installKind: "github"`,
`githubCurrentStatus: "present"`, `githubScanStatus: "clean"` or
`"suspicious"`, no upstream removal marker, complete repo/path/commit/content
hash fields, and a live GitHub source row owned by the same official publisher.
These entries use a `public-github` candidate with the commit as `version`,
`sha256:<githubCurrentContentHash>` as integrity, and an additive `github`
object containing immutable `repo`, `path`, `commit`, and `contentHash`.
Suspicious GitHub-backed entries follow the same public feed visibility pattern
as suspicious hosted packages and skills.
Pending, failed, malicious, missing, removed, hidden, soft-deleted, or
incomplete GitHub-backed skills are not emitted.
Until the skills feed has pagination or sharding, it publishes at most 1000
eligible entries per snapshot so a large skills corpus does not block the plugin
feed publication path.

The experimental Claws feed is deliberately not an additive entry type in this
stable v1 contract. Its separately gated parser, serializer, and route are
specified in [Experimental Claw Feed](experimental-claw-feed.md).

The promotions feed uses id `clawhub-promotions`, schema version `1`, and the
`/v1/feeds/promotions` route. Entries are declarative promotion records, not
commands or executable content. They may identify providers, auth choices,
plugins, models, and HTTPS signup/docs/launch URLs. Only promotions with
`status: "active"` whose launch window has started are published. The active
set is capped at 50 records by the promotions write path, which also bounds each
snapshot. Public slug lookups keep ended promotions readable only when they
actually crossed their launch boundary; promotions canceled before launch stay
private permanently, even if their scheduled window or other fields are edited.
Expired drafts cannot be activated, and unlaunched active promotions cannot be
rescheduled wholly into an expired window. Model references and aliases are
single-line fields so management form serialization remains lossless.

The write path also enforces the OpenClaw consumer's authoring grammars so a
promotion can never publish in a shape clients reject or silently degrade on:
model refs, provider, and auth choice id are restricted to shell-safe
identifier characters because the CLI echoes them into copy-paste commands
and refuses anything else; aliases must be typed identifiers (letters,
digits, `._:-`, no spaces) because the CLI skips aliases it cannot register;
plugin names use the package registry's canonical npm-safe grammar (scoped
`@scope/name` allowed); and when a provider is declared, every model ref must
start with `<provider>/`, matching the CLI's refusal to configure models
outside the promotion's declared provider.

## Publication

`convex/catalogFeed.ts` builds the package, skill, and gated Claws feeds from
indexed package/skill queries and stores one current publication row per feed
in `catalogFeedPublications`.
Keeping one row per feed avoids an unbounded publication log while preserving
the sequence and exact payload needed for validators. Before writing a plugin,
skill, or experimental Claw publication, the publisher rejects payloads larger
than 900 KiB, leaving room for metadata inside Convex's 1 MiB document limit.
An oversized snapshot fails visibly and leaves the previous publication intact;
it is never partially written or silently stripped of install candidates.

The `Publish Hosted Catalog Feed` workflow refreshes the snapshot every six
hours and can be run manually. It requires the existing `Production` environment
`CONVEX_DEPLOY_KEY`. The workflow currently publishes an unsigned feed; signed
envelopes require a separate production key-management decision and must not be
advertised to OpenClaw clients until the signing key and trust root are deployed.

`convex/promotionsFeed.ts` builds the promotions snapshot from the bounded active
set and stores it in the same publication table. Production backend deploys
publish an initial snapshot before contract verification. Promotion updates and
status changes schedule an immediate refresh. Active promotions also schedule
refreshes at `startsAt` and at `endsAt + 1ms`: both window endpoints are
inclusive, so the expiry refresh must run after the final active millisecond. A
six-hour cron is the backstop for long-running or empty feeds, keeping every
snapshot inside its 24-hour `expiresAt` horizon.

## Edge delivery

The stable HTTP endpoints are `/api/v1/feeds/plugins`, `/api/v1/feeds/skills`,
and `/api/v1/feeds/promotions`. Each enabled endpoint
returns its stored bytes unchanged and provides:

- `ETag: "sha256:<payload hash>"`
- `Last-Modified`
- `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=86400`
- `Surrogate-Control: max-age=300, stale-while-revalidate=86400`
- `304 Not Modified` for matching `If-None-Match` or `If-Modified-Since`

Nitro exposes `/v1/feeds/plugins`, `/v1/feeds/skills`, and
`/v1/feeds/promotions` through the same environment-aware Convex proxy used for
`/api/*`. Their unversioned `/feeds/*` paths permanently redirect to the
versioned paths. The `registry.openclaw.ai` custom domain must point at the same
Vercel project before the public RFC URLs are enabled.

The serialized payload uses stable object-key ordering and deterministic entry
and install-candidate ordering. Additive fields may be introduced within a
major version; incompatible wire changes require a new versioned route and
schema version.

`/.well-known/openclaw-registry.json` advertises the plugin and skill feeds.
`/.well-known/clawhub.json` remains the ClawHub API discovery document.

Do not make the feed request-time dynamic. Refresh the stored publication first,
then let Vercel or the configured CDN cache the immutable response by ETag.
