import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const envKeys = [
  "ROOM_OWNER_OFFLINE_GRACE_SECONDS",
  "ROOM_EMPTY_GRACE_SECONDS",
  "ROOM_CLOSED_RETENTION_SECONDS",
  "ROOM_CLEANUP_SCAN_INTERVAL_SECONDS",
  "RES_PROVIDER",
  "RES_LOCAL_DIR",
  "RES_UPLOAD_URL_TTL_SECONDS",
  "RES_CLEANUP_SCAN_INTERVAL_SECONDS",
  "RES_LOCAL_SIGNING_SECRET",
  "RES_S3_REGION",
  "RES_S3_BUCKET",
  "RES_S3_ENDPOINT",
  "RES_S3_ACCESS_KEY_ID",
  "RES_S3_SECRET_ACCESS_KEY",
  "RES_S3_FORCE_PATH_STYLE",
  "RES_S3_PUBLIC_BASE_URL",
] as const;

const originalEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>;

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("config", () => {
  test("loads default room cleanup values", async () => {
    for (const key of envKeys) {
      delete process.env[key];
    }

    const config = await loadConfig(new URL("../config/default.toml", import.meta.url));

    expect(config.roomCleanup).toEqual({
      ownerOfflineGraceSeconds: 1200,
      emptyRoomGraceSeconds: 120,
      closedRoomRetentionSeconds: 1800,
      scanIntervalSeconds: 30,
    });
    expect(config.resources).toEqual({
      provider: "local",
      localDir: "./data/resources",
      uploadUrlTtlSeconds: 900,
      cleanupScanIntervalSeconds: 60,
      localSigningSecret: "dev-resource-signing-secret",
      s3Region: "us-east-1",
      s3Bucket: "",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      s3ForcePathStyle: false,
      s3PublicBaseUrl: "",
    });
  });

  test("overrides room cleanup values from environment", async () => {
    process.env.ROOM_OWNER_OFFLINE_GRACE_SECONDS = "11";
    process.env.ROOM_EMPTY_GRACE_SECONDS = "12";
    process.env.ROOM_CLOSED_RETENTION_SECONDS = "13";
    process.env.ROOM_CLEANUP_SCAN_INTERVAL_SECONDS = "14";

    const config = await loadConfig(new URL("../config/default.toml", import.meta.url));

    expect(config.roomCleanup).toEqual({
      ownerOfflineGraceSeconds: 11,
      emptyRoomGraceSeconds: 12,
      closedRoomRetentionSeconds: 13,
      scanIntervalSeconds: 14,
    });
  });

  test("overrides resource values from environment", async () => {
    process.env.RES_PROVIDER = "s3";
    process.env.RES_LOCAL_DIR = "./tmp/resources";
    process.env.RES_UPLOAD_URL_TTL_SECONDS = "21";
    process.env.RES_CLEANUP_SCAN_INTERVAL_SECONDS = "22";
    process.env.RES_LOCAL_SIGNING_SECRET = "secret";
    process.env.RES_S3_REGION = "ap-east-1";
    process.env.RES_S3_BUCKET = "bucket";
    process.env.RES_S3_ENDPOINT = "https://s3.example.com";
    process.env.RES_S3_ACCESS_KEY_ID = "key";
    process.env.RES_S3_SECRET_ACCESS_KEY = "secret-key";
    process.env.RES_S3_FORCE_PATH_STYLE = "true";
    process.env.RES_S3_PUBLIC_BASE_URL = "https://cdn.example.com";

    const config = await loadConfig(new URL("../config/default.toml", import.meta.url));

    expect(config.resources).toEqual({
      provider: "s3",
      localDir: "./tmp/resources",
      uploadUrlTtlSeconds: 21,
      cleanupScanIntervalSeconds: 22,
      localSigningSecret: "secret",
      s3Region: "ap-east-1",
      s3Bucket: "bucket",
      s3Endpoint: "https://s3.example.com",
      s3AccessKeyId: "key",
      s3SecretAccessKey: "secret-key",
      s3ForcePathStyle: true,
      s3PublicBaseUrl: "https://cdn.example.com",
    });
  });
});
