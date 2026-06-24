import { describe, expect, test } from "bun:test";
import { DataSource } from "typeorm";
import { createBunSqliteConnection } from "../src/storage/bun-sqlite-better-sqlite3";
import { RoomMetaEntity } from "../src/storage/room-meta.entity";
import { UserEntity } from "../src/storage/user.entity";
import { createUserRepository, UserService } from "../src/services/user-service";

async function createUserService() {
  const dataSource = await new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    driver: createBunSqliteConnection,
    synchronize: true,
    entities: [RoomMetaEntity, UserEntity],
  }).initialize();

  return {
    dataSource,
    service: new UserService(createUserRepository(dataSource)),
  };
}

describe("UserService", () => {
  test("upserts OIDC users without dropping local flags", async () => {
    const { dataSource, service } = await createUserService();

    const created = await service.upsertOidcUser({
      id: "oidc-sub",
      displayName: "Alice",
      avatarUrl: "https://example.com/a.png",
      email: "alice@example.com",
    });
    expect(created.level).toBe(1);
    expect(created.displayName).toBe("Alice");

    const updated = await service.upsertOidcUser({
      id: "oidc-sub",
      displayName: "Alice Updated",
      avatarUrl: null,
      email: "alice2@example.com",
    });
    expect(updated.id).toBe("oidc-sub");
    expect(updated.displayName).toBe("Alice Updated");
    expect(updated.email).toBe("alice2@example.com");

    await dataSource.destroy();
  });
});
