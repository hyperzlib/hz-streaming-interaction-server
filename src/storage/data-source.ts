import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DataSource } from "typeorm";
import type { AppConfig } from "../config";
import { createBunSqliteConnection } from "./bun-sqlite-better-sqlite3";
import { ResourceFileEntity } from "./resource-file.entity";
import { RoomMetaEntity } from "./room-meta.entity";
import { UserEntity } from "./user.entity";

export function createDataSource(config: AppConfig): DataSource {
  if (config.database.type === "mysql") {
    return new DataSource({
      type: "mysql",
      host: config.database.mysqlHost,
      port: config.database.mysqlPort,
      username: config.database.mysqlUsername,
      password: config.database.mysqlPassword,
      database: config.database.mysqlDatabase,
      synchronize: config.database.synchronize,
      entities: [RoomMetaEntity, UserEntity, ResourceFileEntity],
    });
  }

  const sqlitePath = resolve(config.database.sqlitePath);
  mkdirSync(dirname(sqlitePath), { recursive: true });

  return new DataSource({
    type: "better-sqlite3",
    database: sqlitePath,
    driver: createBunSqliteConnection,
    synchronize: config.database.synchronize,
    entities: [RoomMetaEntity, UserEntity, ResourceFileEntity],
  });
}
