import { createRuleSet, type RuleSet } from "@/core/rule-set";
import { RoomRegistry } from "@/core/room-registry";
import { AppError } from "@/errors";
import { ResourceService } from "@/services/resource-service";
import type { EventContext } from "@/types";
import { z } from "zod";
import { baseRoomRules } from "./common/base-room";
import { createResRoom } from "./common/res-room";

export type RankItem = {
  rankItemId: string;
  name: string;
  image?: string;
  createdAt: number;
  updatedAt: number;
};

export type RankState = {
  rankItems: Record<string, RankItem>;
  rankItemIndex: string[];
  rankTable: Record<string, Record<string, number>>;
  rankParticipants: Record<string, string>;
};

const TITLE_FIELD = "title";
const RANK_ITEMS_FIELD = "rankItems";
const RANK_ITEM_INDEX_FIELD = "rankItemIndex";
const RANK_TABLE_FIELD = "rankTable";
const RANK_PARTICIPANTS_FIELD = "rankParticipants";

const addRankItemSchema = z.object({
  name: z.string().trim().min(1),
  image: z.string().min(1).optional(),
});

const editRankItemSchema = z.object({
  rankItemId: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  image: z.string().min(1).nullable().optional(),
});

const rankItemIdSchema = z.object({
  rankItemId: z.string().min(1),
});

const setTitleSchema = z.object({
  title: z.string().trim().min(1),
});

const setRankSchema = z.object({
  rankItemId: z.string().min(1),
  rank: z.number(),
});

export const createHangToLaRoom = (resourceService: ResourceService): RuleSet => {
  const resRoom = createResRoom(resourceService, {
    resourceScope: "room",
  });

  return createRuleSet()
    .enableTempUserName(true)
    .use(baseRoomRules)
    .use(resRoom)
    .on("sys:userJoin", async (ctx, _payload, next) => {
      await next();
      const title = await getTitle(ctx);
      if (title) {
        await ctx.send({
          type: "state:title",
          payload: { title },
        });
      }
      await ctx.send({
        type: "state:rank",
        payload: await getRankState(ctx),
      });
    })
    .on("room:addRankItem", async (ctx, payload, next) => {
      const data = addRankItemSchema.parse(payload);
      const now = Date.now();
      const rankItem: RankItem = {
        rankItemId: crypto.randomUUID(),
        name: data.name,
        image: data.image,
        createdAt: now,
        updatedAt: now,
      };
      const rankItems = await getRankItems(ctx);
      const rankItemIndex = await getRankItemIndex(ctx);

      rankItems[rankItem.rankItemId] = rankItem;
      rankItemIndex.push(rankItem.rankItemId);
      await Promise.all([
        ctx.state.fields.set(RANK_ITEMS_FIELD, rankItems),
        ctx.state.fields.set(RANK_ITEM_INDEX_FIELD, rankItemIndex),
      ]);

      await next();
      await ctx.broadcast({
        type: "room:addRankItem",
        payload: { rankItem, rankItemIndex },
      });
    })
    .on("room:editRankItem", async (ctx, payload, next) => {
      const data = editRankItemSchema.parse(payload);
      const rankItems = await getRankItems(ctx);
      const oldRankItem = getExistingRankItem(rankItems, data.rankItemId);
      const rankItem: RankItem = {
        ...oldRankItem,
        name: data.name ?? oldRankItem.name,
        updatedAt: Date.now(),
      };

      if (data.image === null) {
        delete rankItem.image;
      } else if (data.image !== undefined) {
        rankItem.image = data.image;
      }

      rankItems[data.rankItemId] = rankItem;
      await ctx.state.fields.set(RANK_ITEMS_FIELD, rankItems);

      await next();
      await ctx.broadcast({
        type: "room:editRankItem",
        payload: { rankItem },
      });
    })
    .on("room:delRankItem", async (ctx, payload, next) => {
      const data = rankItemIdSchema.parse(payload);
      const rankItems = await getRankItems(ctx);
      getExistingRankItem(rankItems, data.rankItemId);
      const rankItemIndex = (await getRankItemIndex(ctx)).filter((rankItemId) => rankItemId !== data.rankItemId);
      const rankTable = await getRankTable(ctx);

      delete rankItems[data.rankItemId];
      delete rankTable[data.rankItemId];
      await Promise.all([
        ctx.state.fields.set(RANK_ITEMS_FIELD, rankItems),
        ctx.state.fields.set(RANK_ITEM_INDEX_FIELD, rankItemIndex),
        ctx.state.fields.set(RANK_TABLE_FIELD, rankTable),
      ]);

      await next();
      await ctx.broadcast({
        type: "room:delRankItem",
        payload: { rankItemId: data.rankItemId, rankItemIndex },
      });
    })
    .on("room:setRank", async (ctx, payload, next) => {
      const data = setRankSchema.parse(payload);
      const rankItems = await getRankItems(ctx);
      getExistingRankItem(rankItems, data.rankItemId);
      const rankTable = await getRankTable(ctx);
      const rankParticipants = await getRankParticipants(ctx);
      const roomUserId = ctx.session.roomUserId;
      const roomUserName = ctx.session.roomUserName ?? roomUserId;

      rankTable[data.rankItemId] = {
        ...rankTable[data.rankItemId],
        [roomUserId]: data.rank,
      };
      rankParticipants[roomUserId] = roomUserName;
      await Promise.all([
        ctx.state.fields.set(RANK_TABLE_FIELD, rankTable),
        ctx.state.fields.set(RANK_PARTICIPANTS_FIELD, rankParticipants),
      ]);

      await next();
      await ctx.broadcast({
        type: "room:setRank",
        payload: {
          rankItemId: data.rankItemId,
          roomUserId,
          roomUserName,
          rank: data.rank,
        },
      });
    })
    .on("room:delRank", async (ctx, payload, next) => {
      const data = rankItemIdSchema.parse(payload);
      const rankItems = await getRankItems(ctx);
      getExistingRankItem(rankItems, data.rankItemId);
      const rankTable = await getRankTable(ctx);
      const roomUserId = ctx.session.roomUserId;

      if (rankTable[data.rankItemId]) {
        delete rankTable[data.rankItemId][roomUserId];
      }
      await ctx.state.fields.set(RANK_TABLE_FIELD, rankTable);

      await next();
      await ctx.broadcast({
        type: "room:delRank",
        payload: { rankItemId: data.rankItemId, roomUserId },
      });
    })
    .on("room:setTitle", async (ctx, payload, next) => {
      const data = setTitleSchema.parse(payload);
      await ctx.state.fields.set(TITLE_FIELD, data.title);

      await next();
      await ctx.broadcast({
        type: "room:setTitle",
        payload: { title: data.title },
      });
    });
};

export function registerHangToLaRoom(resourceService: ResourceService): void {
  RoomRegistry.register("hangtola", createHangToLaRoom(resourceService));
}

async function getTitle(ctx: EventContext): Promise<string | undefined> {
  const title = await ctx.state.fields.get<string | undefined>(TITLE_FIELD, undefined);
  return title ?? undefined;
}

async function getRankState(ctx: EventContext): Promise<RankState> {
  const [rankItems, rankItemIndex, rankTable, rankParticipants] = await Promise.all([
    getRankItems(ctx),
    getRankItemIndex(ctx),
    getRankTable(ctx),
    getRankParticipants(ctx),
  ]);
  return { rankItems, rankItemIndex, rankTable, rankParticipants };
}

async function getRankItems(ctx: EventContext): Promise<Record<string, RankItem>> {
  return await ctx.state.fields.get<Record<string, RankItem>>(RANK_ITEMS_FIELD, {});
}

async function getRankItemIndex(ctx: EventContext): Promise<string[]> {
  return await ctx.state.fields.get<string[]>(RANK_ITEM_INDEX_FIELD, []);
}

async function getRankTable(ctx: EventContext): Promise<Record<string, Record<string, number>>> {
  return await ctx.state.fields.get<Record<string, Record<string, number>>>(RANK_TABLE_FIELD, {});
}

async function getRankParticipants(ctx: EventContext): Promise<Record<string, string>> {
  return await ctx.state.fields.get<Record<string, string>>(RANK_PARTICIPANTS_FIELD, {});
}

function getExistingRankItem(rankItems: Record<string, RankItem>, rankItemId: string): RankItem {
  const rankItem = rankItems[rankItemId];
  if (!rankItem) {
    throw new AppError("RANK_ITEM_NOT_FOUND", "Rank item not found", 404);
  }
  return rankItem;
}
