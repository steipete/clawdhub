import { createFileRoute } from "@tanstack/react-router";
import { publicApiUrl } from "../../../../../../lib/publicApiUrl";

export const AGENT_SKILLS_DISCOVERY_TIMEOUT_MS = 10_000;

export const Route = createFileRoute("/$owner/skills/$slug/.well-known/agent-skills/index.json")({
  server: {
    handlers: {
      GET: ({ params }) => fetchAgentSkillsDiscovery(params.owner, params.slug, "GET"),
      HEAD: ({ params }) => fetchAgentSkillsDiscovery(params.owner, params.slug, "HEAD"),
    },
  },
});

export async function fetchAgentSkillsDiscovery(
  owner: string,
  slug: string,
  method: "GET" | "HEAD",
) {
  const upstream = publicApiUrl(
    `/api/v1/agent-skills/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/index.json`,
  );
  const response = await fetch(upstream, {
    method,
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(AGENT_SKILLS_DISCOVERY_TIMEOUT_MS),
  });
  return proxyAgentSkillsDiscoveryResponse(response, method === "GET");
}

export async function proxyAgentSkillsDiscoveryResponse(response: Response, includeBody = true) {
  const headers = new Headers();
  const contentType = response.headers.get("Content-Type");
  const cacheControl = response.headers.get("Cache-Control");
  if (contentType) headers.set("Content-Type", contentType);
  if (cacheControl) headers.set("Cache-Control", cacheControl);

  return new Response(includeBody ? await response.arrayBuffer() : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
