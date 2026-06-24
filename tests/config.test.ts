import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const envKeys = [
  "ROOM_OWNER_OFFLINE_GRACE_SECONDS",
  "ROOM_EMPTY_GRACE_SECONDS",
  "ROOM_CLOSED_RETENTION_SECONDS",
  "ROOM_CLEANUP_SCAN_INTERVAL_SECONDS",
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
});
