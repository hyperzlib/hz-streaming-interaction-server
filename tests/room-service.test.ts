import { describe, expect, test, beforeEach } from "bun:test";
import { DataSource } from "typeorm";
import { RoomRegistry } from "../src/core/room-registry";
import { createRuleSet } from "../src/core/rule-set";
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
    RoomRegistry.register("temp", createRuleSet().enableTempUserName(true));
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

  test("requires room user name for anonymous join when temp names are enabled", async () => {
    const { dataSource, roomService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-1",
      isPublicRead: false,
      password: "secret",
    });

    await expect(roomService.joinRoom({ roomId, password: "secret" })).rejects.toThrow(
      "Room user name is required",
    );

    await dataSource.destroy();
  });

  test("uses normalized room user name hash and rejects duplicate active temp names", async () => {
    const { dataSource, roomService, sessionService } = await createTestRoomService();

    const { roomId } = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-1",
      isPublicRead: false,
      password: "secret",
    });

    const first = await roomService.joinRoom({
      roomId,
      password: "secret",
      roomUserName: "  Alice   Chen  ",
    });
    const firstSession = await sessionService.getSession(first.token);
    expect(firstSession?.roomUserName).toBe("Alice Chen");
    expect(firstSession?.roomUserId).toMatch(/^temp:[0-9a-f]{64}$/);

    await expect(roomService.joinRoom({
      roomId,
      password: "secret",
      roomUserName: "Alice Chen",
    })).rejects.toThrow("Room user name is already taken");

    await sessionService.deleteSession(first.token);
    const joinedAgain = await roomService.joinRoom({
      roomId,
      password: "secret",
      roomUserName: "Alice Chen",
    });
    expect((await sessionService.getSession(joinedAgain.token))?.roomUserId).toBe(firstSession?.roomUserId);

    await dataSource.destroy();
  });

  test("names are scoped by room and logged in users ignore room user name", async () => {
    const { dataSource, roomService, sessionService } = await createTestRoomService();

    const firstRoom = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-1",
      isPublicRead: false,
      password: "secret",
    });
    const secondRoom = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-2",
      isPublicRead: false,
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

    expect((await sessionService.getSession(first.token))?.roomUserId).not.toBe(
      (await sessionService.getSession(second.token))?.roomUserId,
    );
    const loggedInSession = await sessionService.getSession(loggedIn.token);
    expect(loggedInSession).toMatchObject({
      userId: "login-user",
      roomUserId: "user:login-user",
    });
    expect(loggedInSession?.roomUserName).toBeUndefined();

    await dataSource.destroy();
  });

  test("host can kick another session but not self", async () => {
    const { dataSource, roomService, sessionService, stateStore } = await createTestRoomService();

    const created = await roomService.createRoom({
      roomType: "temp",
      ownerId: "owner-1",
      isPublicRead: false,
      password: "secret",
    });
    const host = await sessionService.getSession(created.token);
    const joined = await roomService.joinRoom({
      roomId: created.roomId,
      password: "secret",
      roomUserName: "Alice",
    });
    const participant = await sessionService.getSession(joined.token);
    await stateStore.forRoom(created.roomId).members.set(participant!.sessionId, {
      sessionId: participant!.sessionId,
      role: "participant",
      roomUserId: participant!.roomUserId,
      roomUserName: participant!.roomUserName,
      joinedAt: 1,
      lastSeenAt: 1,
      presence: "online",
    });

    await expect(roomService.kickSession(participant!, host!.sessionId)).rejects.toThrow(
      "Only host can kick room users",
    );
    await expect(roomService.kickSession(host!, host!.sessionId)).rejects.toThrow(
      "Host cannot kick self",
    );

    const kicked = await roomService.kickSession(host!, participant!.sessionId);
    expect(kicked).toMatchObject({
      sessionId: participant!.sessionId,
      roomUserId: participant!.roomUserId,
      roomUserName: "Alice",
    });
    expect(await sessionService.getSession(joined.token)).toBeNull();
    expect(await stateStore.forRoom(created.roomId).members.get(participant!.sessionId)).toBeNull();

    const rejoined = await roomService.joinRoom({
      roomId: created.roomId,
      password: "secret",
      roomUserName: "Alice",
    });
    expect((await sessionService.getSession(rejoined.token))?.roomUserId).toBe(participant!.roomUserId);

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
