import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { applyRateLimit } from "../lib/httpRateLimit";
import { recoveryReason } from "../lib/packagePublishRecovery";
import type { RecoveryResult } from "../packagePublishRecovery";
import {
  getPathSegments,
  json,
  text,
  formatUserFacingErrorMessage,
  requireApiTokenUserOrResponse,
} from "./shared";

const recoverRef = makeFunctionReference<
  "action",
  {
    attemptId: string;
    actorUserId: Id<"users">;
    apiTokenId: Id<"apiTokens">;
    manualOverrideReason: string;
  },
  RecoveryResult
>("packagePublishRecovery:recoverInternal");

export async function recoverPackagePublishAttemptV1Handler(ctx: ActionCtx, request: Request) {
  const segments = getPathSegments(request, "/api/v1/publish/attempts/");
  if (segments.length !== 2 || segments[1] !== "recover") return text("Not found", 404);
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;
  const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;
  let reason: string;
  try {
    const body: unknown = await request.json();
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("manualOverrideReason" in body) ||
      typeof body.manualOverrideReason !== "string"
    )
      throw new Error("Expected only manualOverrideReason");
    reason = recoveryReason(body.manualOverrideReason);
  } catch (error) {
    return text(formatUserFacingErrorMessage(error, "Recovery request failed"), 400, rate.headers);
  }
  try {
    const result = await ctx.runAction(recoverRef, {
      attemptId: segments[0],
      actorUserId: auth.userId,
      apiTokenId: auth.apiTokenId,
      manualOverrideReason: reason,
    });
    return json(result, result.reused ? 200 : 202, rate.headers);
  } catch (error) {
    const message = formatUserFacingErrorMessage(error, "Recovery request failed");
    return text(message, message.includes("Publish attempt not found") ? 404 : 409, rate.headers);
  }
}
