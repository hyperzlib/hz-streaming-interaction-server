import { Hono } from "hono";
import { RoomDispatcher } from "../core/room-dispatcher";
import { AppError } from "../errors";
import {
  createRoomInputSchema,
  joinRoomInputSchema,
} from "../services/room-service";
import type { RoomState } from "../storage/room-state";
import type { RoomMeta, Session, BroadcastOpts } from "../types";
import { getOptionalAuthUser, readBearerOrQueryToken, requireAuthUser } from "./auth";
import { closeRoomSchema } from "./schemas";
import { AppDeps } from "@/app";

export function createRoomApi(deps: AppDeps): Hono {
  const app = new Hono();
  const createRoomBodySchema = createRoomInputSchema.omit({ ownerId: true });

  app.get("/api/rooms/:id/info", async (c) => {
    const roomId = c.req.param("id");
    const meta = await deps.roomService.getRoomMeta(roomId);
    if (meta.closedAt) {
      return c.json({
        roomId: meta.roomId,
        roomType: meta.roomType,
        hasPassword: !!meta.passwordHash,
        allowGuest: meta.allowGuest,
        createdAt: meta.createdAt,
        isClosed: true,
      });
    }
    return c.json({
      roomId: meta.roomId,
      roomType: meta.roomType,
      hasPassword: !!meta.passwordHash,
      allowGuest: meta.allowGuest,
      createdAt: meta.createdAt,
      isClosed: false,
    });
  });

  app.post("/api/rooms/create", async (c) => {
    const user = await requireAuthUser(c.req.header("authorization"), deps);
    
    const input = createRoomBodySchema.parse(await c.req.json());
    const result = await deps.roomService.createRoom({
      ...input,
      ownerId: user.id,
      roomUserName: input.roomUserName ?? user.displayName,
    });
    return c.json({
      ...result,
      sockets: deps.sockets,
    });
  });

  app.post("/api/rooms/join", async (c) => {
    const user = await getOptionalAuthUser(c.req.header("authorization"), deps);
    const input = joinRoomInputSchema.parse(await c.req.json());
    const result = await deps.roomService.joinRoom({
      ...input,
      userId: user?.id,
    });
    return c.json({
      ...result,
      sockets: deps.sockets,
    });
  });

  app.post("/api/rooms/:id/close", async (c) => {
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
    const state = deps.stateStore.forRoom(roomId);
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
    send: async () => {},
    broadcast: async (event: { type: string; payload: unknown }, opts?: BroadcastOpts) => {
      await deps.broadcastProvider.publishRoomEvent({
        roomId: roomMeta.roomId,
        type: event.type,
        payload: event.payload,
      }, opts);
    },
  };
}
