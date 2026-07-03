import { describe, expect, test, beforeEach } from "bun:test";
import { DataSource } from "typeorm";
import { RoomRegistry } from "../src/core/room-registry";
import { createRuleSet } from "../src/core/rule-set";
import { registerScoreRoom } from "../src/modules/score-room";
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
    registerScoreRoom();
    RoomRegistry.register("temp", createRuleSet().enableTempUserName(true));
  });

  test("creates score room with DB meta, Redis state, and host token", async () => {
    const { dataSource, roomService, sessionService, stateStore } = await createTestRoomService();

    const result = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      allowGuest: true,
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
      allowGuest: false,
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

  test("joins as guest when room allows guests", async () => {
    const { dataSource, roomService, sessionService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      allowGuest: true,
    });

    const joined = await roomService.joinRoom({ roomId });
    const session = await sessionService.getSession(joined.token);

    expect(session?.userId).toBeUndefined();
    expect(session?.roomUserId).toBe("guest");
    expect(session?.role).toBe("guest");

    await dataSource.destroy();
  });

  test("rejects guest join when room does not allow guests", async () => {
    const { dataSource, roomService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      allowGuest: false,
    });

    await expect(roomService.joinRoom({ roomId })).rejects.toThrow(
      "Room does not allow guests",
    );

    await dataSource.destroy();
  });

  test("guests join room with temp names enabled", async () => {
    const { dataSource, roomService, sessionService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-1",
      allowGuest: true,
      password: "secret",
    });

    const joined = await roomService.joinRoom({ roomId, password: "secret" });
    const session = await sessionService.getSession(joined.token);
    expect(session?.role).toBe("guest");
    expect(session?.roomUserId).toBe("guest");

    await dataSource.destroy();
  });

  test("guests bypass temp name system", async () => {
    const { dataSource, roomService, sessionService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-1",
      allowGuest: true,
      password: "secret",
    });

    const joined = await roomService.joinRoom({
      roomId,
      password: "secret",
      roomUserName: "Alice",
    });
    const session = await sessionService.getSession(joined.token);
    expect(session?.role).toBe("guest");
    expect(session?.roomUserId).toBe("guest");
    expect(session?.roomUserName).toBeUndefined();

    await dataSource.destroy();
  });

  test("guests share the same room user id across rooms", async () => {
    const { dataSource, roomService, sessionService } = await createTestRoomService();

    const firstRoom = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-1",
      allowGuest: true,
      password: "secret",
    });
    const secondRoom = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-2",
      allowGuest: true,
      password: "secret",
    });

    const first = await roomService.joinRoom({
      roomId: firstRoom.roomId,
      password: "secret",
      roomUserName: "Alice",
    });
    const second = await roomService.joinRoom({
      roomId: secondRoom.roomId,
      password: "secret",
      roomUserName: "Alice",
    });
    const loggedIn = await roomService.joinRoom({
      roomId: firstRoom.roomId,
      password: "secret",
      roomUserName: "Alice",
      userId: "login-user",
    });

    expect((await sessionService.getSession(first.token))?.role).toBe("guest");
    expect((await sessionService.getSession(first.token))?.roomUserId).toBe("guest");
    expect((await sessionService.getSession(second.token))?.role).toBe("guest");
    expect((await sessionService.getSession(second.token))?.roomUserId).toBe("guest");
    const loggedInSession = await sessionService.getSession(loggedIn.token);
    expect(loggedInSession).toMatchObject({
      userId: "login-user",
      roomUserId: "user:login-user",
    });
    expect(loggedInSession?.roomUserName).toBeUndefined();

    await dataSource.destroy();
  });

  test("host can kick a guest", async () => {
    const { dataSource, roomService, sessionService, stateStore } = await createTestRoomService();

    const created = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-1",
      allowGuest: true,
      password: "secret",
    });
    const host = await sessionService.getSession(created.token);
    const joined = await roomService.joinRoom({
      roomId: created.roomId,
      password: "secret",
      roomUserName: "Alice",
    });
    const guestSession = await sessionService.getSession(joined.token);
    await stateStore.forRoom(created.roomId).members.set(guestSession!.sessionId, {
      sessionId: guestSession!.sessionId,
      role: "guest",
      roomUserId: "guest",
      joinedAt: 1,
      lastSeenAt: 1,
      presence: "online",
    });

    await expect(roomService.kickSession(guestSession!, host!.sessionId)).rejects.toThrow(
      "Only host can kick room users",
    );
    await expect(roomService.kickSession(host!, host!.sessionId)).rejects.toThrow(
      "Host cannot kick self",
    );

    const kicked = await roomService.kickSession(host!, guestSession!.sessionId);
    expect(kicked).toMatchObject({
      sessionId: guestSession!.sessionId,
      roomUserId: "guest",
    });
    expect(await sessionService.getSession(joined.token)).toBeNull();
    expect(await stateStore.forRoom(created.roomId).members.get(guestSession!.sessionId)).toBeNull();

    await dataSource.destroy();
  });

  test("closes room with reason without overwriting first close", async () => {
    const { dataSource, roomService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      allowGuest: false,
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
      allowGuest: false,
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
