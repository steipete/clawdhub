---
name: convex-launch-readiness
description: "Run every Convex audit (authz, reviewer, advisor, insights) into one scored, deduped readiness report with an ordered fix plan — Lighthouse for your backend."
---

<!-- GENERATED from convex-agents content/capabilities/launch-readiness.json — do not edit by hand. -->

# Launch-readiness report

Readiness is not one check — it's the union of the checks, deduped, ranked, and scored. This capability is pure composition over the findings bus (specs/finding.schema.json): it runs each audit capability, normalizes their outputs into one report (specs/finding-report.schema.json), computes an auditable score, and — because every finding names a fixCapability — hands the user a prioritized, actionable punch list instead of four separate reports. It fixes nothing itself; it decides WHAT to fix and in what order, then dispatches to the fixers.

## Workflow

1. GUARD + SCOPE: deploy-guard classifies the target (local-anonymous / dev / preview / prod); announce it. Detect what's assessable — is there a convex/ dir, a deployed deployment with traffic, an auth foundation? Skip passes whose preconditions aren't met and SAY which were skipped (a skipped pass is not a pass).
2. RUN THE PASSES, each emitting findings on the bus:
   - convex-authz — the authz scan (identity-from-arg, missing ownership, PII leak, parent-ref-on-write). Always runnable on code.
   - convex-reviewer — validators, indexes-not-filter, idiom, error handling. Always runnable on code.
   - convex-advisor — live read-limit / OCC evidence (only if a deployment with traffic exists; else record 'skipped: no traffic').
   - convex-insights — recent failures from logs (only if a deployment exists).
   Run independent passes concurrently; each returns findings, not fixes.
3. NORMALIZE + DEDUPE: collect all findings into one report. Set each finding's `identity` field to a normalized function/table key (e.g. `messages:list`) that is the SAME whether the pass reported a code-locus or a deployment-locus for that function — so the SAME defect seen from two loci (reviewer flags a missing index at code-locus, advisor flags its read-limit symptom at deployment-locus) collapses to ONE via the bus's (class, identity) dedup and isn't double-counted in the score. Keep the higher-confidence source. Drop nothing silently; a pass that errored/was skipped is a stated coverage gap, not a clean result.
4. SCORE, auditable: start at 100; subtract per CONFIRMED finding by severity (high −15, med −5, low −1), floor at 0; print the exact formula and the per-class breakdown so the number is reproducible, not a vibe. plausible-only findings are listed as candidates but do NOT move the score (evidence-not-vibes). A deployment/traffic-less run reports a code-only score and says so.
5. REPORT: the score, then findings ranked by severity, each with its evidence, its locus, and the fixCapability + a one-line fix note. Group by 'blockers' (high) / 'should-fix' (med) / 'nice-to-have' (low). End with the ordered fix plan: which capability to run next, in what order (authz/data-loss first, then perf/scale, then idiom/observability).
6. DISPATCH on request: for each finding the user accepts, invoke its fixCapability (convex-authz, convex-reviewer's fixers, migrate-rehearse for schema changes, suggest for component swaps). After fixes, RE-RUN the affected passes and show the score delta — the readiness number is only meaningful if it moves when you fix things.
7. Never claim more coverage than was run: the report header lists which passes ran, which were skipped and why. A green score on a code-only run is 'code looks ready', not 'production-verified'.

## Rules

- Compose, don't re-implement: run the existing audit capabilities and aggregate their bus findings — never re-derive an authz or perf check inline.
- The score counts CONFIRMED findings only, by severity, with the formula printed; plausible findings are candidates that don't move the number.
- Normalize each finding's locus to a function/table identity before dedup (map deployment functionId ↔ code file:line) so one defect seen from two loci collapses to one and isn't double-scored; keep the higher-confidence source; drop nothing silently.
- Every finding carries its fixCapability; the report ends with an ORDERED fix plan (data-loss/authz first, then scale, then idiom/observability).
- Re-run affected passes after fixes and show the score delta — a readiness number that doesn't move when you fix things is theater.
- Never claim more than was run: header lists ran/skipped passes; a code-only run yields a code-only score, explicitly labeled.
- This is a read + aggregate + dispatch pass; fixes happen in the fixer capabilities, gated by their own consent/deploy-target rules.
