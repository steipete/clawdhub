import { ApiRoutes } from "clawhub-schema";
import type { ActionCtx } from "../_generated/server";
import { applyRateLimit } from "../lib/httpRateLimit";
import {
  getPathSegments,
  requireAdminOrResponse,
  requireApiTokenUserOrResponse,
  text,
} from "./shared";

type ProxyDependencies = {
  baseUrl: string;
  serviceToken: string;
  fetch: typeof fetch;
};

// Admin Hermit proxy: do not hold the Convex action if forms.openclaw.ai stalls.
export const HERMIT_CONTENT_RIGHTS_FETCH_TIMEOUT_MS = 10_000;

const hermitCasePath = (caseId: string, correspondence = false) =>
  `/api/clawhub-content-rights/cases/${encodeURIComponent(caseId)}${
    correspondence ? "/correspondence" : ""
  }`;

const proxyResponse = async (response: Response) =>
  new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });

export async function proxyHermitContentRightsRequest(
  request: Request,
  actorUserId: string,
  dependencies: ProxyDependencies,
) {
  if (!dependencies.serviceToken) {
    return text("ClawHub-Hermit service token is not configured", 503);
  }
  const segments = getPathSegments(request, `${ApiRoutes.contentRights}/`);
  const caseId = segments[0]?.trim().toUpperCase() ?? "";
  if (!/^CHR-\d+$/.test(caseId)) return text("Case not found", 404);
  const baseUrl = dependencies.baseUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${dependencies.serviceToken}` };

  try {
    if (request.method === "GET" && segments.length === 1) {
      return proxyResponse(
        await dependencies.fetch(`${baseUrl}${hermitCasePath(caseId)}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(HERMIT_CONTENT_RIGHTS_FETCH_TIMEOUT_MS),
        }),
      );
    }
    if (request.method === "POST" && segments.length === 2 && segments[1] === "correspondence") {
      const form = await request.formData();
      form.set("actor", actorUserId);
      return proxyResponse(
        await dependencies.fetch(`${baseUrl}${hermitCasePath(caseId, true)}`, {
          method: "POST",
          headers,
          body: form,
          signal: AbortSignal.timeout(HERMIT_CONTENT_RIGHTS_FETCH_TIMEOUT_MS),
        }),
      );
    }
    return text("Not found", 404);
  } catch (error) {
    console.error("ClawHub content rights Hermit proxy failed", error);
    return text("Hermit content rights service unavailable", 502);
  }
}

export async function contentRightsV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, request.method === "GET" ? "read" : "write");
  if (!rate.ok) return rate.response;
  const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;
  const admin = requireAdminOrResponse(auth.user, rate.headers);
  if (!admin.ok) return admin.response;
  return proxyHermitContentRightsRequest(request, auth.userId, {
    baseUrl: process.env.HERMIT_CONTENT_RIGHTS_BASE_URL?.trim() || "https://forms.openclaw.ai",
    serviceToken: process.env.CLAWHUB_BAN_APPEALS_TOKEN?.trim() || "",
    fetch,
  });
}
