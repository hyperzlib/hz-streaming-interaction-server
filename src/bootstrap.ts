import type { DataSource } from "typeorm";
import type { AppConfig } from "./config";
import { createDataSource } from "./storage/data-source";
import { BunRedisFacade } from "./storage/redis-facade";
import { RoomStateStore } from "./storage/room-state-store";
import { SessionService } from "./services/session-service";
import { RoomService, createRoomRepository } from "./services/room-service";
import { AuthSessionService } from "./services/auth-session-service";
import { InProcessWsBroadcastProvider } from "./services/broadcast-provider";
import { createApp } from "./app";
import { registerModules } from "./modules/score-room";
import { RoomDispatcher } from "./core/room-dispatcher";
import { UserService, createUserRepository } from "./services/user-service";
import { OidcService } from "./services/oidc-service";

export async function bootstrap(config: AppConfig) {
  registerModules();

  const dataSource: DataSource = await createDataSource(config).initialize();
  const redis = new BunRedisFacade(config.redis.url, config.redis.keyPrefix);
  const stateStore = new RoomStateStore(redis);
  const sessionService = new SessionService(redis, config.session.ttlSeconds);
  const authSessionService = new AuthSessionService(redis, config.auth.sessionTtlSeconds);
  const userService = new UserService(createUserRepository(dataSource));
  const oidcService = new OidcService(config.auth, redis, userService);
  const roomService = new RoomService(
    createRoomRepository(dataSource),
    stateStore,
    sessionService,
  );
  const broadcastProvider = new InProcessWsBroadcastProvider(stateStore);
  const commandUrl = `${config.server.publicBaseUrl.replace(/^http/, "ws")}${config.server.wsPath}`;

  const app = createApp({
    roomService,
    sessionService,
    stateStore,
    broadcastProvider,
    sockets: { commandUrl },
    auth: {
      oidcService,
      authSessionService,
      userService,
    },
  });

  for (const meta of await roomService.getActiveRooms()) {
    const state = await stateStore.getRoomState(meta.roomId);
    await RoomDispatcher.of(meta.roomType).dispatch(
      {
        roomId: meta.roomId,
        roomMeta: meta,
        session: {
          sessionId: "system",
          roomId: meta.roomId,
          role: "host",
          userId: "system",
        },
        state,
        broadcast: async (event) => {
          await broadcastProvider.publishRoomEvent({
            roomId: meta.roomId,
            type: event.type,
            payload: event.payload,
          });
        },
      },
      {
        roomId: meta.roomId,
        roomMeta: meta,
        eventType: "sys:reload",
        payload: {},
      },
    );
    await stateStore.setRoomState(meta.roomId, state);
  }

  return {
    app,
    websocket: (await import("hono/bun")).websocket,
    port: config.server.port,
    dataSource,
  };
}
