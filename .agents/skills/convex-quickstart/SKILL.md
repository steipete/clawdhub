---
name: convex-quickstart
description: "Get a barebones Convex + web template running from a one-sentence idea."
---

<!-- GENERATED from convex-agents content/capabilities/quickstart.json — do not edit by hand. -->

# Quickstart: a barebones Convex template, running

Stand up a barebones Next.js + Convex template from the idea, locally, with an anonymous dev deployment. Minimal by design: local dev servers, no publish step, no pre-baked auth.

## Workflow

1. Run recipe `quickstart-recipe@^2` with {idea, template} (the pack fetches + caches it; pinned offline fallback). It creates the project, installs deps, starts the backend (anonymous) and the web dev server.
2. When it prints the dev URL, open it for the user.
3. Present a short plan and CONFIRM before building features beyond the template.

## Rules

- Never re-run the recipe if it already reported success.
- Delegate any code under `convex/` to the `convex-expert` capability.
- Don't add Postgres/Redis/Express — use Convex primitives.
- Don't add hosting/publish or pre-baked auth here — keep the template minimal unless the user asks for more.
- DEGRADATION RULE — if the scaffold cannot run (non-interactive session, no network, a sandboxed temp dir, or the user just wants code, not an app): skip the recipe and write a standard Convex project directly. ALL backend code goes under `convex/` (schema.ts, functions) — NEVER at the project root; Convex functions only run from the `convex/` directory. Write ZERO scaffold/documentation files (no START_HERE.md, ARCHITECTURE.md, MANIFEST.txt, README walls) unless explicitly asked. "Build me a backend" means code, not ceremony.
- Data access + imports — before writing any convex/*.ts: never an unbounded `.collect()` on a table that can grow — use `.withIndex(...)` and `.paginate(...)`/`.take(n)`. Use an index, not `.filter()`, for anything that would be a SQL WHERE. `.withIndex(...)` callbacks only have `eq`/`gt`/`gte`/`lt`/`lte` — there is no `.range(...)` method. Imports: `query`/`mutation`/`action`/`internalQuery`/`internalMutation`/`internalAction` come from `./_generated/server`; `api`/`internal` come from `./_generated/api`; NEVER import from `convex/server` in application code. `v.literal("exact value")` for fixed string/enum members, not a bare string. `"use node"` only at the top of action-only modules — never in a file that also exports a `query` or `mutation`. Never import a Node builtin (`crypto`/`fs`/`path`/`http`/`child_process`/`os`, with or without the `node:` prefix) into a file lacking `"use node"` — including `http.ts` route handlers; use Web Crypto (`crypto.subtle`) instead of `import`ing `crypto` where possible.
- Reserved names — never `export const <jsReservedWord> = ...` (e.g. `delete`, `new`, `class`, `function`, `return`) as a query/mutation/action export name; esbuild fails to parse it. Never a table or index name starting with `_` (e.g. `_migrations: defineTable(...)`) — `_` is reserved and errors at push as `TableNameReserved`/`IndexNameReserved`.
- HTTP routes — `httpRouter` has no Express-style `:param` segments (`path: "/users/:id"` only matches that literal string and is dead code); use `pathPrefix` and parse the trailing segment yourself. Every `http.route({...})` `handler:` must be wrapped in `httpAction(...)` from `./_generated/server` — a bare `async (ctx, request) => {...}` type-checks but isn't a valid HTTP action.
- `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` need a codegen'd function reference (`api.foo.bar`/`internal.foo.bar`), never a raw imported module member (`import * as queries from "./queries"; ctx.runQuery(queries.getX, ...)` compiles but fails at runtime).
- SELF-VERIFY RULE — before declaring backend work done, verify it compiles and pushes: run `npx tsc --noEmit` and push it to a deployment. Prefer the project's existing one; otherwise `npx convex dev --once` when `npx convex whoami` succeeds, and `CONVEX_AGENT_MODE=anonymous npx convex dev --once` ONLY when it does not. Forcing anonymous on a signed-in user rebinds `.env.local` and costs them the persistent, publishable cloud deployment they expect. Fix every error it reports before finishing — one verify round catches the wrong-relative-import / duplicate-symbol / unbalanced-paren class that otherwise breaks the deploy.
