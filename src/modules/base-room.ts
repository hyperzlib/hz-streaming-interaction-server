import { createRuleSet } from "../core/rule-set";
import { z } from "zod";
import type { Member, RoomState } from "../types";

const userLifecycleSchema = z.object({
  sessionId: z.string(),
  role: z.enum(["host", "participant"]),
  userId: z.string().optional(),
});

function members(state: RoomState): Record<string, Member> {
  state.members ??= {};
  return state.members;
}

export const baseRoomRules = createRuleSet()
  .on("sys:reload", async (ctx, _payload, next) => {
    for (const member of Object.values(members(ctx.state))) {
      member.presence = "offline";
      member.lastSeenAt = Date.now();
    }
    await next();
  })
  .on("sys:willShutdown", async (ctx, _payload, next) => {
    await next();
    await ctx.broadcast({
      type: "sys:willShutdown",
      payload: { roomId: ctx.roomId },
    });
  })
  .on("sys:userJoin", async (ctx, payload, next) => {
    const data = userLifecycleSchema.parse(payload);
    const now = Date.now();
    members(ctx.state)[data.sessionId] = {
      sessionId: data.sessionId,
      role: data.role,
      userId: data.userId,
      joinedAt: members(ctx.state)[data.sessionId]?.joinedAt ?? now,
      lastSeenAt: now,
      presence: "online",
    };
    await next();
    await ctx.broadcast({
      type: "sys:userJoin",
      payload: data,
    });
  })
  .on("sys:userOffline", async (ctx, payload, next) => {
    const data = userLifecycleSchema.parse(payload);
    const member = members(ctx.state)[data.sessionId];
    if (member) {
      member.presence = "offline";
      member.lastSeenAt = Date.now();
    }
    await next();
    await ctx.broadcast({
      type: "sys:userOffline",
      payload: data,
    });
  })
  .on("sys:userLeave", async (ctx, payload, next) => {
    const data = userLifecycleSchema.parse(payload);
    delete members(ctx.state)[data.sessionId];
    await next();
    await ctx.broadcast({
      type: "sys:userLeave",
      payload: data,
    });
  });
