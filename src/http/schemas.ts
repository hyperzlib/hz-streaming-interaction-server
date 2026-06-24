import { z } from "zod";

export const clientCommandSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  roomId: z.string().min(1),
  payload: z.unknown().optional(),
});

export const closeRoomSchema = z.object({
  token: z.string().optional(),
});
