import { beforeEach, describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { createApp } from "../src/app";
import { RoomRegistry } from "../src/core/room-registry";
import { registerModules } from "../src/modules/score-room";
import { InProcessWsBroadcastProvider } from "../src/services/broadcast-provider";
import { AuthSessionService } from "../src/services/auth-session-service";
import { RoomService, createRoomRepository } from "../src/services/room-service";
import { SessionService } from "../src/services/session-service";
import { createUserRepository, UserService } from "../src/services/user-service";
import { createBunSqliteConnection } from "../src/storage/bun-sqlite-better-sqlite3";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomMetaEntity } from "../src/storage/room-meta.entity";
import { RoomStateStore } from "../src/storage/room-state-store";
import { UserEntity } from "../src/storage/user.entity";

async function createApiHarness() {
  const dataSource = await new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    driver: createBunSqliteConnection,
    synchronize: true,
    entities: [RoomMetaEntity, UserEntity],
  }).initialize();
  const redis = new MemoryRedisFacade();
  const stateStore = new RoomStateStore(redis);
  const sessionService = new SessionService(redis, 60);
  const authSessionService = new AuthSessionService(redis, 60);
  const userService = new UserService(createUserRepository(dataSource));
  const roomService = new RoomService(createRoomRepository(dataSource), stateStore, sessionService);
  const broadcastProvider = new InProcessWsBroadcastProvider(stateStore);
  const app = createApp({
    roomService,
    sessionService,
    stateStore,
    broadcastProvider,
    sockets: { commandUrl: "ws://localhost/ws/command" },
    auth: {
      oidcService: {} as never,
      authSessionService,
      userService,
    },
  });

  return {
    app,
    dataSource,
    sessionService,
    roomService,
    broadcastProvider,
    authSessionService,
    userService,
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

  test("create room uses authenticated user as owner and session user", async () => {
    const { app, authSessionService, dataSource, roomService, sessionService, userService } = await createApiHarness();
    await userService.upsertOidcUser({
      id: "login-user",
      displayName: "Login User",
      avatarUrl: null,
      email: null,
    });
    const authToken = await authSessionService.createSession("login-user");

    const response = await app.fetch(new Request("http://localhost/rooms/create", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        roomType: "score",
        ownerId: "spoofed-owner",
        isPublicRead: true,
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { roomId: string; token: string };
    const meta = await roomService.getRoomMeta(body.roomId);
    const session = await sessionService.getSession(body.token);
    expect(meta.ownerId).toBe("login-user");
    expect(session?.userId).toBe("login-user");
    expect(session?.roomUserId).toBe("user:login-user");

    await dataSource.destroy();
  });

  test("join room ignores body user id and uses auth or temporary room user id", async () => {
    const { app, authSessionService, dataSource, roomService, sessionService, userService } = await createApiHarness();
    const { roomId } = await roomService.createRoom({
      roomType: "score",
      ownerId: "owner-1",
      isPublicRead: false,
    });
    await userService.upsertOidcUser({
      id: "login-user",
      displayName: "Login User",
      avatarUrl: null,
      email: null,
    });
    const authToken = await authSessionService.createSession("login-user");

    const authedResponse = await app.fetch(new Request("http://localhost/rooms/join", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ roomId, userId: "spoofed-user" }),
    }));
    expect(authedResponse.status).toBe(200);
    const authedBody = await authedResponse.json() as { token: string };
    const authedSession = await sessionService.getSession(authedBody.token);
    expect(authedSession?.userId).toBe("login-user");
    expect(authedSession?.roomUserId).toBe("user:login-user");

    const anonymousResponse = await app.fetch(new Request("http://localhost/rooms/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, userId: "spoofed-user" }),
    }));
    expect(anonymousResponse.status).toBe(200);
    const anonymousBody = await anonymousResponse.json() as { token: string };
    const anonymousSession = await sessionService.getSession(anonymousBody.token);
    expect(anonymousSession?.userId).toBeUndefined();
    expect(anonymousSession?.roomUserId.startsWith("temp:")).toBe(true);

    await dataSource.destroy();
  });
});
