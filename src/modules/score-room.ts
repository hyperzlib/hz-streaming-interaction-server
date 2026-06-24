import { z } from "zod";
import { RoomRegistry } from "../core/room-registry";
import { createRuleSet } from "../core/rule-set";
import { baseRoomRules } from "./base-room";

const scoreSetSchema = z.object({
  targetUserId: z.string().optional(),
  score: z.number(),
});

export const scoreRoomRules = createRuleSet()
  .use(baseRoomRules)
  .use(
    createRuleSet().on("score:set", async (ctx, payload, next) => {
      const data = scoreSetSchema.parse(payload);
      const key = data.targetUserId ?? ctx.session.userId ?? ctx.session.sessionId;
      const scores = (ctx.state.scores ?? {}) as Record<string, number>;
      scores[key] = data.score;
      ctx.state.scores = scores;
      await next();
      await ctx.broadcast({
        type: "score:set",
        payload: { targetUserId: key, score: data.score },
      });
    }),
  );

export function registerModules(): void {
  RoomRegistry.register("score", scoreRoomRules);
}
