import { existsSync } from "node:fs";

export type AppConfig = {
  server: {
    port: number;
    publicBaseUrl: string;
    wsPath: string;
  };
  database: {
    type: "sqlite" | "mysql";
    sqlitePath: string;
    synchronize: boolean;
    mysqlHost: string;
    mysqlPort: number;
    mysqlUsername: string;
    mysqlPassword: string;
    mysqlDatabase: string;
  };
  redis: {
    url: string;
    keyPrefix: string;
  };
  session: {
    ttlSeconds: number;
  };
  roomCleanup: {
    ownerOfflineGraceSeconds: number;
    emptyRoomGraceSeconds: number;
    closedRoomRetentionSeconds: number;
    scanIntervalSeconds: number;
  };
  resources: {
    provider: "local" | "s3";
    localDir: string;
    uploadUrlTtlSeconds: number;
    cleanupScanIntervalSeconds: number;
    localSigningSecret: string;
    s3Region: string;
    s3Bucket: string;
    s3Endpoint: string;
    s3AccessKeyId: string;
    s3SecretAccessKey: string;
    s3ForcePathStyle: boolean;
    s3PublicBaseUrl: string;
  };
  auth: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
    sessionTtlSeconds: number;
    loginStateTtlSeconds: number;
    postLogoutRedirectUri: string;
    editProfileUrl: string;
  };
};

const localConfigPath = new URL("../../config/config.toml", import.meta.url);
const defaultConfigPath = new URL("../../config/default.toml", import.meta.url);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export async function loadConfig(path = localConfigPath): Promise<AppConfig> {
  const filePath = path.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const fallbackPath = defaultConfigPath.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const resolvedPath = existsSync(filePath) ? filePath : fallbackPath;
  const parsed = existsSync(resolvedPath)
    ? asRecord(Bun.TOML.parse(await Bun.file(resolvedPath).text()))
    : {};

  const server = asRecord(parsed.server);
  const database = asRecord(parsed.database);
  const redis = asRecord(parsed.redis);
  const session = asRecord(parsed.session);
  const roomCleanup = asRecord(parsed.roomCleanup);
  const resources = asRecord(parsed.resources);
  const auth = asRecord(parsed.auth);

  return {
    server: {
      port: Number(process.env.PORT ?? numberValue(server.port, 3000)),
      publicBaseUrl: process.env.PUBLIC_BASE_URL ?? stringValue(server.publicBaseUrl, "http://localhost:3000"),
      wsPath: process.env.WS_PATH ?? stringValue(server.wsPath, "/ws/command"),
    },
    database: {
      type: (process.env.DB_TYPE ?? stringValue(database.type, "sqlite")) as "sqlite" | "mysql",
      sqlitePath: process.env.SQLITE_PATH ?? stringValue(database.sqlitePath, "./data/dev.sqlite"),
      synchronize: process.env.DB_SYNCHRONIZE
        ? process.env.DB_SYNCHRONIZE === "true"
        : booleanValue(database.synchronize, true),
      mysqlHost: process.env.MYSQL_HOST ?? stringValue(database.mysqlHost, "127.0.0.1"),
      mysqlPort: Number(process.env.MYSQL_PORT ?? numberValue(database.mysqlPort, 3306)),
      mysqlUsername: process.env.MYSQL_USERNAME ?? stringValue(database.mysqlUsername, "root"),
      mysqlPassword: process.env.MYSQL_PASSWORD ?? stringValue(database.mysqlPassword, ""),
      mysqlDatabase: process.env.MYSQL_DATABASE ?? stringValue(database.mysqlDatabase, "hz_hang_to_la"),
    },
    redis: {
      url: process.env.REDIS_URL ?? stringValue(redis.url, "redis://127.0.0.1:6379"),
      keyPrefix: process.env.REDIS_KEY_PREFIX ?? stringValue(redis.keyPrefix, "hz:"),
    },
    session: {
      ttlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? numberValue(session.ttlSeconds, 604800)),
    },
    roomCleanup: {
      ownerOfflineGraceSeconds: Number(
        process.env.ROOM_OWNER_OFFLINE_GRACE_SECONDS
          ?? numberValue(roomCleanup.ownerOfflineGraceSeconds, 1200),
      ),
      emptyRoomGraceSeconds: Number(
        process.env.ROOM_EMPTY_GRACE_SECONDS
          ?? numberValue(roomCleanup.emptyRoomGraceSeconds, 120),
      ),
      closedRoomRetentionSeconds: Number(
        process.env.ROOM_CLOSED_RETENTION_SECONDS
          ?? numberValue(roomCleanup.closedRoomRetentionSeconds, 1800),
      ),
      scanIntervalSeconds: Number(
        process.env.ROOM_CLEANUP_SCAN_INTERVAL_SECONDS
          ?? numberValue(roomCleanup.scanIntervalSeconds, 30),
      ),
    },
    resources: {
      provider: (process.env.RES_PROVIDER ?? stringValue(resources.provider, "local")) as "local" | "s3",
      localDir: process.env.RES_LOCAL_DIR ?? stringValue(resources.localDir, "./data/resources"),
      uploadUrlTtlSeconds: Number(
        process.env.RES_UPLOAD_URL_TTL_SECONDS
          ?? numberValue(resources.uploadUrlTtlSeconds, 900),
      ),
      cleanupScanIntervalSeconds: Number(
        process.env.RES_CLEANUP_SCAN_INTERVAL_SECONDS
          ?? numberValue(resources.cleanupScanIntervalSeconds, 60),
      ),
      localSigningSecret: process.env.RES_LOCAL_SIGNING_SECRET
        ?? stringValue(resources.localSigningSecret, "dev-resource-signing-secret"),
      s3Region: process.env.RES_S3_REGION ?? stringValue(resources.s3Region, "us-east-1"),
      s3Bucket: process.env.RES_S3_BUCKET ?? stringValue(resources.s3Bucket, ""),
      s3Endpoint: process.env.RES_S3_ENDPOINT ?? stringValue(resources.s3Endpoint, ""),
      s3AccessKeyId: process.env.RES_S3_ACCESS_KEY_ID ?? stringValue(resources.s3AccessKeyId, ""),
      s3SecretAccessKey: process.env.RES_S3_SECRET_ACCESS_KEY ?? stringValue(resources.s3SecretAccessKey, ""),
      s3ForcePathStyle: process.env.RES_S3_FORCE_PATH_STYLE
        ? process.env.RES_S3_FORCE_PATH_STYLE === "true"
        : booleanValue(resources.s3ForcePathStyle, false),
      s3PublicBaseUrl: process.env.RES_S3_PUBLIC_BASE_URL ?? stringValue(resources.s3PublicBaseUrl, ""),
    },
    auth: {
      enabled: process.env.AUTH_ENABLED
        ? process.env.AUTH_ENABLED === "true"
        : booleanValue(auth.enabled, false),
      issuer: process.env.OIDC_ISSUER ?? stringValue(auth.issuer, ""),
      clientId: process.env.OIDC_CLIENT_ID ?? stringValue(auth.clientId, ""),
      clientSecret: process.env.OIDC_CLIENT_SECRET ?? stringValue(auth.clientSecret, ""),
      redirectUri: process.env.OIDC_REDIRECT_URI ?? stringValue(auth.redirectUri, "http://localhost:3000/auth/callback"),
      scopes: process.env.OIDC_SCOPES ?? stringValue(auth.scopes, "openid profile email"),
      sessionTtlSeconds: Number(process.env.AUTH_SESSION_TTL_SECONDS ?? numberValue(auth.sessionTtlSeconds, 604800)),
      loginStateTtlSeconds: Number(process.env.OIDC_LOGIN_STATE_TTL_SECONDS ?? numberValue(auth.loginStateTtlSeconds, 1200)),
      postLogoutRedirectUri: process.env.OIDC_POST_LOGOUT_REDIRECT_URI
        ?? stringValue(auth.postLogoutRedirectUri, "http://localhost:3000/"),
      editProfileUrl: process.env.OIDC_EDIT_PROFILE_URL ?? stringValue(auth.editProfileUrl, ""),
    },
  };
}
