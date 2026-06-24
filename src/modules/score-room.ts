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
      const scores = await ctx.state.fields.get<Record<string, number>>("scores", {});
      scores[key] = data.score;
      await ctx.state.fields.set("scores", scores);
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
