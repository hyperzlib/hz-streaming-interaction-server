import { describe, expect, test } from "bun:test";
import { executeRuleSet } from "../src/core/event-pipeline";
import { createResRoom, type ResStateEntry } from "../src/modules/common/res-room";
import type { ResourceService } from "../src/services/resource-service";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomStateStore } from "../src/storage/room-state-store";
import type { EventContext, RoomEvent } from "../src/types";

type ShortEvent = Omit<RoomEvent, "roomId" | "seq" | "timestamp">;

function context(sent: ShortEvent[] = [], broadcasted: ShortEvent[] = []): EventContext {
  return {
    roomId: "room-1",
    roomMeta: {
      roomId: "room-1",
      roomType: "score",
      ownerId: "owner",
      isPublicRead: false,
      createdAt: 1,
    },
    session: {
      sessionId: "session-1",
      roomId: "room-1",
      role: "participant",
      roomUserId: "user:user-1",
      userId: "user-1",
    },
    state: new RoomStateStore(new MemoryRedisFacade()).forRoom("room-1"),
    send: async (event) => {
      sent.push(event);
    },
    broadcast: async (event) => {
      broadcasted.push(event);
    },
  };
}

function resourceServiceStub() {
  const calls: string[] = [];
  const service = {
    async prepareUpload(input: { resourceKey: string; stateKey: string; usedBy: string }) {
      calls.push(`prepare:${input.usedBy}:${input.stateKey}`);
      return {
        file: {
          resourceId: "res-1",
        },
        upload: {
          uploadUrl: "http://localhost/api/res/upload?x=1",
          method: "PUT",
          headers: {},
          expiresAt: 2000,
        },
      };
    },
    async finishUpload(input: { resourceId: string; usedBy: string; uploaderSessionId: string }) {
      calls.push(`finish:${input.usedBy}:${input.uploaderSessionId}`);
      return {
        file: {
          resourceKey: "avatar",
          stateKey: "user:user-1@avatar",
          resourceId: input.resourceId,
          url: "http://localhost/api/res/files/res-1",
          uploaderSessionId: input.uploaderSessionId,
          uploaderUserId: "user-1",
          uploadedAt: 3000,
        },
        replaced: [],
      };
    },
    async deleteByUsedBy(usedBy: string) {
      calls.push(`delete:${usedBy}`);
      return [];
    },
    async deleteByUsedByStateKey(usedBy: string, stateKey: string) {
      calls.push(`deleteKey:${usedBy}:${stateKey}`);
      return [];
    },
  };
  return { calls, service: service as unknown as ResourceService };
}

describe("createResRoom", () => {
  test("prepares upload with room user-prefixed state key", async () => {
    const sent: ShortEvent[] = [];
    const { calls, service } = resourceServiceStub();
    const ctx = context(sent);
    const rules = createResRoom(service);

    await executeRuleSet(rules, "res:prepareUpload", ctx, { resourceKey: "avatar" });

    expect(calls).toEqual(["prepare:room/room-1:user:user-1@avatar"]);
    expect(sent).toEqual([
      {
        type: "res:uploadPrepared",
        payload: expect.objectContaining({
          resourceId: "res-1",
          resourceKey: "user:user-1@avatar",
          rawResourceKey: "avatar",
          method: "PUT",
        }),
      },
    ]);
  });

  test("uses temporary room user id for user-scoped resources without login user id", async () => {
    const sent: ShortEvent[] = [];
    const { calls, service } = resourceServiceStub();
    const ctx = context(sent);
    ctx.session.userId = undefined;
    ctx.session.roomUserId = "temp:anon-1";

    await executeRuleSet(createResRoom(service), "res:prepareUpload", ctx, { resourceKey: "avatar" });

    expect(calls).toEqual(["prepare:room/room-1:temp:anon-1@avatar"]);
  });

  test("uses raw resource key for room-scoped resources", async () => {
    const { calls, service } = resourceServiceStub();

    await executeRuleSet(
      createResRoom(service, { resourceScope: "room" }),
      "res:prepareUpload",
      context(),
      { resourceKey: "avatar" },
    );

    expect(calls).toEqual(["prepare:room/room-1:avatar"]);
  });

  test("runs prepareUploadPrecheck with event context and parsed payload before preparing", async () => {
    const sent: ShortEvent[] = [];
    const { calls, service } = resourceServiceStub();
    const ctx = context(sent);
    const seen: unknown[] = [];

    await executeRuleSet(
      createResRoom(service, {
        prepareUploadPrecheck: (eventCtx, payload) => {
          seen.push(eventCtx.roomId, eventCtx.session.sessionId, payload);
        },
      }),
      "res:prepareUpload",
      ctx,
      { resourceKey: "avatar", contentType: "image/png", size: 12 },
    );

    expect(seen).toEqual([
      "room-1",
      "session-1",
      { resourceKey: "avatar", contentType: "image/png", size: 12 },
    ]);
    expect(calls).toEqual(["prepare:room/room-1:user:user-1@avatar"]);
  });

  test("does not prepare upload when prepareUploadPrecheck rejects", async () => {
    const { calls, service } = resourceServiceStub();

    await expect(executeRuleSet(
      createResRoom(service, {
        prepareUploadPrecheck: () => {
          throw new Error("resource key is not allowed");
        },
      }),
      "res:prepareUpload",
      context(),
      { resourceKey: "blocked" },
    )).rejects.toThrow("resource key is not allowed");

    expect(calls).toEqual([]);
  });

  test("finishes upload, writes state, sends ack, and broadcasts when public", async () => {
    const sent: ShortEvent[] = [];
    const broadcasted: ShortEvent[] = [];
    const { service } = resourceServiceStub();
    const ctx = context(sent, broadcasted);

    await executeRuleSet(
      createResRoom(service, { publicVisible: true }),
      "res:finishUpload",
      ctx,
      { resourceId: "res-1" },
    );

    const resources = await ctx.state.fields.get<Record<string, ResStateEntry>>("resources", {});
    expect(resources["user:user-1@avatar"]).toMatchObject({
      resourceKey: "user:user-1@avatar",
      rawResourceKey: "avatar",
      resourceId: "res-1",
    });
    expect(sent.map((event) => event.type)).toEqual(["res:uploadFinished"]);
    expect(broadcasted).toEqual([
      {
        type: "res:uploaded",
        payload: expect.objectContaining({ resourceKey: "user:user-1@avatar" }),
      },
    ]);
  });

  test("deletes user-scoped resources using the current room user id", async () => {
    const sent: ShortEvent[] = [];
    const broadcasted: ShortEvent[] = [];
    const { calls, service } = resourceServiceStub();
    const ctx = context(sent, broadcasted);
    await ctx.state.fields.set("resources", {
      "user:user-1@avatar": {
        resourceKey: "user:user-1@avatar",
        rawResourceKey: "avatar",
        resourceId: "res-1",
        url: "http://localhost/api/res/files/res-1",
        uploaderSessionId: "session-1",
        uploaderUserId: "user-1",
        updatedAt: 3000,
      },
      "user:user-2@avatar": {
        resourceKey: "user:user-2@avatar",
        rawResourceKey: "avatar",
        resourceId: "res-2",
        url: "http://localhost/api/res/files/res-2",
        uploaderSessionId: "session-2",
        uploaderUserId: "user-2",
        updatedAt: 3000,
      },
    });

    await executeRuleSet(
      createResRoom(service, { publicVisible: true }),
      "res:delete",
      ctx,
      { resourceKey: "avatar" },
    );

    expect(calls).toEqual(["deleteKey:room/room-1:user:user-1@avatar"]);
    expect(await ctx.state.fields.get("resources", {})).toEqual({
      "user:user-2@avatar": expect.any(Object),
    });
    expect(sent).toEqual([
      {
        type: "res:deleted",
        payload: {
          resourceKey: "user:user-1@avatar",
          rawResourceKey: "avatar",
          resourceId: "res-1",
        },
      },
    ]);
    expect(broadcasted).toEqual([
      {
        type: "res:deleted",
        payload: {
          resourceKey: "user:user-1@avatar",
          rawResourceKey: "avatar",
          resourceId: "res-1",
        },
      },
    ]);
  });

  test("deletes room-scoped resources using the raw resource key", async () => {
    const { calls, service } = resourceServiceStub();
    const ctx = context();
    await ctx.state.fields.set("resources", {
      avatar: {
        resourceKey: "avatar",
        rawResourceKey: "avatar",
        resourceId: "res-1",
        url: "http://localhost/api/res/files/res-1",
        uploaderSessionId: "session-1",
        uploaderUserId: "user-1",
        updatedAt: 3000,
      },
    });

    await executeRuleSet(
      createResRoom(service, { resourceScope: "room" }),
      "res:delete",
      ctx,
      { resourceKey: "avatar" },
    );

    expect(calls).toEqual(["deleteKey:room/room-1:avatar"]);
    expect(await ctx.state.fields.get("resources", {})).toEqual({});
  });

  test("sends current resources on join only when public", async () => {
    const sent: ShortEvent[] = [];
    const { service } = resourceServiceStub();
    const ctx = context(sent);
    await ctx.state.fields.set("resources", {
      "user:user-1@avatar": { resourceKey: "user:user-1@avatar", rawResourceKey: "avatar" },
    });

    await executeRuleSet(createResRoom(service, { publicVisible: true }), "sys:userJoin", ctx, {});

    expect(sent).toEqual([
      {
        type: "state:res",
        payload: {
          resources: {
            "user:user-1@avatar": { resourceKey: "user:user-1@avatar", rawResourceKey: "avatar" },
          },
        },
      },
    ]);
  });

  test("cleans room resources on room close", async () => {
    const { calls, service } = resourceServiceStub();

    await executeRuleSet(createResRoom(service), "sys:roomClosed", context(), {});

    expect(calls).toEqual(["delete:room/room-1"]);
  });
});
