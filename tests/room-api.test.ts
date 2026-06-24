import { beforeEach, describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { createApp } from "../src/app";
import { RoomRegistry } from "../src/core/room-registry";
import { registerModules } from "../src/modules/score-room";
import { InProcessWsBroadcastProvider } from "../src/services/broadcast-provider";
import { RoomService, createRoomRepository } from "../src/services/room-service";
import { SessionService } from "../src/services/session-service";
import { createBunSqliteConnection } from "../src/storage/bun-sqlite-better-sqlite3";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomMetaEntity } from "../src/storage/room-meta.entity";
import { RoomStateStore } from "../src/storage/room-state-store";

async function createApiHarness() {
  const dataSource = await new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    driver: createBunSqliteConnection,
    synchronize: true,
    entities: [RoomMetaEntity],
  }).initialize();
  const redis = new MemoryRedisFacade();
  const stateStore = new RoomStateStore(redis);
  const sessionService = new SessionService(redis, 60);
  const roomService = new RoomService(createRoomRepository(dataSource), stateStore, sessionService);
  const broadcastProvider = new InProcessWsBroadcastProvider(stateStore);
  const app = createApp({
    roomService,
    sessionService,
    stateStore,
    broadcastProvider,
    sockets: { commandUrl: "ws://localhost/ws/command" },
  });

  return {
    app,
    dataSource,
    roomService,
    broadcastProvider,
  };
}

describe("Room API", () => {
  beforeEach(() => {
    RoomRegistry.clear();
    registerModules();
  });

  test("manual close broadcasts sys:roomClosed instead of sys:willShutdown", async () => {
    const { app, dataSource, roomService, broadcastProvider } = await createApiHarness();
    const { roomId, token } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      isPublicRead: false,
    });
    const messages: string[] = [];
    broadcastProvider.addSocket(roomId, { send: (data) => messages.push(data) });

    const response = await app.fetch(new Request(`http://localhost/rooms/${roomId}/close`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const events = messages.map((message) => JSON.parse(message));
    expect(events.map((event) => event.type)).toEqual(["sys:roomClosed"]);
    expect(events[0].payload).toMatchObject({
      roomId,
      reason: "manual",
    });
    expect(typeof events[0].payload.closedAt).toBe("number");
    expect((await roomService.getRoomMeta(roomId)).closedReason).toBe("manual");

    await dataSource.destroy();
  });
});
