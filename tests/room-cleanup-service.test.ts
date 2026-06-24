import { beforeEach, describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { RoomRegistry } from "../src/core/room-registry";
import { registerModules } from "../src/modules/score-room";
import { InProcessWsBroadcastProvider } from "../src/services/broadcast-provider";
import { RoomCleanupService, type RoomCleanupConfig } from "../src/services/room-cleanup-service";
import { RoomService, createRoomRepository } from "../src/services/room-service";
import { SessionService } from "../src/services/session-service";
import { createBunSqliteConnection } from "../src/storage/bun-sqlite-better-sqlite3";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomMetaEntity } from "../src/storage/room-meta.entity";
import { RoomStateStore } from "../src/storage/room-state-store";
import type { RoomStateSnapshot } from "../src/types";

const cleanupConfig: RoomCleanupConfig = {
  ownerOfflineGraceSeconds: 1200,
  emptyRoomGraceSeconds: 120,
  closedRoomRetentionSeconds: 1800,
  scanIntervalSeconds: 30,
};

async function createCleanupHarness(nowRef = { value: 0 }) {
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
  const cleanupService = new RoomCleanupService(
    roomService,
    stateStore,
    broadcastProvider,
    cleanupConfig,
    () => nowRef.value,
  );

  return {
    dataSource,
    stateStore,
    roomService,
    cleanupService,
    nowRef,
  };
}

describe("RoomCleanupService", () => {
  beforeEach(() => {
    RoomRegistry.clear();
    registerModules();
  });

  test("closes room when owner has been offline past grace", async () => {
    const { dataSource, roomService, stateStore, cleanupService, nowRef } = await createCleanupHarness({ value: 1201_000 });
    const { roomId } = await roomService.createRoom({ roomType: "score", ownerId: "owner-1", isPublicRead: false });
    await stateStore.setRoomState(roomId, {
      members: {
        host: {
          sessionId: "host",
          role: "host",
          userId: "owner-1",
          joinedAt: 0,
          lastSeenAt: 0,
          presence: "offline",
        },
        participant: {
          sessionId: "participant",
          role: "participant",
          userId: "user-1",
          joinedAt: 0,
          lastSeenAt: nowRef.value,
          presence: "online",
        },
      },
    });

    await cleanupService.scanOnce();

    const meta = await roomService.getRoomMeta(roomId);
    expect(meta.closedReason).toBe("owner_offline");
    expect(meta.closedAt).toBe(nowRef.value);

    await dataSource.destroy();
  });

  test("keeps room open when owner offline grace has not elapsed", async () => {
    const { dataSource, roomService, stateStore, cleanupService } = await createCleanupHarness({ value: 1199_000 });
    const { roomId } = await roomService.createRoom({ roomType: "score", ownerId: "owner-1", isPublicRead: false });
    await stateStore.setRoomState(roomId, {
      members: {
        host: {
          sessionId: "host",
          role: "host",
          userId: "owner-1",
          joinedAt: 0,
          lastSeenAt: 0,
          presence: "offline",
        },
      },
    });

    await cleanupService.scanOnce();

    const meta = await roomService.getRoomMeta(roomId);
    expect(meta.closedAt).toBeNull();

    await dataSource.destroy();
  });

  test("closes room only after empty room grace elapses", async () => {
    const nowRef = { value: 1000 };
    const { dataSource, roomService, cleanupService } = await createCleanupHarness(nowRef);
    const { roomId } = await roomService.createRoom({ roomType: "score", ownerId: "owner-1", isPublicRead: true });

    await cleanupService.scanOnce();
    expect((await roomService.getRoomMeta(roomId)).closedAt).toBeNull();

    nowRef.value += 119_000;
    await cleanupService.scanOnce();
    expect((await roomService.getRoomMeta(roomId)).closedAt).toBeNull();

    nowRef.value += 1_000;
    await cleanupService.scanOnce();
    const meta = await roomService.getRoomMeta(roomId);
    expect(meta.closedReason).toBe("empty_room");
    expect(meta.closedAt).toBe(nowRef.value);

    await dataSource.destroy();
  });

  test("clears empty room timer when a member joins again", async () => {
    const nowRef = { value: 1000 };
    const { dataSource, roomService, stateStore, cleanupService } = await createCleanupHarness(nowRef);
    const { roomId } = await roomService.createRoom({ roomType: "score", ownerId: "owner-1", isPublicRead: false });

    await cleanupService.scanOnce();
    nowRef.value += 60_000;
    await stateStore.setRoomState(roomId, {
      members: {
        host: {
          sessionId: "host",
          role: "host",
          userId: "owner-1",
          joinedAt: nowRef.value,
          lastSeenAt: nowRef.value,
          presence: "online",
        },
      },
    });
    await cleanupService.scanOnce();

    await stateStore.setRoomState(roomId, { members: {} });
    await cleanupService.scanOnce();
    nowRef.value += 119_000;
    await cleanupService.scanOnce();
    expect((await roomService.getRoomMeta(roomId)).closedAt).toBeNull();

    nowRef.value += 1_000;
    await cleanupService.scanOnce();
    expect((await roomService.getRoomMeta(roomId)).closedReason).toBe("empty_room");

    await dataSource.destroy();
  });

  test("deletes closed rooms after retention", async () => {
    const { dataSource, roomService, stateStore, cleanupService, nowRef } = await createCleanupHarness({ value: 1801_000 });
    const { roomId } = await roomService.createRoom({ roomType: "score", ownerId: "owner-1", isPublicRead: false });
    await stateStore.nextSeq(roomId);
    await roomService.closeRoom(roomId, "manual", 0);

    await cleanupService.deleteExpiredOnce();

    await expect(roomService.getRoomMeta(roomId)).rejects.toThrow("Room not found");
    expect(await stateStore.getRoomState(roomId)).toEqual({ members: {} } satisfies RoomStateSnapshot);
    expect(await stateStore.nextSeq(roomId)).toBe(1);
    expect(nowRef.value).toBe(1801_000);

    await dataSource.destroy();
  });
});
