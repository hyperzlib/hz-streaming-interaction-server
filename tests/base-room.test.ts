import { describe, expect, test } from "bun:test";
import { executeRuleSet } from "../src/core/event-pipeline";
import { baseRoomRules } from "../src/modules/common/base-room";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomStateStore } from "../src/storage/room-state-store";
import type { EventContext, Member, RoomEvent } from "../src/types";

function member(overrides: Partial<Member> & Pick<Member, "sessionId">): Member {
  return {
    role: "participant",
    roomUserId: `user:${overrides.sessionId}`,
    joinedAt: 1,
    lastSeenAt: 1,
    presence: "online",
    ...overrides,
  };
}

function context(sent: Array<Omit<RoomEvent, "roomId" | "seq" | "timestamp">>): EventContext {
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
      sessionId: "joining",
      roomId: "room-1",
      role: "participant",
      roomUserId: "user:user-3",
      userId: "user-3",
    },
    state: new RoomStateStore(new MemoryRedisFacade()).forRoom("room-1"),
    send: async (event) => {
      sent.push(event);
    },
    broadcast: async () => {},
  };
}

describe("baseRoomRules", () => {
  test("sends the current online member list to a joining session", async () => {
    const sent: Array<Omit<RoomEvent, "roomId" | "seq" | "timestamp">> = [];
    const ctx = context(sent);
    await ctx.state.members.set("already-online", member({
      sessionId: "already-online",
      roomUserId: "user:user-1",
      userId: "user-1",
      joinedAt: 10,
    }));
    await ctx.state.members.set("offline", member({
      sessionId: "offline",
      roomUserId: "user:user-2",
      userId: "user-2",
      joinedAt: 5,
      presence: "offline",
    }));

    await executeRuleSet(baseRoomRules, "sys:userJoin", ctx, {
      sessionId: "joining",
      role: "participant",
      roomUserId: "user:user-3",
      roomUserName: "User 3",
      userId: "user-3",
    });

    expect(sent).toEqual([
      {
        type: "sys:onlineMembers",
        payload: {
          members: [
            expect.objectContaining({ sessionId: "already-online", presence: "online" }),
            expect.objectContaining({ sessionId: "joining", roomUserName: "User 3", presence: "online" }),
          ],
        },
      },
    ]);
  });
});
