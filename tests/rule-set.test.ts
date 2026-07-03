import { describe, expect, test } from "bun:test";
import { executeRuleSet } from "../src/core/event-pipeline";
import { createRuleSet } from "../src/core/rule-set";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomStateStore } from "../src/storage/room-state-store";
import type { EventContext } from "../src/types";

function context(): EventContext {
  return {
    roomId: "room-1",
    roomMeta: {
      roomId: "room-1",
      roomType: "score",
      ownerId: "owner",
      allowGuest: false,
      createdAt: Date.now(),
    },
    session: {
      sessionId: "session-1",
      roomId: "room-1",
      role: "host",
      roomUserId: "user:owner",
    },
    state: new RoomStateStore(new MemoryRedisFacade()).forRoom("room-1"),
    send: async () => {},
    broadcast: async () => {},
  };
}

describe("RuleSet and EventPipeline", () => {
  test("stores temp user name option without merging used rule set options", async () => {
    const base = createRuleSet().enableTempUserName(true);
    const combined = createRuleSet().use(base);

    expect(base.options()).toEqual({ tempUserNameEnabled: true });
    expect(combined.options()).toEqual({ tempUserNameEnabled: false });
    expect(combined.enableTempUserName(true)).toBe(combined);
    expect(combined.options()).toEqual({ tempUserNameEnabled: true });
  });

  test("use appends handlers in registration order", async () => {
    const calls: string[] = [];
    const first = createRuleSet().on("event", async (_ctx, _payload, next) => {
      calls.push("first:before");
      await next();
      calls.push("first:after");
    });
    const second = createRuleSet().on("event", async (_ctx, _payload, next) => {
      calls.push("second:before");
      await next();
      calls.push("second:after");
    });

    const combined = createRuleSet().use(first).use(second);
    await executeRuleSet(combined, "event", context(), {});

    expect(calls).toEqual([
      "first:before",
      "second:before",
      "second:after",
      "first:after",
    ]);
  });

  test("handler can short-circuit by not calling next", async () => {
    const calls: string[] = [];
    const ruleSet = createRuleSet()
      .on("event", async () => {
        calls.push("first");
      })
      .on("event", async () => {
        calls.push("second");
      });

    await executeRuleSet(ruleSet, "event", context(), {});

    expect(calls).toEqual(["first"]);
  });

  test("next can only be called once", async () => {
    const ruleSet = createRuleSet()
      .on("event", async (_ctx, _payload, next) => {
        await next();
        await next();
      })
      .on("event", async () => {});

    await expect(executeRuleSet(ruleSet, "event", context(), {})).rejects.toThrow(
      "next() called multiple times",
    );
  });
});
