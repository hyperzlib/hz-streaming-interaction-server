import { describe, expect, test, beforeEach } from "bun:test";
import { DataSource } from "typeorm";
import { RoomRegistry } from "../src/core/room-registry";
import { registerModules } from "../src/modules/score-room";
import { RoomService, createRoomRepository } from "../src/services/room-service";
import { SessionService } from "../src/services/session-service";
import { RoomMetaEntity } from "../src/storage/room-meta.entity";
import { createBunSqliteConnection } from "../src/storage/bun-sqlite-better-sqlite3";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomStateStore } from "../src/storage/room-state-store";

async function createTestRoomService() {
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
  return {
    dataSource,
    stateStore,
    sessionService,
    roomService: new RoomService(createRoomRepository(dataSource), stateStore, sessionService),
  };
}

describe("RoomService", () => {
  beforeEach(() => {
    RoomRegistry.clear();
    registerModules();
  });

  test("creates score room with DB meta, Redis state, and host token", async () => {
    const { dataSource, roomService, sessionService, stateStore } = await createTestRoomService();

    const result = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      isPublicRead: true,
    });

    const meta = await roomService.getRoomMeta(result.roomId);
    const state = await stateStore.getRoomState(result.roomId);
    const session = await sessionService.getSession(result.token);

    expect(meta.roomType).toBe("score");
    expect(meta.ownerId).toBe("owner-1");
    expect(state).toEqual({ members: {} });
    expect(session?.role).toBe("host");
    expect(session?.roomId).toBe(result.roomId);
    expect(session?.userId).toBe("owner-1");
    expect(session?.roomUserId).toBe("user:owner-1");

    await dataSource.destroy();
  });

  test("rejects invalid password and accepts correct password", async () => {
    const { dataSource, roomService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      isPublicRead: false,
      password: "secret",
    });

    await expect(roomService.joinRoom({ roomId, password: "wrong" })).rejects.toThrow(
      "Invalid room password",
    );

    const joined = await roomService.joinRoom({
      roomId,
      userId: "user-1",
      password: "secret",
    });
    expect(joined.token.length).toBeGreaterThan(20);

    await dataSource.destroy();
  });

  test("creates temporary room user id when joining without login user id", async () => {
    const { dataSource, roomService, sessionService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      isPublicRead: false,
    });

    const joined = await roomService.joinRoom({ roomId });
    const session = await sessionService.getSession(joined.token);

    expect(session?.userId).toBeUndefined();
    expect(session?.roomUserId.startsWith("temp:")).toBe(true);

    await dataSource.destroy();
  });

  test("closes room with reason without overwriting first close", async () => {
    const { dataSource, roomService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      isPublicRead: false,
    });

    await roomService.closeRoom(roomId, "manual", 1000);
    await roomService.closeRoom(roomId, "empty_room", 2000);

    const meta = await roomService.getRoomMeta(roomId);
    expect(meta.closedAt).toBe(1000);
    expect(meta.closedReason).toBe("manual");

    await dataSource.destroy();
  });

  test("deletes closed room metadata and Redis state", async () => {
    const { dataSource, roomService, stateStore } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      isPublicRead: false,
    });
    await stateStore.nextSeq(roomId);
    await roomService.closeRoom(roomId, "manual", 1000);
    await roomService.deleteRoom(roomId);

    await expect(roomService.getRoomMeta(roomId)).rejects.toThrow("Room not found");
    expect(await stateStore.getRoomState(roomId)).toEqual({ members: {} });
    expect(await stateStore.nextSeq(roomId)).toBe(1);

    await dataSource.destroy();
  });
});
