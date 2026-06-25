import { describe, expect, test } from "bun:test";
import { SessionService } from "../src/services/session-service";
import { MemoryRedisFacade } from "../src/storage/redis-facade";

describe("SessionService", () => {
  test("creates and reads stateful random token sessions", async () => {
    const redis = new MemoryRedisFacade();
    const service = new SessionService(redis, 60);

    const { token, session } = await service.createSession({
      roomId: "room-1",
      role: "host",
      roomUserId: "user:user-1",
      userId: "user-1",
    });

    expect(token.length).toBeGreaterThan(20);
    expect(await service.getSession(token)).toEqual(session);
    expect(await service.getRoomSessions("room-1")).toEqual([session]);
  });

  test("deletes sessions from room index by token or session id", async () => {
    const redis = new MemoryRedisFacade();
    const service = new SessionService(redis, 60);

    const first = await service.createSession({
      roomId: "room-1",
      role: "participant",
      roomUserId: "temp:first",
    });
    const second = await service.createSession({
      roomId: "room-1",
      role: "participant",
      roomUserId: "temp:second",
    });

    await service.deleteSession(first.token);
    expect(await service.getRoomSessions("room-1")).toEqual([second.session]);

    expect(await service.deleteRoomSession("room-1", second.session.sessionId)).toEqual(second.session);
    expect(await service.getSession(second.token)).toBeNull();
    expect(await service.getRoomSessions("room-1")).toEqual([]);
  });

  test("honors ttl through redis facade", async () => {
    const redis = new MemoryRedisFacade();
    const service = new SessionService(redis, 0.001);
    const { token } = await service.createSession({
      roomId: "room-1",
      role: "participant",
      roomUserId: "temp:anon-1",
    });

    await Bun.sleep(5);

    expect(await service.getSession(token)).toBeNull();
    expect(await service.getRoomSessions("room-1")).toEqual([]);
  });
});
