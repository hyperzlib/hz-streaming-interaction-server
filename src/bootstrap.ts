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
import { registerHangToLaRoom } from "./modules/hangtola-room";
import { RoomDispatcher } from "./core/room-dispatcher";
import { UserService, createUserRepository } from "./services/user-service";
import { OidcService } from "./services/oidc-service";
import { RoomCleanupService } from "./services/room-cleanup-service";
import { ResourceCleanupService, ResourceService, createResourceRepository } from "./services/resource-service";
import { LocalResourceStorage, S3ResourceStorage, type ResourceStorage } from "./services/resource-storage";
import { registerScoreRoom } from "./modules/score-room";

export async function bootstrap(config: AppConfig) {
  const dataSource: DataSource = await createDataSource(config).initialize();
  const redis = new BunRedisFacade(config.redis.url, config.redis.keyPrefix);
  const stateStore = new RoomStateStore(redis);
  const sessionService = new SessionService(redis, config.session.ttlSeconds);
  const authSessionService = new AuthSessionService(redis, config.auth.sessionTtlSeconds);
  const userService = new UserService(createUserRepository(dataSource));
  const oidcService = new OidcService(config.auth, redis, userService);
  const resourceStorage = createResourceStorage(config);
  const resourceService = new ResourceService(
    createResourceRepository(dataSource),
    resourceStorage,
    {
      publicBaseUrl: config.server.publicBaseUrl,
      uploadUrlTtlSeconds: config.resources.uploadUrlTtlSeconds,
    },
  );

  registerHangToLaRoom(resourceService);
  registerScoreRoom();
  
  const roomService = new RoomService(
    createRoomRepository(dataSource),
    stateStore,
    sessionService,
  );
  const broadcastProvider = new InProcessWsBroadcastProvider(stateStore);
  const roomCleanupService = new RoomCleanupService(
    roomService,
    stateStore,
    broadcastProvider,
    config.roomCleanup,
  );
  const resourceCleanupService = new ResourceCleanupService(
    resourceService,
    config.resources.cleanupScanIntervalSeconds,
  );
  const commandUrl = `${config.server.publicBaseUrl.replace(/^http/, "ws")}${config.server.wsPath}`;

  const app = createApp({
    roomService,
    sessionService,
    stateStore,
    broadcastProvider,
    resourceService,
    sockets: { commandUrl },
    auth: {
      oidcService,
      authSessionService,
      userService,
    },
    frontend: config.frontend,
  });

  for (const meta of await roomService.getActiveRooms()) {
    const state = stateStore.forRoom(meta.roomId);
    await RoomDispatcher.of(meta.roomType).dispatch(
      {
        roomId: meta.roomId,
        roomMeta: meta,
        session: {
          sessionId: "system",
          roomId: meta.roomId,
          role: "host",
          roomUserId: "user:system",
          userId: "system",
        },
        state,
        send: async () => {},
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
  }

  roomCleanupService.start();
  resourceCleanupService.start();

  return {
    app,
    websocket: (await import("hono/bun")).websocket,
    port: config.server.port,
    dataSource,
    roomCleanupService,
    resourceCleanupService,
  };
}

function createResourceStorage(config: AppConfig): ResourceStorage {
  if (config.resources.provider === "s3") {
    return new S3ResourceStorage({
      region: config.resources.s3Region,
      bucket: config.resources.s3Bucket,
      endpoint: config.resources.s3Endpoint || undefined,
      accessKeyId: config.resources.s3AccessKeyId,
      secretAccessKey: config.resources.s3SecretAccessKey,
      forcePathStyle: config.resources.s3ForcePathStyle,
      publicBaseUrl: config.resources.s3PublicBaseUrl || undefined,
    });
  }

  return new LocalResourceStorage({
    publicBaseUrl: config.server.publicBaseUrl,
    localDir: config.resources.localDir,
    signingSecret: config.resources.localSigningSecret,
  });
}
