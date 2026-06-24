import { describe, expect, test } from "bun:test";
import { AuthSessionService } from "../src/services/auth-session-service";
import { MemoryRedisFacade } from "../src/storage/redis-facade";

describe("AuthSessionService", () => {
  test("creates, refreshes, and deletes auth sessions", async () => {
    const service = new AuthSessionService(new MemoryRedisFacade(), 60);

    const token = await service.createSession("user-1");
    const session = await service.getSession(token);

    expect(session?.userId).toBe("user-1");
    expect(await service.refreshSession(token)).toBe(true);

    await service.deleteSession(token);

    expect(await service.getSession(token)).toBeNull();
  });
});
