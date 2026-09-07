# ClawHub design audit

- Carapace: `v0.6.1`
- ClawHub commit: `d3bde70e3c9373720d4d3e335f9935399ea2c008`
- Comparison base: `9d43db7f02895dfdd734cd77e6646a004508aa6f`
- Generated: 2026-09-07T15:40:06.123Z
- Validation: passed

## Summary

- Errors: 0
- Warnings: 6
- Informational: 0
- Safe source fixes: 1

## Validation

- `bun run test:ui-contract`
- `bun run ci:static`
- `bun run ci:unit`
- `bun run ci:types-build`
- `bun run ci:playwright-smoke`

## Rendered routes

- `/`
- `/skills`
- `/plugins`

## Findings

### WARNING: `token/legacy-alias`

- Evidence: [src/styles.css](../../src/styles.css#L2270)
- Kind: mechanical
- Finding: New code depends on migration-only alias --ink.
- Remediation: Use the equivalent canonical --oc-* semantic token.
- Contract: `openclaw-design-system/references/consumer-adapters.md`

### WARNING: `token/legacy-alias`

- Evidence: [src/styles.css](../../src/styles.css#L14797)
- Kind: mechanical
- Finding: New code depends on migration-only alias --ink-soft.
- Remediation: Use the equivalent canonical --oc-* semantic token.
- Contract: `openclaw-design-system/references/consumer-adapters.md`

### WARNING: `token/legacy-alias`

- Evidence: [src/styles.css](../../src/styles.css#L14917)
- Kind: mechanical
- Finding: New code depends on migration-only alias --line.
- Remediation: Use the equivalent canonical --oc-* semantic token.
- Contract: `openclaw-design-system/references/consumer-adapters.md`

### WARNING: `token/legacy-alias`

- Evidence: [src/styles.css](../../src/styles.css#L14919)
- Kind: mechanical
- Finding: New code depends on migration-only alias --ink.
- Remediation: Use the equivalent canonical --oc-* semantic token.
- Contract: `openclaw-design-system/references/consumer-adapters.md`

### WARNING: `token/legacy-alias`

- Evidence: [src/styles.css](../../src/styles.css#L14924)
- Kind: mechanical
- Finding: New code depends on migration-only alias --ink-soft.
- Remediation: Use the equivalent canonical --oc-* semantic token.
- Contract: `openclaw-design-system/references/consumer-adapters.md`

1 additional non-error findings are retained in JSON.
