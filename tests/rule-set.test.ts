import { describe, expect, test } from "bun:test";
import { executeRuleSet } from "../src/core/event-pipeline";
import { createRuleSet } from "../src/core/rule-set";
import type { EventContext } from "../src/types";

function context(): EventContext {
  return {
    roomId: "room-1",
    roomMeta: {
      roomId: "room-1",
      roomType: "score",
      ownerId: "owner",
      isPublicRead: false,
      createdAt: Date.now(),
    },
    session: {
      sessionId: "session-1",
      roomId: "room-1",
      role: "host",
    },
    state: { members: {} },
    broadcast: async () => {},
  };
}

describe("RuleSet and EventPipeline", () => {
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
