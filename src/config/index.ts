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
