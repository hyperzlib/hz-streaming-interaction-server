import { beforeEach, describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { createApp } from "../src/app";
import { RoomRegistry } from "../src/core/room-registry";
import { registerScoreRoom } from "../src/modules/score-room";
import { InProcessWsBroadcastProvider } from "../src/services/broadcast-provider";
import { AuthSessionService } from "../src/services/auth-session-service";
import { createRoomRepository, RoomService } from "../src/services/room-service";
import { SessionService } from "../src/services/session-service";
import { createUserRepository, UserService } from "../src/services/user-service";
import { createBunSqliteConnection } from "../src/storage/bun-sqlite-better-sqlite3";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomMetaEntity } from "../src/storage/room-meta.entity";
import { RoomStateStore } from "../src/storage/room-state-store";
import { UserEntity } from "../src/storage/user.entity";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
    frontend: { allowedOrigins: [] },
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAuthToken(userService: UserService, authSessionService: AuthSessionService, userId: string, displayName = "Test User") {
  await userService.upsertOidcUser({ id: userId, displayName, avatarUrl: null, email: null });
  return await authSessionService.createSession(userId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Room API", () => {
  beforeEach(() => {
    RoomRegistry.clear();
    registerScoreRoom();
  });

  // -- GET /rooms/:id/info --------------------------------------------------

  describe("GET /rooms/:id/info", () => {
    test("returns public info for an open room", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomId}/info`));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        roomId,
        roomType: "score",
        hasPassword: false,
        isClosed: false,
      });
      expect(typeof body.createdAt).toBe("number");

      await dataSource.destroy();
    });

    test("returns info for a password-protected room", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
        password: "secret",
      });

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomId}/info`));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ hasPassword: true, isClosed: false });

      await dataSource.destroy();
    });

    test("marks a closed room", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });
      await roomService.closeRoom(roomId, "manual");

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomId}/info`));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ isClosed: true });

      await dataSource.destroy();
    });

    test("returns 404 for unknown room", async () => {
      const { app, dataSource } = await createApiHarness();

      const res = await app.fetch(new Request("http://localhost/api/rooms/unknown-room/info"));

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("ROOM_NOT_FOUND");

      await dataSource.destroy();
    });
  });

  // -- POST /rooms/create ---------------------------------------------------

  describe("POST /rooms/create", () => {
    test("creates a room with authenticated user as owner", async () => {
      const { app, authSessionService, dataSource, roomService, userService } = await createApiHarness();
      const authToken = await createAuthToken(userService, authSessionService, "login-user");

      const res = await app.fetch(new Request("http://localhost/api/rooms/create", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ roomType: "score", allowGuest: true }),
      }));

      expect(res.status).toBe(200);
      const body = await res.json() as { roomId: string; token: string; sockets: { commandUrl: string } };
      expect(body.roomId).toBeTruthy();
      expect(body.token).toBeTruthy();
      expect(body.sockets.commandUrl).toBe("ws://localhost/ws/command");

      const meta = await roomService.getRoomMeta(body.roomId);
      expect(meta.ownerId).toBe("login-user");
      expect(meta.allowGuest).toBe(true);

      await dataSource.destroy();
    });

    test("ignores a spoofed ownerId from the request body", async () => {
      const { app, authSessionService, dataSource, roomService, userService } = await createApiHarness();
      const authToken = await createAuthToken(userService, authSessionService, "login-user");

      const res = await app.fetch(new Request("http://localhost/api/rooms/create", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          roomType: "score",
          ownerId: "spoofed-owner",
          allowGuest: true,
        }),
      }));

      expect(res.status).toBe(200);
      const body = await res.json() as { roomId: string };
      const meta = await roomService.getRoomMeta(body.roomId);
      expect(meta.ownerId).toBe("login-user");

      await dataSource.destroy();
    });

    test("returns 401 when no auth token is provided", async () => {
      const { app, dataSource } = await createApiHarness();

      const res = await app.fetch(new Request("http://localhost/api/rooms/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomType: "score", allowGuest: true }),
      }));

      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHORIZED");

      await dataSource.destroy();
    });

    test("returns 400 for unknown room type", async () => {
      const { app, authSessionService, dataSource, userService } = await createApiHarness();
      const authToken = await createAuthToken(userService, authSessionService, "login-user");

      const res = await app.fetch(new Request("http://localhost/api/rooms/create", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ roomType: "nonexistent" }),
      }));

      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("UNKNOWN_ROOM_TYPE");

      await dataSource.destroy();
    });

    test("returns validation error for missing roomType", async () => {
      const { app, authSessionService, dataSource, userService } = await createApiHarness();
      const authToken = await createAuthToken(userService, authSessionService, "login-user");

      const res = await app.fetch(new Request("http://localhost/api/rooms/create", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }));

      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");

      await dataSource.destroy();
    });
  });

  // -- POST /rooms/join -----------------------------------------------------

  describe("POST /rooms/join", () => {
    test("joins with authenticated user id ignoring spoofed userId", async () => {
      const { app, authSessionService, dataSource, roomService, sessionService, userService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });
      const authToken = await createAuthToken(userService, authSessionService, "login-user");

      const res = await app.fetch(new Request("http://localhost/api/rooms/join", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ roomId, userId: "spoofed-user" }),
      }));

      expect(res.status).toBe(200);
      const body = await res.json() as { token: string };
      const session = await sessionService.getSession(body.token);
      expect(session?.userId).toBe("login-user");
      expect(session?.roomUserId).toBe("user:login-user");

      await dataSource.destroy();
    });

    test("joins as guest when not authenticated and room allows guests", async () => {
      const { app, dataSource, roomService, sessionService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: true,
      });

      const res = await app.fetch(new Request("http://localhost/api/rooms/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId }),
      }));

      expect(res.status).toBe(200);
      const body = await res.json() as { token: string };
      const session = await sessionService.getSession(body.token);
      expect(session?.userId).toBeUndefined();
      expect(session?.roomUserId).toBe("guest");
      expect(session?.role).toBe("guest");

      await dataSource.destroy();
    });

    test("rejects anonymous join when room does not allow guests", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });

      const res = await app.fetch(new Request("http://localhost/api/rooms/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId }),
      }));

      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("GUEST_NOT_ALLOWED");

      await dataSource.destroy();
    });

    test("joins with correct password", async () => {
      const { app, dataSource, roomService, sessionService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: true,
        password: "secret",
      });

      const res = await app.fetch(new Request("http://localhost/api/rooms/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId, password: "secret" }),
      }));

      expect(res.status).toBe(200);
      expect((await sessionService.getSession((await res.json()).token))).toBeTruthy();

      await dataSource.destroy();
    });

    test("returns 401 for wrong password", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
        password: "secret",
      });

      const res = await app.fetch(new Request("http://localhost/api/rooms/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId, password: "wrong" }),
      }));

      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("INVALID_ROOM_PASSWORD");

      await dataSource.destroy();
    });

    test("returns 410 when joining a closed room", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });
      await roomService.closeRoom(roomId, "manual");

      const res = await app.fetch(new Request("http://localhost/api/rooms/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId }),
      }));

      expect(res.status).toBe(410);
      expect((await res.json()).error.code).toBe("ROOM_CLOSED");

      await dataSource.destroy();
    });

    test("returns 404 for unknown room", async () => {
      const { app, dataSource } = await createApiHarness();

      const res = await app.fetch(new Request("http://localhost/api/rooms/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "nonexistent" }),
      }));

      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("ROOM_NOT_FOUND");

      await dataSource.destroy();
    });

    test("includes sockets info in the response", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: true,
      });

      const res = await app.fetch(new Request("http://localhost/api/rooms/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId }),
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sockets).toEqual({ commandUrl: "ws://localhost/ws/command" });

      await dataSource.destroy();
    });
  });

  // -- POST /rooms/:id/close ------------------------------------------------

  describe("POST /rooms/:id/close", () => {
    test("closes room and broadcasts sys:roomClosed", async () => {
      const { app, dataSource, roomService, broadcastProvider } = await createApiHarness();
      const { roomId, token } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });
      const messages: string[] = [];
      broadcastProvider.addSocket(roomId, { send: (data: string) => messages.push(data) }, false);

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomId}/close`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const events = messages.map((m) => JSON.parse(m));
      expect(events.map((e) => e.type)).toEqual(["sys:roomClosed"]);
      expect(events[0].payload).toMatchObject({ roomId, reason: "manual" });
      expect(typeof events[0].payload.closedAt).toBe("number");

      const meta = await roomService.getRoomMeta(roomId);
      expect(meta.closedReason).toBe("manual");
      expect(meta.closedAt).toBeTruthy();

      await dataSource.destroy();
    });

    test("accepts token from request body", async () => {
      const { app, dataSource, roomService, broadcastProvider } = await createApiHarness();
      const { roomId, token } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });
      const messages: string[] = [];
      broadcastProvider.addSocket(roomId, { send: (data: string) => messages.push(data) }, false);

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomId}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }));

      expect(res.status).toBe(200);
      expect(messages.length).toBeGreaterThan(0);
      expect(JSON.parse(messages[0]).type).toBe("sys:roomClosed");

      await dataSource.destroy();
    });

    test("returns 401 when no token is provided", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomId}/close`, {
        method: "POST",
      }));

      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHORIZED");

      await dataSource.destroy();
    });

    test("returns 403 when a participant tries to close", async () => {
      const { app, dataSource, roomService, sessionService } = await createApiHarness();
      const { roomId } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });
      const { token: participantToken } = await sessionService.createSession({
        roomId,
        role: "participant",
        roomUserId: "user:participant",
      });

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomId}/close`, {
        method: "POST",
        headers: { authorization: `Bearer ${participantToken}` },
      }));

      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");

      await dataSource.destroy();
    });

    test("returns 403 when token is for a different room", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId: roomA } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });
      const { token: tokenB } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-2",
        allowGuest: false,
      });

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomA}/close`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenB}` },
      }));

      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");

      await dataSource.destroy();
    });

    test("idempotent: closing an already closed room succeeds", async () => {
      const { app, dataSource, roomService } = await createApiHarness();
      const { roomId, token } = await roomService.createRoom({
        roomType: "score",
        ownerId: "owner-1",
        allowGuest: false,
      });
      await roomService.closeRoom(roomId, "manual");

      const res = await app.fetch(new Request(`http://localhost/api/rooms/${roomId}/close`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      await dataSource.destroy();
    });
  });
});

