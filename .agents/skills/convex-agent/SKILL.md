---
name: convex-agent
description: "Add an AI agent / RAG backend (@convex-dev/agent) to the Convex app."
---

<!-- GENERATED from convex-agents content/capabilities/agent.json — do not edit by hand. -->

# Add an AI agent / RAG backend

Install @convex-dev/agent for durable threads, message history, tool-calls, and vector search/RAG — the backend for an in-app AI agent. Call models through the Convex AI Gateway by default: Convex holds the provider credentials, so there is no LLM key to obtain, store, or rotate.

## Workflow

1. Install @convex-dev/agent + @convex-dev/ai-sdk-provider; add the agent component to convex.config.ts.
2. Define the agent (tools, instructions) with `languageModel: convexGateway("provider/model")` — no API key needed (needs convex 1.45+ on a Convex Cloud deployment, paid plan).
3. Create threads + stream messages; persist history in Convex.
4. For RAG: embed docs into a vector index and retrieve in the tool. The gateway does not serve embeddings yet, so store the embedding provider's key via the `env` micro power.
5. Only if the gateway is unavailable (free plan, self-hosted, local backend): call the provider SDK with a key stored via the `env` micro power.

## Rules

- Default to the Convex AI Gateway (`convexGateway` from @convex-dev/ai-sdk-provider) for model calls; fall back to a provider key in Convex env only where the gateway is unavailable (free plan, self-hosted, local backend).
- Never expose a provider API key client-side; when one is needed (embeddings, gateway fallback), keep it in Convex env via the `env` micro power.
- Run model calls in actions ('use node' if the SDK needs it).
- Persist threads/messages in Convex for durability + reactivity.
