# Changelog

## Unreleased

### Changes

- Web: organization publishers can upload durable PNG, JPEG, or WebP logos from settings instead of relying on hotlinked image URLs.
- Web/API: make default skill and plugin discovery freshness-aware, add seven-day trending views for both catalogs, and use verified status plus usage as search tie-breakers within direct matches.

### Fixes

- CLI/API: recover failed staged plugin publications from their retained artifacts with `clawhub package recover`, fresh security checks, current publisher authorization, and preserved attempt history.
- Tests: keep the Vitest localStorage shim working on Node 26, whose native `Storage` global has a non-configurable `length`, so `bun run ci:unit` passes on Node 24 and 26.
- API/GitHub Actions: authorize human release recovery through v2 approval and the original child-bound parent receipt, fail automated attempts when their exact parent fails, and let admins preview or discard orphaned package publish attempts with a publisher-visible reason.
- CI: warm and cache the npm packages for local Convex "use node" dependencies and raise the isolated backend's push transport timeout so local-auth browser lanes no longer race a 408-retried external-deps build into a deleted build directory.
- CI: make the UI proof process-tree reaping test exercise KILL escalation deterministically and assert the reaper's signal sequence, so a TERM that lands before the grandchild ignores it can no longer mask a missing KILL.
- CI: run the pinned Agent Skills CLI from the Bun lockfile without runtime npm access, retain subprocess failure output, and run first-party CLI coverage before third-party compatibility checks.
- Docs: repair plugin validation remediation links to the published manifest metadata and runtime session helper sections while preserving valid CLI workflow anchors.
- Dependencies: pin fast-uri to 3.1.6 to fix host confusion and server-side request forgery advisories in URI normalization.
- GitHub Actions: accept complete release inventories in parent authorization receipts up to the backend's 64 KiB limit while retaining 8 KiB identity and recovery limits.
- API: preserve inspector findings when workspace cleanup fails, report the failing stage, and keep cleanup failures publication-blocking.
- API: bound runtime-identity checks to the owning publisher, reject collisions during personal-principal recovery, and prevent malicious-release quarantine from restoring a historical runtime identity that was administratively replaced.
- Browser tests: use a supported manifest warning fixture and prepare local Convex fully with short scratch paths on the backend's volume before starting authenticated flows.
- API: scope code-plugin runtime identity claims to the owning publisher so community and official packages can retain their manifest ids under distinct scoped names, while rejecting same-owner collisions during publication, transfer, restore, and administrative repair.
- UI proof: supervise isolated loopback backend and browser proof together without writing project dotenv, preserving diagnostics and private-state cleanup on failure.
- CI: authenticate weekly design-audit pull request mutations with the Barnacle GitHub App while retaining the workflow token for branch publication and clean-audit closure.
- API: record skipped and failed skill evaluation outcomes without passing worker tokens to internal mutations.
- GitHub Actions/CLI/API: require v2 authorization for every OpenClaw OIDC publish, bind large-artifact upload tickets and package mutations to the exact authorization transaction, consume scoped capabilities with non-public staging, then require an immutable successful parent attempt and atomic durable authorization revalidation before final publication.
- GitHub Actions: revalidate versioned trusted tooling workflow identity immediately before package publication, including exact protected lightweight tags, so approval waits cannot authorize moved tooling.
- CI: authenticate the scheduled project-skill updater's pull request mutations with the Barnacle GitHub App while retaining the workflow token for provenance lookup and branch publication.
- Workers: materialize zero-byte directory markers without colliding with descendant files, while retaining real empty files and verifying every downloaded artifact digest.
- Deploy: allow an explicitly confirmed backend-only deploy to pause and reliably restore active external-skill rollouts instead of requiring a manual dashboard toggle.
- GitHub Actions/CLI: trigger exact pre-publication checks immediately and wait for package publication to finish, so a pending staged upload no longer reports a successful release.
- API: keep publish-time Plugin Inspector target preparation inside its disposable workspace when hosted runtimes expose an unusable home directory.
- API: keep older code-plugin and Claw backports from replacing the highest-semver `latest` release while preserving custom distribution tags.
- Integrations: truncate publisher-controlled Discord webhook titles to the platform's 256-character embed limit.
- Security: recover scheduled temporal publisher-abuse scans from strict Convex payload validation failures without leaving zombie running runs (thanks @jesse-merhi).
- CI: retry transient Convex preview provisioning failures under fresh deployment names during Vercel preview builds.
- Web: keep CLI device login codes out of the GitHub OAuth code handler — the device page no longer loses its prefilled code, bounces through a surprise GitHub redirect, or drops an active session; device links now use `user_code`.
- API: keep successful rate-limit checks available when retention metadata writes contend, while preserving fail-closed enforcement for authoritative counter conflicts.
- CLI: accept npm 12's package-keyed `npm pack --json` output when building ClawPacks while retaining compatibility with earlier npm array output.
- Web/API: preserve JSON, SSR, and OG responses through the Convex proxy after the H3 response-wrapper update.

## 0.23.3 - 2026-08-03

### Fixes

- CLI/API: stage skill files directly in Convex storage before publishing metadata, so bundles within the documented 50MB total limit no longer hit Vercel's smaller request-body limit.

## 0.23.2 - 2026-08-03

### Changes

- CLI/API: add owner-authorized `clawhub skill tag <skill> <version> --yes` so personal owners and organization owner/admin members can safely repoint `latest` to an existing public version.

### Fixes

- API: reject version-bearing requests on the legacy whole-skill delete route instead of silently soft-deleting the entire skill.

## 0.23.1 - 2026-06-29

### Changes

- CLI: update Plugin Inspector to `0.3.17` so `clawhub package validate` reports deprecated session SDK reads, writes, file helpers, and transcript helpers with remediation links.

## 0.23.0 - 2026-06-23

### Changes

- CLI: restore `clawhub sync` for scanning local skill folders and publishing new or changed skills in batches, including dry-run, JSON, owner, version-bump, provenance, and non-interactive `--all` options.

## 0.22.0 - 2026-06-15

### Changes

- CLI: remove the `clawhub sync` command. `clawhub skill publish <path>` now skips unchanged content, defaults new skills to `1.0.0`, defaults changed skills to the next patch version, and supports dry-run/JSON output.
- GitHub Actions: preserve catalog publishing through the reusable `skill-publish.yml` workflow, which invokes ordinary `skill publish` once per skill folder.

## 0.21.0 - 2026-06-11

### Changes

- CLI/API: add public `clawhub package trusted-publisher set` and `clawhub package trusted-publisher delete` commands so package managers can configure or remove GitHub Actions OIDC trusted publishing for existing packages.

## 0.20.2 - 2026-06-11

### Changes

- CLI packages now require Node.js 22 or newer, dropping the EOL Node 20 runtime floor.
- CLI: add `clawhub package validate <source>` for local plugin validation with author-facing Plugin Inspector findings, remediation text, and report artifacts.

## 0.20.0 - 2026-06-06

### Changes

- CLI/API: replace local `clawhub scan` uploads with stored submitted-version scan report downloads, including owner-authorized `clawhub scan download <name> --version <version>` support for blocked skill and plugin submissions.

## 0.19.2 - 2026-06-05

### Fixes

- CLI: accept the legacy `clawhub skill verify --json` flag as a hidden compatibility no-op while continuing to print JSON by default.

## 0.19.1 - 2026-06-05

### Fixes

- CLI: install source-backed GitHub skills from the deployed `/api/v1/skills/:slug/install` resolver so `clawhub install` works for skills without hosted ClawHub versions.

## 0.19.0 - 2026-06-03

### Changes

- CLI/API: add authenticated `clawhub scan` submit/poll support for ephemeral local skill bundles and owner-authorized published skill scans, including JSON output and report ZIP downloads (#2479).

### Fixes

- Auth/Ops: keep GitHub account-age lookups on immutable numeric IDs, retry without auth when a configured GitHub token is rejected, and add an operator backfill for missing cached account ages.
- API/CLI: report Skill Card verification with flattened skill/version metadata, ClawScan verdict fields at `security.*`, and supporting scanner evidence under `security.signals`.

## 0.18.0 - 2026-05-25

### Changes

- CLI/API: add Skill Card verification surfaces, including `clawhub skill verify <slug>` JSON output and `--card` Markdown retrieval (#2382).

### Fixes

- API: fix `GET /api/v1/skills` pagination so `cursor` advances to the next page instead of repeating the first page for supported non-trending sorts (#2275) (thanks @vyctorbrzezowski, @enerj).
- Web: block collaborative membership on personal publishers while allowing the linked owner to clean up stale extra membership rows (thanks @vyctorbrzezowski).
- Security/API: hide owned package/plugin catalog entries, revoke package publish tokens, and restore only matching ban-hidden packages on user unban (thanks @vyctorbrzezowski).
- API: block public raw skill files when moderation already blocks downloads and reject skill tags that point at another skill's version (thanks @vyctorbrzezowski).
- Web: stop stale unban restore batches from reactivating skills after the owner is banned again or deactivated (thanks @vyctorbrzezowski).
- Security/API: reject direct skill owner transfers when the skill is hidden, suspicious, or malicious (thanks @vyctorbrzezowski).
- Security/API: revalidate package publish actor, owner, and owner publisher active state in the final release insert (thanks @vyctorbrzezowski).

## 0.17.0 - 2026-05-19

- CLI/API: add self-serve org publisher creation with `clawhub publisher create <handle>` and scoped package publish errors that point to the command.

## 0.16.0 - 2026-05-18

### Fixes

- CLI/API: make package publishes robust under parallel same-publisher release jobs by avoiding unnecessary shared publisher writes, retrying transient Convex contention, and labeling contention separately from package validation failures (#2291).
- Security: move upload ClawScan classification to a GitHub Actions Codex worker, treat VirusTotal as telemetry-only signal, and trust verified `@openclaw/*` plugin packages by default.
- Security: cancel pending skill ownership transfers before rejecting accept attempts when the requester is inactive or the skill is hidden, removed, or malicious (#2276, #2277) (thanks @vyctorbrzezowski).
- API/CLI: fix package delete returning 500 for packages with capability tags when no capability search digest row existed yet (#2212) (thanks @momothemage).
- API: return a clear 400 for `/api/v1/packages/search` without a non-empty `q` instead of treating `search` as a package name (thanks @vyctorbrzezowski).
- Web/API: keep search results limited to items with match evidence, preserve trust and popularity as tie-breakers, and show `N+` counts without exact count queries (#2206) (thanks @vyctorbrzezowski).
- Web: preserve `ownerHandle` through legacy skill publish redirects so org admins land in the correct new-version owner context (#2177).
- Settings: save display name/bio changes even when a legacy personal publisher handle conflict prevents publisher profile sync (#1199).
- Auth: show a visible error if the GitHub sign-in request fails before the provider redirect starts (#2197).
- Schema: include `.tsv`, `.conf`, `.properties`, and `.dat` in the exported text-file allowlist and regenerate the committed schema package runtime (#2172, #874) (thanks @alexuser).
- API: return `400` for invalid known public package filters and invalid skill list sort values, while continuing to ignore unknown query parameters (#2184).
- API/docs: document v1 plain-text error responses and expose owner metadata in the OpenAPI search result schema (#2187) (thanks @vyctorbrzezowski).
- Web: rank publisher card preview items by downloads instead of recent publish order (thanks @vyctorbrzezowski).
- Web: remove the desktop Files tab height cap and make mobile truncation explicit (thanks @vyctorbrzezowski).
- Web: keep skill/plugin detail tabs at mobile-friendly touch target height.

### Changes

- CLI/API: include skill owner handles in search results so duplicate/common slugs are easier to disambiguate (thanks @vyctorbrzezowski).
- Web: let skill publishers pick a curated lucide icon for cards and listings (#2174) (thanks @momothemage).
- Web/API: add keyword-based plugin categories plus API-backed plugin search sorting for recently updated, newest, and name (#2118) (thanks @vyctorbrzezowski).
- Web: polish the starred skills page with grid/list controls, sorting, and optimistic unstar behavior (#2159) (thanks @vyctorbrzezowski).
- API/docs: expand the v1 OpenAPI contract with package/plugin catalog endpoints and align documented rate limits with the server constants (#2186) (thanks @vyctorbrzezowski).
- Admin/Ops: audit profile syncs, self-service account/profile changes, personal publisher syncs, and org trusted-publisher changes so slug and ownership investigations have a complete ledger.
- Dependencies: update production `@clack/prompts`, `tailwind-merge`, and `yaml` dependencies (#2198).

## 0.15.0 - 2026-05-12

### Changes

- Web: polish dashboard artifact cards, loading skeletons, skill summary/detail layout, and adoption metrics after the 0.14 release (#2150, #2153, #2156, #2157, #2158, #2160).
- Docs/dev: clarify pre-PR validation gates for local contributors (#2161).

### Fixes

- Web: show plugin settings actions to package managers and preserve manager access in dashboard rows (#2163, #2168).
- Web: refresh skill star state after mutations and keep skill tabs from causing horizontal scroll (#2154, #2155).
- Web: show owner names when handles are hidden, and clarify editable skill summary settings copy (#2151, #2162).
- Dashboard: add a publisher switcher so org-owned skills and plugins are visible to org admins after transfer or publish (#2132).
- Web: let org publishers/admins republish transferred org-owned skills without the publish form treating the existing slug as taken, including legacy users with synthesized personal publishers (#2171).
- CLI: send skill ownership command payloads as JSON objects so rename/merge operations reach the API correctly (#1300).
- CLI: keep an install fingerprint in skill origin metadata so `clawhub update <skill>` does not report fresh installs as local changes when the server cannot resolve the current hash (#169).
- CLI: migrate cached `registry.clawhub.ai` registries back to `clawhub.ai` so `clawhub explore` no longer talks to the retired Vercel deployment (#1098).
- CLI: publish `.tsv`, `.conf`, `.properties`, `.dat`, and safe extensionless text files while excluding dotfiles and sampling extensionless files before full reads (#874).
- Tests: remove obsolete rescan e2e probes that no longer match current moderation behavior (#2152).

## 0.14.0 - 2026-05-11

### Changes

- Dev: auto-start services for Codex worktrees and add a local dev persona FAB (#2146, #2147).
- Dev: add a local ClawScan dry-run helper script (#2143).

### Fixes

- API: return deterministic 403 responses for skill/package rescan and package transfer permission denials, with CI e2e coverage for protected write endpoints.

## 0.13.0 - 2026-05-11

### Changes

- Web: redesign Settings into focused account, organization, API token, and account deletion views with responsive desktop and mobile layouts (#2134) (thanks @vyctorbrzezowski).
- Web: replace the Users directory with a Publishers discovery surface covering builders and organizations, add `/publishers` as the canonical route, and keep `/users` compatibility (#2087) (thanks @vyctorbrzezowski).
- Web: polish browse/listing surfaces across skills, plugins, and search, including plugin card view parity, clearer search controls, visible safety filtering, and more consistent card metadata treatment (#2084) (thanks @vyctorbrzezowski).
- Web: allow skill owners and publisher admins to edit a skill summary from the detail page (#1411) (thanks @SylvanXiao).
- CLI/Auth: add device-code login for remote or headless shells, backed by ClawHub device authorization endpoints (#1867) (thanks @LumenFromTheFuture).
- CLI: add per-skill pinning so installed skills can be frozen against direct updates, bulk updates, and force reinstalls (#1806) (thanks @deepujain).
- Web: rename the skills and plugins browse alternate view from Cards to Grid while keeping legacy `view=cards` URLs compatible (#2119) (thanks @vyctorbrzezowski).
- Dev docs: refresh generated Convex AI guidance files (#2000).

### Fixes

- Moderation: stop treating VirusTotal Code Insight/Palm verdicts as a hide authority for skills; real AV-engine hits and ClawScan findings still contribute moderation verdicts.
- Moderation: stop treating static suspicious-only findings as a verdict; keep file/line evidence for review while VT/LLM decide public suspicious status.
- ClawScan: reduce false positives for scoped uninstall cleanup, declared provider login flows, Basic Auth/base64 handling, and user-directed provider uploads while hard-blocking stealth browser abuse patterns.
- ClawScan: lower false positives by treating purpose-aligned notes as benign unless structured LLM findings contain a material concern, and add targeted rescan batches for suspicious skills/plugins.
- Moderation: split visible ClawScan review guidance from hidden suspicious filtering, and add operator cleanup for stale aggregate rows and obvious test/placeholder suspicious skills.
- Security: add an admin-only moderation hold lift path for false-positive publisher holds, with audited skill restoration that preserves independently hidden skills (#1133) (thanks @Justincredible-tech).
- Moderation: let platform moderators and admins trigger skill/package security rescans for any owner from the CLI, without consuming the owner recovery cap.
- ClawScan: include package `openclaw.environment` env/config declarations in package review prompts so declared plugin runtime requirements are not reported as missing (#2013).
- Skills/Packages: let publisher admins manage owned lifecycle operations consistently, including skill rename/delete/restore, direct skill moves into org publishers they administer, package restore from the CLI/API, and direct moves back to their personal publisher.
- Skills: repair publisher-owned skill merges, bound historical slug redirects, block protected slug namespaces, and expire owner-unpublished slug reservations after 30 days (#2115) (thanks @fuller-stack-dev).
- Skills: allow confirmed owner migration when republishing an existing skill to another publisher, preserving versions, stats, aliases, and audit history (#1998, #2102) (thanks @momothemage).
- Security: block owner delete/undelete paths from overriding moderator or scanner hides, and return explicit 403 authz responses for owner restore denials (#2078) (thanks @momothemage).
- CLI/API: send skill transfer payloads as JSON objects so transfer requests reach the API correctly.
- Packages: keep package search digests schema-safe during delete/restore so package lifecycle CLI calls do not fail after provenance updates.
- Search: recall skill matches by non-first slug/display-name tokens while keeping multi-token queries on the direct recall path constrained to all query tokens (#2140) (thanks @momothemage).
- Search/Web: disclose when `/search` is hiding suspicious skills and add an explicit opt-out so unified search no longer silently differs from `/skills` for the same query (#2079) (thanks @momothemage).
- Uploads: accept PowerShell `.ps1`, `.psm1`, and `.psd1` files as text-based skill files while keeping normal scan coverage (#897) (thanks @cute-omega).
- Packages: count package install stat events separately from package downloads and record npm tarball fetches as installs (#1712).
- Web: keep the Publishers directory responsive for high-volume publishers by using bounded published-item previews, and abort stale unified-search plugin requests during route changes.
- Web: point skill, plugin, and soul owner links directly at canonical `/p/:handle` publisher profiles instead of legacy redirect routes.
- Web/API: ignore stale public skill-list cursors from older sort or safety-filter indexes instead of throwing pagination errors.
- Web: restore dashboard skill metrics for owned skills and use pointer cursors on dropdown menu items (#2113) (thanks @fuller-stack-dev).
- Web: show the skills browse `Hide suspicious` control only when the loaded results include suspicious skills (thanks @vyctorbrzezowski).
- Web: align signed-in header avatar controls across desktop and mobile so the menu trigger keeps consistent sizing, truncation, and dropdown styling (#2124) (thanks @vyctorbrzezowski).
- Web: constrain settings, profile content, skill detail, and plugin detail pages to the header content width while preserving profile hero bleed (thanks @vyctorbrzezowski).
- Web: show publish-page validation next to the relevant fields and upload picker so invalid inputs are not buried below the form (#908) (thanks @AndyZhengyan).
- Docs: remove README references to the inactive onlycrabs.ai domain while leaving the internal SoulHub configuration generic (#951) (thanks @muescha).
- Docs/dev: document the local Convex site proxy URL and make worktree setup reject misconfigured local site URLs that break HTTP routes (#2060) (thanks @vyctorbrzezowski).
- Dev setup: make local seed reset deterministic by cleaning stale seed lookup and badge rows for repeated Convex dev runs (#2057) (thanks @vyctorbrzezowski).

## 0.12.3 - 2026-05-06

### Fixes

- CLI/API: allow skill publishes to target an org/user publisher with `--owner` / `ownerHandle`, and keep root `SKILL.md` publishable even when broad ignore rules match Markdown files (thanks @deepujain).
- Packages: expose owned plugin/package soft-delete in the CLI and dashboard, keep moderator takedown access, and remove deleted packages from package search surfaces (thanks @Patrick-Erichsen).
- Packages: support monorepo package publishes, infer package owners from scoped names, and keep dry-run publishes metadata-only.
- Packages: validate code-plugin runtime entries against extracted files, allow admin plugin release publishes, and raise trusted-publish/admin API rate limits for legitimate publish bursts.
- API/Search: return lean skill list payloads, route package search through digest indexes, decode scoped package paths, and bound fallback scans to reduce production read pressure.
- Web: restore skill downloads and search paging, canonicalize scoped plugin paths, and improve mobile layout responsiveness.
- Security: add scanner checks for confirmation bypasses and Python file upload exfiltration while reducing generic false-positive package tags.

## 0.12.2 - 2026-05-02

### Fixes

- CLI: publish code plugins as clawpacks and allow legacy package downloads to keep older install flows working.
- API: resolve scoped package routes and accept scoped npm packuments.
- Schema: allow nullable package SHA values in package responses and refresh generated schema artifacts.

## 0.12.1 - 2026-05-02

### Added

- Packages: add clawpack parsing, uploads, mirror artifact routes, artifact downloads, release moderation, reports, appeals, and official migration management across API, dashboard, and CLI.
- Security: add ClawScan security surfaces, owner rescan guidance, scanner-specific report pages, security dataset snapshots, and redacted skill-content exports.
- CLI: add unban support, moderation diagnostics in `inspect`, manual skill-directory listing, package environment filters, and package migration-status commands.
- Web: add skills/plugins search typeahead, featured plugin curation, plugin management tools, skill upload shortcuts, and dashboard pagination.

### Fixes

- API: raise public read rate limits to reduce false-positive 429s from browser pages and production smoke tests (thanks @steipete).
- CLI/moderation: allow `delete`, `hide`, `undelete`, and `unhide` to record moderation reasons in skill notes and audit logs for legal or policy reviews (thanks @steipete).
- Packages: make package publish retries idempotent, constrain catalog queries, keep package list queries single-page, count package archive downloads, and keep beta plugin packages off `latest`.
- Search: add soul lexical fallback, non-suspicious digest indexes, normalized skill prefix recall, and more stable relevance recall windows.
- Security: broaden static scanner coverage for unsafe credential, subprocess, browser-file, provider-secret, and remote-recipe patterns while hardening prompt-boundary handling.
- Deploy/CI: harden production smoke checks, expand PR validation coverage, add dead-code gates, and stabilize CodeQL light coverage.
- Dependencies: pin `undici` on the Node 20-compatible line after reverting the incompatible v8 update.

## 0.12.0 - 2026-04-28

### Added

- Security: add owner rescan requests, owner flagged inventory, scanner-specific security pages, and in-progress scan states.
- UI: adopt shadcn-managed primitives and polish the rescan/security surfaces for mobile.

### Fixes

- Moderation: calibrate VirusTotal Code Insight suspicious verdicts so uncorroborated AI-only findings do not keep otherwise clean skills quarantined (#1830, #1841) (thanks @deepujain).
- Security: flag exposed secrets in skill docs and normalize VirusTotal engine stats before caching.
- Packages: constrain plugin catalog queries and avoid catalog/package-list query limits.
- Auth: tolerate stale auth state when reading star status.
- CI: harden and debounce ClawSweeper dispatch workflows and fix production smoke coverage.

## 0.11.0 - 2026-04-28

### Changed

- Docs: clarify that ClawHub does not support paid skills, per-skill pricing, or paywalled releases (#1752, #1844) (thanks @deepujain).
- API docs: clarify how third-party directories can reuse public ClawHub catalog endpoints while respecting rate limits and canonical links (#1825, #1845) (thanks @deepujain).
- Packages docs: document the required fields for code-plugin package publish flows (#1802) (thanks @deepujain).
- Search: add CJK tokenization support (Chinese/Japanese/Korean) with Intl.Segmenter plus fallback behavior to improve skill query matching (#1596) (thanks @pq-dong).
- Stats: centralize migrated skill stat fallback reads through `readCanonicalStat()` and add schema/agent guardrails to discourage direct legacy nested-field access (#1709) (thanks @momothemage).

### Fixes

- Packages: use the configured `GITHUB_TOKEN` for trusted-publisher repository identity lookups to avoid anonymous GitHub API rate limits during publish setup (#1820, #1846) (thanks @deepujain).
- Packages: keep package search fallback scans bounded, stop scanning after the requested result limit, and keep direct plugin-name matches scoped to the requested package family (OpenClaw #64025).
- Moderation: stop flagging declared env vars sent to their intended API while preserving broad env scraping and exfiltration findings (#1803) (thanks @deepujain).
- Moderation: stop treating generic webhook integration docs as suspicious unless they include explicit Discord or Slack webhook endpoints (#1716) (thanks @langningchen-openclaw).
- Search: increase initial vector candidate pools and align CLI search's default limit with the web UI so high-scoring matches are not missed at small limits (#1375, #1429) (thanks @tjefferson).
- Search: fall back to lexical skill search when embedding generation fails instead of returning empty skill results (#1291) (thanks @goulonghui).
- Search: rank exact slug matches above longer slugs that merely contain all query tokens (#1130) (thanks @QuinnH496).
- Search: widen lexical fallback coverage and scan recently created skills so newly published skills can be found before embeddings rank well (#1185, #1200) (thanks @thirumaleshp).
- Search: preserve vector scores across candidate expansion and require all query tokens to match exact-token filters so relevant skills are not crowded out (#1759, #1762) (thanks @LinPower).
- Stats maintenance: keep skill stat migration fields synchronized by treating top-level stat fields as canonical during backfill/reconcile fallback reads (#1704) (thanks @momothemage).
- Skill install: render OpenClaw CLI commands with the bare slug that the current CLI accepts (#1807).
- Skills: keep historical tags out of public skill detail surfaces while preserving manager visibility (#1804) (thanks @deepujain).
- Skills moderation: keep hash-based scanner callbacks from overwriting skill-level moderation for older versions (#1805) (thanks @deepujain).
- Skills: prevent backport publishes from clobbering `latest` state and guard malformed persisted latest semver values during publish comparisons (#1832) (thanks @momothemage).

## 0.10.0 - 2026-04-05

### Added

- Design system: introduce a shared UI component library (`src/components/ui/`) built on Radix UI primitives — Button, Card, Badge, Tabs, Dialog, Input, Textarea, Label, Select, Avatar, Separator, Tooltip, ScrollArea, Sheet, Skeleton, and Table — following the shadcn/ui pattern with `cn()` + Tailwind utilities.
- Design system: `Button` supports `asChild` via Radix Slot for polymorphic rendering (e.g., wrapping `<Link>` without extra DOM).
- Layout: add `Container` component with `narrow` / `default` / `wide` size presets and `Breadcrumb` component for hierarchical navigation.
- Loading: add skeleton loading states (`SkillCardSkeleton`, `SkillDetailSkeleton`, `DashboardSkeleton`) replacing text-based "Loading..." indicators with animated placeholders.
- Errors: add `ErrorBoundary` with `resetKey` prop that auto-resets on route changes, wired into the root layout.
- Errors: surface fallback messages from Convex API error payloads in mutation/action error toasts.
- UX: add `EmptyState` component with icon, headline, description, and optional CTA action used across dashboard, stars, profile, and publish pages.
- UX: add confirmation dialogs for destructive skill ownership actions (transfer, abandon).
- Markdown: add `MarkdownPreview` component with `react-markdown`, `remark-gfm`, and `react-syntax-highlighter` for rich rendering of skill/plugin READMEs with syntax-highlighted code blocks, GFM tables, and task lists.
- Markdown: render tables with the new `Table` UI primitive for consistent styling across skill docs.
- Navigation: replace DropdownMenu-based mobile nav with a slide-out `Sheet` panel.
- Validation: add Zod schemas (`src/lib/schemas.ts`) for publish-skill, settings, report, and org forms.
- Management: restore capability-tags UI (crypto, requires-wallet, can-make-purchases, etc.) that was silently removed during the initial refactor.
- Management: add `.catch()` error handling with toast feedback on `setSoftDeleted` calls; prompt for hide/restore reasons.

### Changed

- CSS: migrate from a monolithic 5,161-line `styles.css` to Tailwind utilities on components, pruning CSS to ~1,000 lines (81% reduction). Dark mode now uses Tailwind `dark:` variants via a `@variant dark` directive bridging existing CSS custom properties.
- Tailwind: add `@theme` block mapping all CSS design tokens (`--bg`, `--surface`, `--ink`, `--accent`, `--line`, `--radius-*`, etc.) into first-class Tailwind utilities.
- Pages: modernize all route pages (home, skills browse, skill detail, dashboard, settings, publish-skill, publish-plugin, import, about, CLI auth, stars, souls, user profile, org profile, management, plugins browse, plugin detail) from CSS class selectors to Tailwind + UI primitives.
- Skills browse: widen container to `wide` (1400px) for better use of screen space on desktop; same for plugins browse.
- Skills browse: replace text-based filter toggles with pill chips and modernize toolbar layout.
- Skill detail: migrate tab controls from CSS-styled buttons to Radix `Tabs` primitive with proper `role="tab"` accessibility.
- Skill detail: replace inline CSS class-based install card with `SkillInstallCard` using Card + Button primitives.
- Header/Footer: migrate from CSS classes to Tailwind utilities with responsive Sheet-based mobile navigation.
- Dashboard: replace CSS table layout with `Table` UI primitive; add metric cards and skeleton loading.
- Settings: modernize form inputs with `Input`/`Textarea`/`Label` primitives and structured layout.
- Publish: use `Dialog` primitive for modals; inline validation indicators; modernized file list display.

### Fixed

- Auth: `EmptyState` "Sign in" button on publish page now triggers GitHub OAuth via `useAuthActions` instead of linking to non-existent `/signin` route.
- API: fix plugins page dev-mode `{"error":"Only HTML requests are supported here"}` by routing SSR and localhost API fetches directly to the Convex site URL instead of through TanStack Start's request pipeline.
- API: fix CORS error when `credentials: "include"` conflicts with `Access-Control-Allow-Origin: *` by making credentials conditional on same-origin requests.
- API: fix SSR `packageApiUrl` to always use `VITE_CONVEX_SITE_URL` directly, avoiding `getRequestUrl()` failures when SSR request context is unavailable.
- Management: restore `setSoftDeleted` reason parameter for hide/restore actions.
- Tests: rename `settings.test.tsx` to `-settings.test.tsx` to exclude from TanStack Router's file-based route discovery.
- Tests: add `@convex-dev/auth/react` mock for `useAuthActions` in upload route tests.
- Tests: update skill detail tests for Radix tab roles (`role="tab"` instead of `role="button"`), skeleton loading classes (`animate-pulse`), and capability tag data.
- Tests: update skills index tests for refreshed UI copy (placeholder text, empty state wording, loading indicator patterns).
- Tests: update SkillDiffCard tests for Tailwind active-tab class (`shadow-sm` replacing `.is-active`).
- Tests: update packages publish route tests for Tailwind border classes.
- Tests: update packageApi tests for conditional credentials and SSR URL resolution.

## 0.9.0 - 2026-03-23

### Added

- Packages/Plugins: add a first-class OpenClaw package registry across the web app, CLI, and HTTP API. ClawHub now supports package browse/search/detail/version/file/download flows plus `clawhub package explore`, `clawhub package inspect`, and `clawhub package publish` for `skill`, `code-plugin`, and `bundle-plugin` packages. (#1093)
- Packages/Install: package downloads now ship install-ready archives with a `package/` root, support nested files like `dist/index.js`, and work directly with OpenClaw plugin install flows.
- Skills/Web: server-render public skill pages and OG assets for faster first loads, cleaner sharing previews, and better cache behavior.

### Changed

- Browse/Search: rebuild public browse/search around denormalized digests, one-shot HTTP fetches, and deterministic cursors so the homepage and `/skills` are faster, more cacheable, and less likely to hit stale-tab or pagination dead ends.
- Search: default skill search to relevance, keep load-more retryable after fetch failures, and tighten package/skill catalog query paths to reduce inconsistent results under load.

### Fixed

- Packages/Auth: authenticated owners can now list, search, inspect, download, and read files from their own private packages instead of private packages being direct-URL-only. (#1093)
- Packages/API: stabilize package latest-version pointers, cursor pagination, publish outputs, fallback release resolution, and app-origin auth handling so package publish/search/install flows stay reliable.
- Visibility/API: prevent skills owned by deleted/banned users from showing up in public detail pages, browse/search results, or version API routes.
- Skills/API: sanitize public skill and soul version/file reads so hidden or invalid version data does not leak through direct API access.
- Skills/Web: keep Monaco compare layout toggles reliable while defaulting narrow screens to inline mode (#828) (thanks @geoffrey-xiao).

## 0.8.0 - 2026-03-13

### Added

- Skills/Web: show skill owner avatar + handle on skill cards, lists, and detail pages (#312) (thanks @ianalloway).
- Skills/Web: add file viewer for skill version files on detail page (#44) (thanks @regenrek).
- CLI: add `uninstall` command for skills (#241) (thanks @superlowburn).
- Skills/API/CLI: add ownership transfer workflow with request/list/accept/reject/cancel flows.
- Skills/Web/API: surface platform/architecture labels and security evaluation results in v1 + inspect views (#499, #362).
- API: add structured skill moderation responses plus `GET /api/v1/skills/{slug}/moderation` with redacted public evidence and full owner/staff detail (#334) (thanks @ArthurzKV).
- Moderation: persist structured moderation snapshots (static scan + VT/LLM merged verdict, reason codes, and evidence) on skills and versions (#333) (thanks @ArthurzKV).
- API: add scan security verification endpoint and non-suspicious filters (#820).
- Users: add `trustedPublisher` flag and admin mutations to bypass pending-scan auto-hide for trusted publishers (#298) (thanks @autogame-17).
- Moderation: add comment reporting with per-user active report caps, unique reporter/target enforcement, and auto-hide on the 4th unique report.
- Moderation: add AI-driven comment scam backfill (`commentModeration:*`) with persisted verdict/confidence/explainer metadata and strict auto-ban for `certain_scam` + `high` confidence.
- Admin: add manual unban for banned users (clears `deletedAt` + `banReason`, audit log entry). Revoked API tokens stay revoked.
- Admin: bulk restore skills from GitHub backup; reclaim squatted slugs via v1 endpoints + internal tooling (#298) (thanks @autogame-17).
- Moderation/Admin: add manual override audit tools for suspicious-skill review.
- CI/Security: add TruffleHog pull-request scanning for verified leaked credentials (#505) (thanks @akses0).

### Changed

- Skills: make published skill licensing explicit and fixed to MIT-0; require publish consent, surface no-attribution messaging in web/CLI/API, and remove per-skill license metadata.
- Skill metadata: support env vars, dependency declarations, author, and links in parsed manifest metadata + install UI (#360) (thanks @mahsumaktas).
- Rate limiting: apply authenticated quotas by user bucket (vs shared IP), emit delay-based reset headers, and improve CLI 429 guidance/retries (#412) (thanks @lc0rp).
- Skills: reserve deleted slugs for prior owners (90-day cooldown) to prevent squatting; add admin reclaim flow (#298) (thanks @autogame-17).
- Moderation: ban flow soft-deletes owned skills (reversible) and removes them from vector search (#298) (thanks @autogame-17).
- Security/docs: document comment reporting/auto-hide behavior alongside existing skill reporting rules.
- Security/moderation: add bounded explainable auto-ban reasons for scam comments and protect moderator/admin accounts from automated bans.
- Moderation: banning users now also soft-deletes their authored comments (skill + soul), including legacy cleanup on re-ban.
- Quality gate: language-aware word counting (`Intl.Segmenter`) and new `cjkChars` signal to reduce false rejects for non-Latin docs.
- Jobs: run skill stat event processing every 5 minutes (was 15).
- Deploy: add frontend/backend drift detection plus hardened production smoke/deploy checks.
- API performance: batch resolve skill/soul tags in v1 list/get endpoints (fewer action->query round-trips) (#112) (thanks @mkrokosz).
- LLM helpers: centralize OpenAI Responses text extraction for changelog/summary/eval flows (#502) (thanks @ianalloway).
- Search/listing performance: cut embedding hydration and badge read bandwidth via `embeddingSkillMap` + denormalized skill badges; shift stat-doc sync to low-frequency cron (#441) (thanks @sethconvex).
- Search/listing performance: move public browse/search hydration onto `skillSearchDigest`, add non-suspicious index paths, and split trending rebuilds to stay under Convex document limits.

### Fixed

- API: accept legacy CLI publish payloads during the v1 migration (#815).
- Auth/UI: surface OAuth callback failures in the web UI instead of swallowing them (#688).
- Skills: allow ownership healing when the previous owner was deleted/banned, and sanitize owner data in public payloads (#689, #793).
- CLI: validate explicit `install --force --version` targets before removing an existing local skill, preventing data loss when the requested version does not exist (#825) (thanks @jonathandeamer).
- Skills/Web: debounce search URL updates on `/skills` to keep typing responsive, and cancel stale pending navigations on external query changes (#587) (thanks @neeravmakwana).
- Upload: keep folder-picking enabled after page refresh by reapplying `webkitdirectory`/`directory` on the file input ref (#551) (thanks @MunemHashmi).
- CLI publish: use a longer multipart upload timeout and normalize abort rejections into proper Errors (#550) (thanks @MunemHashmi).
- CLI: forward optional auth tokens for `search` and `explore` against authenticated registries (#608) (thanks @artdaal).
- CLI: respect `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` env vars for outbound registry requests, with troubleshooting docs (#363) (thanks @kerrypotter).
- CLI: preserve registry base paths when composing API URLs for search/inspect/moderation commands (#486) (thanks @Liknox).
- CLI: show manual URL guidance when automatic browser opening is unavailable; add regression tests for opener errors (#163) (thanks @aronchick).
- API/CLI: expose skill security status in version inspect output, with schema wiring and CLI regression coverage (#362) (thanks @abutbul).
- Moderation: remove over-broad keyword flags for common auth/payment/crypto terms so legitimate skills stop tripping regex prefilters (#273) (thanks @superlowburn).
- Skills hard-delete: delete `commentReports` rows during moderation cleanup to avoid orphaned report records.
- Comments: hide entries authored by deleted/deactivated users in `comments:listBySkill`.
- Admin API: `POST /api/v1/users/reclaim` now performs non-destructive root-slug owner transfer
  (preserves existing skill versions/stats/metadata) and clears active slug reservations.
- VirusTotal: use shared AV-engine fallback verdict mapping for pending/backfill flows and keep undetected-only results pending (#591) (thanks @Shuai-DaiDai).
- Skills/listing: keep non-suspicious browse pagination on one cursor family during `isSuspicious` backfill, and re-sync stale `latestVersionSummary` metadata fields (#572) (thanks @sethconvex).
- PWA: update `manifest.json` branding so installed apps show the correct ClawHub name (#569) (thanks @Glucksberg).
- Search/tests: cover soft-deleted skill filtering in vector hydration and lexical exact-slug fallback (#552) (thanks @MunemHashmi).
- Docs/dev: fix local setup instructions for Node support, Convex env vars, frontend port, and post-seed stats refresh (#584) (thanks @jack-piplabs).
- Docs/CLI: fix `explore` flag list indentation so `--limit` renders correctly in the command reference (#601) (thanks @gandli).
- Skill metadata: parse top-level `requires.*`, `primaryEnv`, and homepage fallbacks for security review accuracy (#548) (thanks @MunemHashmi).
- Users: sync handle on ensure when GitHub login changes (#293) (thanks @christianhpoe).
- Users/Auth: throttle GitHub profile sync on login; also sync avatar when it changes (#312) (thanks @ianalloway).
- Upload gate: fetch GitHub account age by immutable account ID (prevents username swaps) (#116) (thanks @mkrokosz).
- VT fallback: activate only VT-pending hidden skills when scans are unavailable/stale; keep quality/scanner-blocked skills hidden (#300) (thanks @superlowburn).
- API: return proper status codes for delete/undelete errors (#35) (thanks @sergical).
- API: for owners, return clearer status/messages for hidden/soft-deleted skills instead of a generic 404.
- Web: allow copying OpenClaw scan summary text (thanks @borisolver, #322).
- HTTP/CORS: add preflight handler + include CORS headers on API/download errors; CLI: include auth token for owner-visible installs/updates (#146) (thanks @Grenghis-Khan).
- CLI: clarify `logout` only removes the local token; token remains valid until revoked in the web UI (#166) (thanks @aronchick).
- CLI: validate skill slugs used for filesystem operations (prevents path traversal) (#241) (thanks @superlowburn).
- Skills: keep global sorting across pagination on `/skills` (thanks @CodeBBakGoSu, #98).
- Skills: allow updating skill description/summary from frontmatter on subsequent publishes (#312) (thanks @ianalloway).
- Skills/Web: prevent filtered pagination dead-ends and loading-state flicker on `/skills`; move highlighted browse filtering into server list query (#339) (thanks @Marvae).
- Web: align `/skills` total count with public visibility and format header count (thanks @rknoche6, #76).
- Skills/Web: centralize public visibility checks and keep `globalStats` skill counts in sync incrementally; remove duplicate `/skills` default-sort fallback and share browse test mocks (thanks @rknoche6, #76).
- Moderation: clear stale `flagged.suspicious` flags when VirusTotal rescans improve to clean verdicts (#418) (thanks @Phineas1500).
- API tests: lock `Retry-After` behavior to relative-delay semantics for v1 search 429s (#421) (thanks @apoorvdarshan).
- CLI tests: assert 5xx HTTP responses still perform retry attempts before surfacing final error (#457) (thanks @YonghaoZhao722).
- GitHub import: improve storage/publish failure errors with actionable context; add regression tests for error formatting (#512) (thanks @vassiliylakhonin).

## 0.7.0 - 2026-02-16

Reconstructed from the `clawhub@0.7.0` npm publish timestamp (`2026-02-16T05:02:25Z`) and the repo version bump commit (`e352309`).

### Added

- Skills/Web: show owner avatars/handles across cards, lists, and detail pages (#312) (thanks @ianalloway).
- Skills/Web: add version file viewer on skill detail pages (#44) (thanks @regenrek).
- CLI: add `uninstall` for installed skills (#241) (thanks @superlowburn).
- Skills/Web: add non-suspicious browse filter, downloads-first browse defaults, and popular non-suspicious homepage sections.
- Web: compact-format skill and soul stats, plus split page models for skills/detail rendering.
- Skills: auto-generate missing summaries and add a resumable/self-scheduling summary backfill job.
- Moderation/Admin: add anti-spam publish caps, trust-tier quality checks, empty-skill cleanup tooling, and stronger moderator UX.

### Changed

- HTTP/CLI: centralize CORS handling and allow tokenized owner-visible reads through the CLI (#296, #297).
- API performance: batch resolve tags in v1 list/get flows to cut action-to-query round-trips (#112) (thanks @mkrokosz).
- Quality gate: add language-aware word counting and tighten spam/quarantine handling around publish flows.

### Fixed

- Skills/Web: fix initial sort wiring, keep global ordering across pagination, prevent pagination dead-ends/flicker, and harden cursor recovery (#92, #98, #339).
- CLI: normalize abort/timeout errors, secure config-file permissions, clarify logout semantics, and prefer `$HOME` for path resolution (#164, #166, #283, #286, #299).
- API: return correct delete/undelete status codes and clearer soft-delete/owner-visible error responses (#35) (thanks @sergical).
- Upload/Auth: gate publish ownership by immutable GitHub account ID and handle duplicate auth-user records safely.
- Downloads/Search: harden download dedupe/rate limiting, improve SSR host awareness, and fix homepage/search regressions under legacy data.

## 0.6.1 - 2026-02-13

### Added

- Security: add LLM-based security evaluation during skill publish.
- Parsing: recognize `metadata.openclaw` frontmatter and evaluate all skill files for requirements.

### Changed

- Performance: lazy-load Monaco diff viewer on demand (thanks @alexjcm, #212).
- Search: improve recall/ranking with lexical fallback and relevance prioritization.
- Moderation UX: collapse OpenClaw analysis by default; update spacing and default reasoning model.

### Fixed

- Skills: fix initial `/skills` sort wiring so first page respects selected sort/direction (thanks @bpk9, #92).
- Search/UI: add embedding request timeout and align `/skills` toolbar + list width (thanks @GhadiSaab, #53).
- Upload gate: handle GitHub API rate limits and optional authenticated lookup token (thanks @superlowburn, #246).
- HTTP: remove `allowH2` from Undici agent to prevent `fetch failed` on Node.js 22+ (#245).
- Tests: add root `undici` dev dependency for Node E2E imports (thanks @tanujbhaud, #255).
- Downloads: add download rate limiting + per-IP/day dedupe + scheduled dedupe pruning; preserve moderation gating and deterministic zips (thanks @regenrek, #43).
- VirusTotal: fix scan sync race conditions and retry behavior in scan/backfill paths.
- Metadata: tolerate trailing commas in JSON metadata.
- Auth: allow soft-deleted users to re-authenticate on fresh login, while keeping banned users blocked (thanks @tanujbhaud, #177).
- Web: prevent horizontal overflow from long code blocks in skill pages (thanks @bewithgaurav, #183).

## 0.6.0 - 2026-02-10

### Added

- CLI/API: add `set-role` to change user roles (admin only).
- Security: quarantine skill publishes with VirusTotal scans + UI (thanks @aleph8, #130).
- Testing: add tests for badges, skillZip, uploadFiles expandDroppedItems, and ark schema error truncation.
- Moderation: add ban reasons to API/CLI and show in management UI.

### Changed

- Coverage: track `convex/lib/skillZip.ts` in coverage reports.

### Fixed

- Web: show pending-scan skills to owners without 404 (thanks @orlyjamie, #136).
- Users: backfill empty handles from name/email in ensure (thanks @adlai88, #158).
- Web: update footer branding to OpenClaw (thanks @jontsai, #122).
- Auth: restore soft-deleted users on reauth, block banned users (thanks @mkrokosz, #106).

## 0.5.0 - 2026-02-02

### Added

- Admin: ban users and delete owned skills from management console.
- Moderation: auto-hide skills after 4 unique reports; per-user report cap; moderators can ban users.
- Uploads: require GitHub accounts to be at least 7 days old for skill + soul publish/import.
- CLI: add `inspect` to fetch skill metadata/files without installing.
- CLI: add moderation commands for hide/unhide/delete and ban users.
- Management: add filters for reported skills and users.

### Changed

- Deps: update dependencies to latest available versions.
- Reporting: require reasons, show them in management console, warn about abuse bans.

### Fixed

- Bans: batch hard-delete cleanup to avoid Convex read limits on large skills.

## 0.4.0 - 2026-01-30

### Added

- Web: show published skills on user profiles (thanks @njoylab, #20).
- CLI: include ClawHub + Moltbot fallback skill roots for sync scans.
- CLI: support OpenClaw configuration files (`OPENCLAW_CONFIG_PATH` / `OPENCLAW_STATE_DIR`).

### Changed

- Brand: rebrand to ClawHub and publish CLI as `clawhub` (legacy `clawdhub` supported).
- Domain: default site/registry now `https://clawhub.ai`; `.well-known/clawhub.json` preferred.
- Theme: persist theme under `clawhub-theme` (legacy key still read).

### Fixed

- Registry: drop missing skills during search hydration (thanks @aaronn, #28).
- CLI: use path-based skill metadata lookup for updates (thanks @daveonkels, #22).
- Search: keep highlighted-only filtering and clamp vector candidates to Convex limits (thanks @aaronn, #30).

## 0.3.0 - 2026-01-19

### Added

- CLI: add `explore` command for latest updates, with limit clamping + tests/docs (thanks @jdrhyne, #14).
- CLI: `explore --json` output + new sorts (`installs`, `installsAllTime`, `trending`) and limit up to 200.
- API: `/api/v1/skills` supports installs + trending sorts (7-day installs).
- API: idempotent `POST/DELETE /api/v1/stars/{slug}` endpoints.
- Registry: trending leaderboard + daily stats backfill for installs-based sorts.

### Fixed

- Web: keep search mode navigation and state in sync (thanks @NACC96, #12).

## 0.2.0 - 2026-01-13

### Added

- Web: dynamic OG image cards for skills (name, description, version).
- CLI: auto-scan Clawdbot skill roots (per-agent workspaces, shared skills, extraDirs).
- Web: import skills from public GitHub URLs (auto-detect `SKILL.md`, smart file selection, provenance).
- Web/API: SoulHub (SOUL.md registry) with v1 endpoints and first-run auto-seed.

### Fixed

- Web: stabilize skill OG image generation on server runtimes.
- Web: prevent skill OG text overflow outside the card.
- Registry: make SoulHub auto-seed idempotent and non-user-owned.
- Registry: keep GitHub backup state + publish backups intact (thanks @joshp123, #1).
- CLI/Registry: restore fork lineage on sync + clamp bulk list queries (thanks @joshp123, #1).
- CLI: default workdir falls back to Clawdbot workspace (override with `--workdir` / `CLAWHUB_WORKDIR`).

## 0.0.6 - 2026-01-07

### Added

- API: v1 public REST endpoints with rate limits, raw file fetch, and OpenAPI spec.
- Docs: `docs/api.md` and `DEPRECATIONS.md` for the v1 cutover plan.

### Changed

- CLI: publish now uses single multipart `POST /api/v1/skills`.
- Registry: legacy `/api/*` + `/api/cli/*` marked for deprecation (kept for now).

## 0.0.5 - 2026-01-06

### Added

- Telemetry: track installs via `clawhub sync` (logged-in only), per root, with 120-day staleness.
- Skills: show current + all-time installs; sort by installs.
- Profile: private "Installed" tab with JSON export + delete telemetry controls.
- Docs: add `docs/telemetry.md` (what we track + how to opt out).
- Web: custom Open Graph image (`/og.png`) + richer OG/Twitter tags.
- Web: dashboard for managing your published skills (thanks @dbhurley!).

### Changed

- CLI: telemetry opt-out via `CLAWHUB_DISABLE_TELEMETRY=1`.
- Web: move theme picker into mobile menu.

### Fixed

- Web: handle shorthand hex colors in diff theme (thanks @dbhurley!).

## 0.0.5 - 2026-01-06

### Added

- Maintenance: admin backfill to re-parse `SKILL.md` and repair stored summaries/parsed metadata.

### Fixed

- CLI sync: ignore plural `skills.md` docs files when scanning for skills.
- Registry: parse YAML frontmatter (incl multiline `description`) and accept YAML `metadata` objects.

## 0.0.4 - 2026-01-05

### Added

- Web: `/skills` list view with sorting (newest/downloads/stars/name) + quick filter.
- Web: admin/moderator highlight toggle on skill detail.
- Web: canonical skill URLs as `/<owner>/<slug>` (legacy `/skills/<slug>` redirects).
- Web: upload auto-generates a changelog via OpenAI when left blank (marked as auto-generated).

### Fixed

- Web: skill detail shows a loading state instead of flashing "Skill not found".
- Web: user profile shows avatar + loading state (no "User not found" flash).
- Web: improved mobile responsiveness (nav menu, skill detail layout, install command overflow).
- Web: upload now unwraps folder picks so `SKILL.md` can be at the bundle root.
- Registry: cap embedding payload size to avoid model context errors.
- CLI: ignore legacy `auth.clawdhub.com` registry and prefer site discovery.

### Changed

- Web: homepage search now expands into full search mode with live results + highlighted toggle.
- CLI: sync no longer prompts for changelog; registry auto-generates when blank.

## 0.0.3 - 2026-01-04

### Added

- CLI sync: concurrency flag to limit registry checks.
- Home: install command switcher (npm/pnpm/bun).

### Changed

- CLI sync: default `--concurrency` is now 4 (was 8).
- CLI sync: replace boxed notes with plain output for long lists.

### Fixed

- CLI sync: wrap note output to avoid terminal overflow; cap list lengths.
- CLI sync: label fallback scans as fallback locations.
- CLI package: bundle schema internally (no external `clawhub-schema` publish).
- Repo: mark `clawhub-schema` as private to prevent publishing.

## 0.0.2 - 2026-01-04

### Added

- CLI: delete/undelete commands for soft-deleted skills (owner/admin).

### Fixed

- CLI sync: dedupe duplicate slugs across scan roots; skip duplicates to avoid double-publish errors.
- CLI sync: show parsing progress while hashing local skills.
- CLI sync: prompt only actionable skills; preselect all by default; list synced separately; condensed synced summary when nothing to sync.
- CLI sync: cap long status lists to avoid massive terminal boxes.
- CLI publish/sync: allow empty changelog on updates; registry accepts empty changelog for updates.
- CLI: use `--cli-version` to avoid conflict with skill `--version` flags.
- Registry: hide soft-deleted skills from search/skill/download unless restored.
- Tests: add delete/undelete coverage (unit + e2e).

## 0.0.1 - 2026-01-04

### Features

- CLI auth: login/logout/whoami; browser loopback auth; token storage; site/registry discovery; config overrides.
- CLI workflow: search, install, update (single/all), list, publish, sync (scan workdir + legacy roots), dry-run, version bumping, tags.
- Registry/API: skills + versions with semver; tags (latest + custom); changelog per version; SKILL.md frontmatter parsing; text-only validation; zip download; hash resolve; stats (downloads/stars/versions/comments).
- Web app: home (highlighted + latest), search, skill detail (README, versions, tags, stats, files), upload UI, user profiles, stars, settings (profile + API tokens + delete account).
- Social: stars + comments with moderation hooks; admin console for roles + highlighted curation.
- Search: semantic/vector search over skill content with limit/approved filters.
- Security: GitHub OAuth; role-based access (admin/moderator/user); audit logging for admin actions.
