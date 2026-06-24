import { createRuleSet } from "../core/rule-set";
import { z } from "zod";

const roomClosedSchema = z.object({
  roomId: z.string(),
  reason: z.enum(["manual", "owner_offline", "empty_room", "server_shutdown"]),
  closedAt: z.number(),
});

const userLifecycleSchema = z.object({
  sessionId: z.string(),
  role: z.enum(["host", "participant"]),
  userId: z.string().optional(),
});

export const baseRoomRules = createRuleSet()
  .on("sys:reload", async (ctx, _payload, next) => {
    const members = await ctx.state.members.all();
    const now = Date.now();
    await Promise.all(
      Object.values(members).map((member) =>
        ctx.state.members.set(member.sessionId, {
          ...member,
          presence: "offline",
          lastSeenAt: now,
        }),
      ),
    );
    await next();
  })
  .on("sys:willShutdown", async (ctx, _payload, next) => {
    await next();
    await ctx.broadcast({
      type: "sys:willShutdown",
      payload: { roomId: ctx.roomId },
    });
  })
  .on("sys:roomClosed", async (ctx, payload, next) => {
    const data = roomClosedSchema.parse(payload);
    await next();
    await ctx.broadcast({
      type: "sys:roomClosed",
      payload: data,
    });
  })
  .on("sys:userJoin", async (ctx, payload, next) => {
    const data = userLifecycleSchema.parse(payload);
    const now = Date.now();
    const existing = await ctx.state.members.get(data.sessionId);
    await ctx.state.members.set(data.sessionId, {
      sessionId: data.sessionId,
      role: data.role,
      userId: data.userId,
      joinedAt: existing?.joinedAt ?? now,
      lastSeenAt: now,
      presence: "online",
    });
    await next();
    await ctx.broadcast({
      type: "sys:userJoin",
      payload: data,
    });
  })
  .on("sys:userOffline", async (ctx, payload, next) => {
    const data = userLifecycleSchema.parse(payload);
    const member = await ctx.state.members.get(data.sessionId);
    if (member) {
      await ctx.state.members.set(data.sessionId, {
        ...member,
        presence: "offline",
        lastSeenAt: Date.now(),
      });
    }
    await next();
    await ctx.broadcast({
      type: "sys:userOffline",
      payload: data,
    });
  })
  .on("sys:userLeave", async (ctx, payload, next) => {
    const data = userLifecycleSchema.parse(payload);
    await ctx.state.members.delete(data.sessionId);
    await next();
    await ctx.broadcast({
      type: "sys:userLeave",
      payload: data,
    });
  });
