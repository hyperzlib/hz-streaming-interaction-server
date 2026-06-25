import { describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { ResourceService, createResourceRepository } from "../src/services/resource-service";
import type { PreparedUpload, ResourceStorage } from "../src/services/resource-storage";
import { createBunSqliteConnection } from "../src/storage/bun-sqlite-better-sqlite3";
import { ResourceFileEntity, type ResourceFile } from "../src/storage/resource-file.entity";

class FakeStorage implements ResourceStorage {
  readonly provider = "local" as const;
  readonly uploaded = new Set<string>();
  readonly deleted: string[] = [];

  async prepareUpload(file: ResourceFile): Promise<PreparedUpload> {
    return {
      uploadUrl: `https://upload.example/${file.resourceId}`,
      method: "PUT",
      headers: {},
      expiresAt: file.uploadExpiresAt,
    };
  }

  async verifyUploaded(file: ResourceFile): Promise<{ size?: number | null; contentType?: string | null }> {
    if (!this.uploaded.has(file.objectKey)) {
      throw new Error("not uploaded");
    }
    return { size: 123, contentType: file.contentType };
  }

  async deleteObject(file: ResourceFile): Promise<void> {
    this.deleted.push(file.objectKey);
  }

  async createDownloadResponse(): Promise<Response> {
    return new Response("ok");
  }
}

async function harness(now = 1000) {
  const dataSource = await new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    driver: createBunSqliteConnection,
    synchronize: true,
    entities: [ResourceFileEntity],
  }).initialize();
  const storage = new FakeStorage();
  const service = new ResourceService(
    createResourceRepository(dataSource),
    storage,
    { publicBaseUrl: "http://localhost", uploadUrlTtlSeconds: 60 },
    () => now,
  );
  return { dataSource, storage, service };
}

describe("ResourceService", () => {
  test("prepares and finishes an uploaded resource", async () => {
    const { dataSource, storage, service } = await harness();

    const prepared = await service.prepareUpload({
      usedBy: "room/one",
      resourceKey: "avatar",
      stateKey: "user-1@avatar",
      uploaderSessionId: "s1",
      uploaderUserId: "user-1",
      contentType: "text/plain",
      maxTtlSeconds: 86400,
    });
    storage.uploaded.add(prepared.file.objectKey);

    const finished = await service.finishUpload({
      resourceId: prepared.file.resourceId,
      usedBy: "room/one",
      uploaderSessionId: "s1",
    });

    expect(finished.file.status).toBe("uploaded");
    expect(finished.file.size).toBe(123);
    expect(finished.file.url).toBe(`http://localhost/api/res/files/${prepared.file.resourceId}`);

    await dataSource.destroy();
  });

  test("keeps infinite ttl resources out of ttl cleanup", async () => {
    const { dataSource, storage, service } = await harness();
    const prepared = await service.prepareUpload({
      usedBy: "system",
      resourceKey: "logo",
      stateKey: "logo",
      uploaderSessionId: "system",
      ttlSeconds: null,
    });
    storage.uploaded.add(prepared.file.objectKey);
    await service.finishUpload({
      resourceId: prepared.file.resourceId,
      usedBy: "system",
      uploaderSessionId: "system",
    });

    expect(await service.deleteExpiredOnce()).toEqual([]);
    expect((await service.getFile(prepared.file.resourceId)).status).toBe("uploaded");

    await dataSource.destroy();
  });

  test("replaces older resources with the same usedBy and stateKey", async () => {
    const { dataSource, storage, service } = await harness();
    const first = await service.prepareUpload({
      usedBy: "room/one",
      resourceKey: "bg",
      stateKey: "bg",
      uploaderSessionId: "s1",
    });
    storage.uploaded.add(first.file.objectKey);
    await service.finishUpload({ resourceId: first.file.resourceId, usedBy: "room/one", uploaderSessionId: "s1" });

    const second = await service.prepareUpload({
      usedBy: "room/one",
      resourceKey: "bg",
      stateKey: "bg",
      uploaderSessionId: "s1",
    });
    storage.uploaded.add(second.file.objectKey);
    const finished = await service.finishUpload({ resourceId: second.file.resourceId, usedBy: "room/one", uploaderSessionId: "s1" });

    expect(finished.replaced.map((file) => file.resourceId)).toEqual([first.file.resourceId]);
    expect((await service.getFile(first.file.resourceId)).status).toBe("deleted");
    expect(storage.deleted).toContain(first.file.objectKey);

    await dataSource.destroy();
  });

  test("deletes resources by usedBy and stateKey without touching siblings", async () => {
    const { dataSource, storage, service } = await harness();
    const target = await service.prepareUpload({
      usedBy: "room/one",
      resourceKey: "avatar",
      stateKey: "user-1@avatar",
      uploaderSessionId: "s1",
    });
    storage.uploaded.add(target.file.objectKey);
    await service.finishUpload({ resourceId: target.file.resourceId, usedBy: "room/one", uploaderSessionId: "s1" });

    const sibling = await service.prepareUpload({
      usedBy: "room/one",
      resourceKey: "avatar",
      stateKey: "user-2@avatar",
      uploaderSessionId: "s2",
    });
    storage.uploaded.add(sibling.file.objectKey);
    await service.finishUpload({ resourceId: sibling.file.resourceId, usedBy: "room/one", uploaderSessionId: "s2" });

    const deleted = await service.deleteByUsedByStateKey("room/one", "user-1@avatar");

    expect(deleted.map((file) => file.resourceId)).toEqual([target.file.resourceId]);
    expect((await service.getFile(target.file.resourceId)).status).toBe("deleted");
    expect((await service.getFile(sibling.file.resourceId)).status).toBe("uploaded");

    await dataSource.destroy();
  });
});
