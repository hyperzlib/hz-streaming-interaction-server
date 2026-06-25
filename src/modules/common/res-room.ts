import { z } from "zod";
import { createRuleSet } from "../../core/rule-set";
import type { ResourceService } from "../../services/resource-service";
import type { EventContext } from "../../types";

export type ResResourceScope = "user" | "room";
export type ResReplaceScope = ResResourceScope;

export type ResRoomOptions = {
  resourceScope?: ResResourceScope;
  /** @deprecated Use resourceScope instead. */
  replaceScope?: ResResourceScope;
  publicVisible?: boolean;
  maxTtlSeconds?: number;
  allowInfiniteTtl?: boolean;
  prepareUploadPrecheck?: (
    ctx: EventContext,
    payload: ResPrepareUploadPayload,
  ) => Promise<void> | void;
};

export type ResStateEntry = {
  resourceKey: string;
  rawResourceKey: string;
  resourceId: string;
  url: string;
  uploaderSessionId: string;
  uploaderUserId?: string;
  updatedAt: number;
};

const RESOURCES_FIELD = "resources";
const DEFAULT_MAX_TTL_SECONDS = 86400;

const prepareUploadSchema = z.object({
  resourceKey: z.string().min(1),
  contentType: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
  ttlSeconds: z.number().int().positive().nullable().optional(),
});
export type ResPrepareUploadPayload = z.infer<typeof prepareUploadSchema>;

const finishUploadSchema = z.object({
  resourceId: z.string().min(1),
});

const deleteResourceSchema = z.object({
  resourceKey: z.string().min(1),
});

export function createResRoom(resourceService: ResourceService, opts: ResRoomOptions = {}) {
  const resourceScope = opts.resourceScope ?? opts.replaceScope ?? "user";
  const publicVisible = opts.publicVisible ?? false;
  const maxTtlSeconds = opts.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;

  return createRuleSet()
    .on("res:prepareUpload", async (ctx, payload, next) => {
      const data = prepareUploadSchema.parse(payload);
      await opts.prepareUploadPrecheck?.(ctx, data);

      const stateKey = makeStateKey(ctx, data.resourceKey, resourceScope);
      const ttlSeconds = data.ttlSeconds === null && opts.allowInfiniteTtl
        ? null
        : data.ttlSeconds ?? undefined;

      const prepared = await resourceService.prepareUpload({
        usedBy: roomUsedBy(ctx.roomId),
        resourceKey: data.resourceKey,
        stateKey,
        uploaderSessionId: ctx.session.sessionId,
        uploaderUserId: ctx.session.userId ?? null,
        contentType: data.contentType,
        size: data.size,
        ttlSeconds,
        maxTtlSeconds,
      });

      await next();
      await ctx.send({
        type: "res:uploadPrepared",
        payload: {
          resourceId: prepared.file.resourceId,
          resourceKey: stateKey,
          rawResourceKey: data.resourceKey,
          uploadUrl: prepared.upload.uploadUrl,
          method: prepared.upload.method,
          headers: prepared.upload.headers,
          expiresAt: prepared.upload.expiresAt,
        },
      });
    })
    .on("res:finishUpload", async (ctx, payload, next) => {
      const data = finishUploadSchema.parse(payload);
      const finished = await resourceService.finishUpload({
        resourceId: data.resourceId,
        usedBy: roomUsedBy(ctx.roomId),
        uploaderSessionId: ctx.session.sessionId,
      });

      const entry = resourceEntry(finished.file);
      const resources = await getResources(ctx);
      resources[entry.resourceKey] = entry;
      await ctx.state.fields.set(RESOURCES_FIELD, resources);

      await next();
      await ctx.send({
        type: "res:uploadFinished",
        payload: entry,
      });

      if (publicVisible) {
        await ctx.broadcast({
          type: "res:uploaded",
          payload: entry,
        });
      }
    })
    .on("res:delete", async (ctx, payload, next) => {
      const data = deleteResourceSchema.parse(payload);
      const stateKey = makeStateKey(ctx, data.resourceKey, resourceScope);
      const resources = await getResources(ctx);
      const entry = resources[stateKey];

      await resourceService.deleteByUsedByStateKey(roomUsedBy(ctx.roomId), stateKey);
      delete resources[stateKey];
      await ctx.state.fields.set(RESOURCES_FIELD, resources);

      const deletedPayload = {
        resourceKey: stateKey,
        rawResourceKey: entry?.rawResourceKey ?? data.resourceKey,
        resourceId: entry?.resourceId,
      };

      await next();
      await ctx.send({
        type: "res:deleted",
        payload: deletedPayload,
      });

      if (publicVisible) {
        await ctx.broadcast({
          type: "res:deleted",
          payload: deletedPayload,
        });
      }
    })
    .on("sys:userJoin", async (ctx, _payload, next) => {
      await next();
      if (!publicVisible) {
        return;
      }

      await ctx.send({
        type: "state:res",
        payload: {
          resources: await getResources(ctx),
        },
      });
    })
    .on("sys:roomClosed", async (ctx, _payload, next) => {
      await next();
      await resourceService.deleteByUsedBy(roomUsedBy(ctx.roomId));
    });
}

function makeStateKey(ctx: EventContext, resourceKey: string, resourceScope: ResResourceScope): string {
  if (resourceScope === "room") {
    return resourceKey;
  }
  return `${ctx.session.roomUserId}@${resourceKey}`;
}

function roomUsedBy(roomId: string): string {
  return `room/${roomId}`;
}

async function getResources(ctx: EventContext): Promise<Record<string, ResStateEntry>> {
  return await ctx.state.fields.get<Record<string, ResStateEntry>>(RESOURCES_FIELD, {});
}

function resourceEntry(file: {
  resourceKey: string;
  stateKey: string;
  resourceId: string;
  url: string | null;
  uploaderSessionId: string;
  uploaderUserId: string | null;
  uploadedAt: number | null;
}): ResStateEntry {
  return {
    resourceKey: file.stateKey,
    rawResourceKey: file.resourceKey,
    resourceId: file.resourceId,
    url: file.url ?? "",
    uploaderSessionId: file.uploaderSessionId,
    uploaderUserId: file.uploaderUserId ?? undefined,
    updatedAt: file.uploadedAt ?? Date.now(),
  };
}
