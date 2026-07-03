import { beforeEach, describe, expect, test } from "bun:test";
import { executeRuleSet } from "../src/core/event-pipeline";
import { RoomRegistry } from "../src/core/room-registry";
import {
  createHangToLaRoom,
  registerHangToLaRoom,
  type RankItem,
} from "../src/modules/hangtola-room";
import type { ResourceService } from "../src/services/resource-service";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomStateStore } from "../src/storage/room-state-store";
import type { EventContext, RoomEvent } from "../src/types";

type ShortEvent = Omit<RoomEvent, "roomId" | "seq" | "timestamp">;

function context(sent: ShortEvent[] = [], broadcasted: ShortEvent[] = []): EventContext {
  return {
    roomId: "room-1",
    roomMeta: {
      roomId: "room-1",
      roomType: "hangtola",
      ownerId: "owner",
      allowGuest: false,
      createdAt: 1,
    },
    session: {
      sessionId: "session-1",
      roomId: "room-1",
      role: "participant",
      roomUserId: "temp:alice",
      roomUserName: "Alice",
    },
    state: new RoomStateStore(new MemoryRedisFacade()).forRoom("room-1"),
    send: async (event) => {
      sent.push(event);
    },
    broadcast: async (event) => {
      broadcasted.push(event);
    },
  };
}

function resourceServiceStub(): ResourceService {
  return {
    async prepareUpload() {
      throw new Error("not implemented");
    },
    async finishUpload() {
      throw new Error("not implemented");
    },
    async deleteByUsedBy() {
      return [];
    },
    async deleteByUsedByStateKey() {
      return [];
    },
  } as unknown as ResourceService;
}

function rankItem(rankItemId: string, overrides: Partial<RankItem> = {}): RankItem {
  return {
    rankItemId,
    name: `Item ${rankItemId}`,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe("createHangToLaRoom", () => {
  beforeEach(() => {
    RoomRegistry.clear();
  });

  test("registers the hangtola room type with a resource service", () => {
    registerHangToLaRoom(resourceServiceStub());

    expect(RoomRegistry.has("hangtola")).toBe(true);
  });

  test("sends current rank state to the joining session", async () => {
    const sent: ShortEvent[] = [];
    const broadcasted: ShortEvent[] = [];
    const ctx = context(sent, broadcasted);
    await ctx.state.fields.set("rankItems", {
      "item-1": rankItem("item-1", { name: "Tea" }),
    });
    await ctx.state.fields.set("rankItemIndex", ["item-1"]);
    await ctx.state.fields.set("rankTable", {
      "item-1": { "temp:bob": 8 },
    });
    await ctx.state.fields.set("rankParticipants", {
      "temp:bob": "Bob",
    });

    await executeRuleSet(createHangToLaRoom(resourceServiceStub()), "sys:userJoin", ctx, ctx.session);

    expect(sent[0]).toEqual({
      type: "state:rank",
      payload: {
        rankItems: {
          "item-1": expect.objectContaining({ rankItemId: "item-1", name: "Tea" }),
        },
        rankItemIndex: ["item-1"],
        rankTable: {
          "item-1": { "temp:bob": 8 },
        },
        rankParticipants: {
          "temp:bob": "Bob",
        },
      },
    });
    expect(sent.map((event) => event.type)).toEqual(["state:rank", "sys:onlineMembers"]);
    expect(broadcasted.map((event) => event.type)).toEqual(["sys:userJoin"]);
  });

  test("adds rank items in display order and broadcasts the canonical item", async () => {
    const broadcasted: ShortEvent[] = [];
    const ctx = context([], broadcasted);
    const rules = createHangToLaRoom(resourceServiceStub());

    await executeRuleSet(rules, "room:addRankItem", ctx, { name: " Tea ", image: "tea.png" });
    await executeRuleSet(rules, "room:addRankItem", ctx, { name: "Coffee" });

    const rankItems = await ctx.state.fields.get<Record<string, RankItem>>("rankItems", {});
    const rankItemIndex = await ctx.state.fields.get<string[]>("rankItemIndex", []);
    expect(rankItemIndex).toHaveLength(2);
    expect(Object.keys(rankItems).sort()).toEqual([...rankItemIndex].sort());
    expect(rankItems[rankItemIndex[0]]).toMatchObject({
      rankItemId: rankItemIndex[0],
      name: "Tea",
      image: "tea.png",
    });
    expect(rankItems[rankItemIndex[1]]).toMatchObject({
      rankItemId: rankItemIndex[1],
      name: "Coffee",
    });
    expect(broadcasted.map((event) => event.type)).toEqual(["room:addRankItem", "room:addRankItem"]);
    expect(broadcasted[0].payload).toEqual({
      rankItem: expect.objectContaining({ rankItemId: rankItemIndex[0], name: "Tea" }),
      rankItemIndex: [rankItemIndex[0]],
    });
  });

  test("edits and deletes rank items while cleaning the deleted item scores", async () => {
    const broadcasted: ShortEvent[] = [];
    const ctx = context([], broadcasted);
    await ctx.state.fields.set("rankItems", {
      "item-1": rankItem("item-1", { name: "Old", image: "old.png" }),
      "item-2": rankItem("item-2", { name: "Keep" }),
    });
    await ctx.state.fields.set("rankItemIndex", ["item-1", "item-2"]);
    await ctx.state.fields.set("rankTable", {
      "item-1": { "temp:alice": 9 },
      "item-2": { "temp:alice": 5 },
    });
    const rules = createHangToLaRoom(resourceServiceStub());

    await executeRuleSet(rules, "room:editRankItem", ctx, {
      rankItemId: "item-1",
      name: "New",
      image: null,
    });
    await executeRuleSet(rules, "room:delRankItem", ctx, { rankItemId: "item-1" });

    expect(await ctx.state.fields.get<Record<string, RankItem>>("rankItems", {})).toEqual({
      "item-2": expect.objectContaining({ name: "Keep" }),
    });
    expect(await ctx.state.fields.get<string[]>("rankItemIndex", [])).toEqual(["item-2"]);
    expect(await ctx.state.fields.get<Record<string, Record<string, number>>>("rankTable", {})).toEqual({
      "item-2": { "temp:alice": 5 },
    });
    expect(broadcasted).toEqual([
      {
        type: "room:editRankItem",
        payload: {
          rankItem: expect.not.objectContaining({ image: expect.any(String) }),
        },
      },
      {
        type: "room:delRankItem",
        payload: { rankItemId: "item-1", rankItemIndex: ["item-2"] },
      },
    ]);
  });

  test("sets and deletes the current user's rank while preserving participant names", async () => {
    const broadcasted: ShortEvent[] = [];
    const ctx = context([], broadcasted);
    await ctx.state.fields.set("rankItems", {
      "item-1": rankItem("item-1"),
    });
    const rules = createHangToLaRoom(resourceServiceStub());

    await executeRuleSet(rules, "room:setRank", ctx, { rankItemId: "item-1", rank: 7.5 });
    await executeRuleSet(rules, "room:delRank", ctx, { rankItemId: "item-1" });

    expect(await ctx.state.fields.get("rankTable", {})).toEqual({
      "item-1": {},
    });
    expect(await ctx.state.fields.get("rankParticipants", {})).toEqual({
      "temp:alice": "Alice",
    });
    expect(broadcasted).toEqual([
      {
        type: "room:setRank",
        payload: {
          rankItemId: "item-1",
          roomUserId: "temp:alice",
          roomUserName: "Alice",
          rank: 7.5,
        },
      },
      {
        type: "room:delRank",
        payload: { rankItemId: "item-1", roomUserId: "temp:alice" },
      },
    ]);
  });

  test("uses room user id as the participant display fallback", async () => {
    const ctx = context();
    ctx.session.roomUserName = undefined;
    await ctx.state.fields.set("rankItems", {
      "item-1": rankItem("item-1"),
    });

    await executeRuleSet(createHangToLaRoom(resourceServiceStub()), "room:setRank", ctx, {
      rankItemId: "item-1",
      rank: 1,
    });

    expect(await ctx.state.fields.get("rankParticipants", {})).toEqual({
      "temp:alice": "temp:alice",
    });
  });

  test("rejects invalid payloads and missing rank items", async () => {
    const ctx = context();
    const rules = createHangToLaRoom(resourceServiceStub());

    await expect(executeRuleSet(rules, "room:addRankItem", ctx, { name: "" })).rejects.toThrow();
    await expect(executeRuleSet(rules, "room:setRank", ctx, {
      rankItemId: "missing",
      rank: 1,
    })).rejects.toThrow("Rank item not found");
  });
});
