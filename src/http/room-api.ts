import { Hono } from "hono";
import { RoomDispatcher } from "../core/room-dispatcher";
import { AppError } from "../errors";
import {
  createRoomInputSchema,
  joinRoomInputSchema,
} from "../services/room-service";
import type { RoomMeta, RoomState, Session } from "../types";
import { readBearerOrQueryToken, requireAuthUser, requireSession } from "./auth";
import { closeRoomSchema } from "./schemas";
import { AppDeps } from "@/app";

export function createRoomApi(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/rooms/create", async (c) => {
    await requireAuthUser(c.req.header("authorization"), deps);
    
    const input = createRoomInputSchema.parse(await c.req.json());
    const result = await deps.roomService.createRoom(input);
    return c.json({
      ...result,
      sockets: deps.sockets,
    });
  });

  app.post("/rooms/join", async (c) => {
    const input = joinRoomInputSchema.parse(await c.req.json());
    const result = await deps.roomService.joinRoom(input);
    return c.json({
      ...result,
      sockets: deps.sockets,
    });
  });

  app.get("/rooms/:id/snapshot", async (c) => {
    const roomId = c.req.param("id");
    const snapshot = await deps.roomService.getSnapshot(roomId);
    if (!snapshot.meta.isPublicRead) {
      const session = await requireSession(c, deps.sessionService);
      if (session.roomId !== roomId) {
        throw new AppError("FORBIDDEN", "Token does not belong to this room", 403);
      }
    }
    return c.json(snapshot);
  });

  app.post("/rooms/:id/close", async (c) => {
    const roomId = c.req.param("id");
    const body = closeRoomSchema.parse(await c.req.json().catch(() => ({})));
    const token = body.token ?? readBearerOrQueryToken(c);
    if (!token) {
      throw new AppError("UNAUTHORIZED", "Missing token", 401);
    }
    const session = await deps.sessionService.getSession(token);
    if (!session || session.roomId !== roomId || session.role !== "host") {
      throw new AppError("FORBIDDEN", "Only host can close the room", 403);
    }

    const meta = await deps.roomService.getRoomMeta(roomId);
    const state = await deps.stateStore.getRoomState(roomId);
    const closedAt = Date.now();
    await RoomDispatcher.of(meta.roomType).dispatch(
      makeEventContext(deps, session, meta, state),
      {
        roomId,
        roomMeta: meta,
        eventType: "sys:roomClosed",
        payload: { roomId, reason: "manual", closedAt },
      },
    );
    await deps.stateStore.setRoomState(roomId, state);
    await deps.roomService.closeRoom(roomId, "manual", closedAt);
    return c.json({ ok: true });
  });

  return app;
}

function makeEventContext(
  deps: Pick<AppDeps, "broadcastProvider">,
  session: Session,
  roomMeta: RoomMeta,
  state: RoomState,
) {
  return {
    roomId: roomMeta.roomId,
    roomMeta,
    session,
    state,
    broadcast: async (event: { type: string; payload: unknown }) => {
      await deps.broadcastProvider.publishRoomEvent({
        roomId: roomMeta.roomId,
        type: event.type,
        payload: event.payload,
      });
    },
  };
}
