import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { createApp } from "../src/app";
import { InProcessWsBroadcastProvider } from "../src/services/broadcast-provider";
import { ResourceService, createResourceRepository } from "../src/services/resource-service";
import { LocalResourceStorage } from "../src/services/resource-storage";
import { RoomService, createRoomRepository } from "../src/services/room-service";
import { SessionService } from "../src/services/session-service";
import { createBunSqliteConnection } from "../src/storage/bun-sqlite-better-sqlite3";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { ResourceFileEntity } from "../src/storage/resource-file.entity";
import { RoomMetaEntity } from "../src/storage/room-meta.entity";
import { RoomStateStore } from "../src/storage/room-state-store";

async function harness() {
  const dataSource = await new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    driver: createBunSqliteConnection,
    synchronize: true,
    entities: [RoomMetaEntity, ResourceFileEntity],
  }).initialize();
  const redis = new MemoryRedisFacade();
  const stateStore = new RoomStateStore(redis);
  const sessionService = new SessionService(redis, 60);
  const resourceDir = join(import.meta.dir, "..", "data", `test-res-api-${crypto.randomUUID()}`);
  const resourceService = new ResourceService(
    createResourceRepository(dataSource),
    new LocalResourceStorage({
      publicBaseUrl: "http://localhost",
      localDir: resourceDir,
      signingSecret: "test-secret",
    }),
    { publicBaseUrl: "http://localhost", uploadUrlTtlSeconds: 60 },
  );
  const app = createApp({
    roomService: new RoomService(createRoomRepository(dataSource), stateStore, sessionService),
    sessionService,
    stateStore,
    broadcastProvider: new InProcessWsBroadcastProvider(stateStore),
    resourceService,
    sockets: { commandUrl: "ws://localhost/ws/command" },
  });

  return {
    app,
    dataSource,
    resourceDir,
    resourceService,
    cleanup: async () => {
      await dataSource.destroy();
      await rm(resourceDir, { recursive: true, force: true });
    },
  };
}

describe("Resource API", () => {
  test("accepts local signed uploads and serves uploaded resources", async () => {
    const { app, resourceService, cleanup } = await harness();
    try {
      const prepared = await resourceService.prepareUpload({
        usedBy: "room/one",
        resourceKey: "note",
        stateKey: "user-1@note",
        uploaderSessionId: "session-1",
        contentType: "text/plain",
      });

      const uploadResponse = await app.fetch(new Request(prepared.upload.uploadUrl, {
        method: "PUT",
        body: "hello",
        headers: prepared.upload.headers,
      }));
      expect(uploadResponse.status).toBe(200);

      const finished = await resourceService.finishUpload({
        resourceId: prepared.file.resourceId,
        usedBy: "room/one",
        uploaderSessionId: "session-1",
      });
      const fileResponse = await app.fetch(new Request(finished.file.url!));

      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe("text/plain");
      expect(await fileResponse.text()).toBe("hello");
    } finally {
      await cleanup();
    }
  });

  test("rejects invalid local upload signatures", async () => {
    const { app, resourceService, cleanup } = await harness();
    try {
      const prepared = await resourceService.prepareUpload({
        usedBy: "room/one",
        resourceKey: "note",
        stateKey: "user-1@note",
        uploaderSessionId: "session-1",
      });
      const url = new URL(prepared.upload.uploadUrl);
      url.searchParams.set("signature", "bad");

      const response = await app.fetch(new Request(url, {
        method: "PUT",
        body: "hello",
      }));

      expect(response.status).toBe(403);
    } finally {
      await cleanup();
    }
  });
});
