import { normalizeContentType } from "clawhub-schema";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./functions";
import { MAX_PUBLISH_FILE_BYTES } from "./lib/publishLimits";
import { validateFilePath } from "./lib/skillZip";
import { matchesStorageSha256 } from "./lib/storageDigests";

const SKILL_PUBLISH_UPLOAD_TTL_MS = 60 * 60_000;

function assertExpectedUpload(args: {
  path: string;
  size: number;
  sha256: string;
  contentType?: string;
}) {
  if (!validateFilePath(args.path)) throw new Error("Invalid upload path");
  if (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > MAX_PUBLISH_FILE_BYTES) {
    throw new Error(`Upload must be at most ${MAX_PUBLISH_FILE_BYTES} bytes`);
  }
  if (!/^[a-f0-9]{64}$/i.test(args.sha256)) throw new Error("Invalid upload SHA-256");
}

export const createSkillPublishUploadInternal = internalMutation({
  args: {
    userId: v.id("users"),
    path: v.string(),
    size: v.number(),
    sha256: v.string(),
    contentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.deletedAt || user.deactivatedAt) throw new Error("User not found");
    assertExpectedUpload(args);
    const now = Date.now();
    const expiresAt = now + SKILL_PUBLISH_UPLOAD_TTL_MS;
    const uploadTicket = await ctx.db.insert("skillPublishUploadTickets", {
      userId: args.userId,
      path: args.path,
      size: args.size,
      sha256: args.sha256.toLowerCase(),
      contentType: normalizeContentType(args.contentType),
      createdAt: now,
      expiresAt,
    });
    await ctx.scheduler.runAt(
      expiresAt,
      internal.skillPublishUploads.cleanupSkillPublishUploadInternal,
      { uploadTicket },
    );
    return { uploadTicket };
  },
});

export const getSkillPublishUploadForUserInternal = internalQuery({
  args: {
    userId: v.id("users"),
    uploadTicket: v.id("skillPublishUploadTickets"),
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.uploadTicket);
    if (
      !ticket ||
      ticket.userId !== args.userId ||
      ticket.usedAt ||
      ticket.storageId ||
      ticket.expiresAt <= Date.now()
    ) {
      throw new Error("Skill upload ticket is missing, used, or expired");
    }
    return {
      path: ticket.path,
      size: ticket.size,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
    };
  },
});

export const attachSkillPublishUploadInternal = internalMutation({
  args: {
    userId: v.id("users"),
    uploadTicket: v.id("skillPublishUploadTickets"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.uploadTicket);
    const now = Date.now();
    if (
      !ticket ||
      ticket.userId !== args.userId ||
      ticket.usedAt ||
      ticket.storageId ||
      ticket.expiresAt <= now
    ) {
      throw new Error("Skill upload ticket is missing, used, or expired");
    }
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (
      !metadata ||
      metadata._creationTime < ticket.createdAt ||
      metadata.size !== ticket.size ||
      !matchesStorageSha256(metadata.sha256, ticket.sha256) ||
      normalizeContentType(metadata.contentType) !== ticket.contentType
    ) {
      throw new Error("Uploaded file does not match its skill upload ticket");
    }
    await ctx.db.patch(ticket._id, { storageId: args.storageId });
  },
});

type SkillPublishFile = {
  path: string;
  size: number;
  storageId: Id<"_storage">;
  sha256: string;
  contentType?: string;
};

export async function consumeSkillPublishUploads(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    uploadTickets: Id<"skillPublishUploadTickets">[];
    files: SkillPublishFile[];
  },
) {
  if (args.uploadTickets.length !== args.files.length) {
    throw new Error("Every directly uploaded skill file requires an upload ticket");
  }
  if (new Set(args.uploadTickets).size !== args.uploadTickets.length) {
    throw new Error("Skill upload tickets cannot be reused");
  }
  const now = Date.now();
  for (let index = 0; index < args.files.length; index += 1) {
    const uploadTicket = args.uploadTickets[index];
    const file = args.files[index];
    if (!uploadTicket || !file) throw new Error("Skill upload ticket mismatch");
    const ticket = await ctx.db.get(uploadTicket);
    if (
      !ticket ||
      ticket.userId !== args.userId ||
      ticket.usedAt ||
      ticket.expiresAt <= now ||
      ticket.storageId !== file.storageId ||
      ticket.path !== file.path ||
      ticket.size !== file.size ||
      ticket.sha256 !== file.sha256.toLowerCase() ||
      ticket.contentType !== normalizeContentType(file.contentType)
    ) {
      throw new Error("Skill upload ticket does not match this publish");
    }
    await ctx.db.patch(ticket._id, { usedAt: now });
  }
}

export const cleanupSkillPublishUploadInternal = internalMutation({
  args: { uploadTicket: v.id("skillPublishUploadTickets") },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.uploadTicket);
    if (!ticket) return { deleted: false };
    if (!ticket.usedAt && ticket.storageId) {
      await ctx.storage.delete(ticket.storageId);
    }
    await ctx.db.delete(ticket._id);
    return { deleted: true };
  },
});
