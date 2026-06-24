import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import { RoomDispatcher } from "../core/room-dispatcher";
import { AppError, toAppError } from "../errors";
import { readBearerOrQueryToken } from "../http/auth";
import { clientCommandSchema } from "../http/schemas";
import type { InProcessWsBroadcastProvider } from "../services/broadcast-provider";
import type { RoomService } from "../services/room-service";
import type { SessionService } from "../services/session-service";
import type { RoomStateStore } from "../storage/room-state-store";
import type { RoomMeta, RoomState, Session } from "../types";

export type CommandSocketDeps = {
  roomService: RoomService;
  sessionService: SessionService;
  stateStore: RoomStateStore;
  broadcastProvider: InProcessWsBroadcastProvider;
};

const OFFLINE_GRACE_MS = 5 * 60 * 1000;

export function createCommandSocketApi(deps: CommandSocketDeps): Hono {
  const app = new Hono();
  const activeSessionConnections = new Map<string, number>();
  const leaveTimers = new Map<string, Timer>();

  app.get(
    "/ws/command",
    upgradeWebSocket((c) => {
      let joinedRoomId: string | null = null;
      let session: Session | null = null;

      return {
        async onOpen(_event, ws) {
          const token = readBearerOrQueryToken(c);
          if (!token) {
            ws.close(1008, "Missing token");
            return;
          }

          session = await deps.sessionService.getSession(token);
          if (!session) {
            ws.close(1008, "Invalid token");
            return;
          }

          const meta = await deps.roomService.getRoomMeta(session.roomId);
          const state = await deps.stateStore.getRoomState(session.roomId);
          joinedRoomId = session.roomId;
          deps.broadcastProvider.addSocket(joinedRoomId, ws);
          markSessionConnected(activeSessionConnections, leaveTimers, session);
          await RoomDispatcher.of(meta.roomType).dispatch(
            makeEventContext(deps, session, meta, state),
            {
              roomId: session.roomId,
              roomMeta: meta,
              eventType: "sys:userJoin",
              payload: session,
            },
          );
          await deps.stateStore.setRoomState(session.roomId, state);
        },
        async onMessage(event, ws) {
          if (!session) {
            ws.send(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } }));
            return;
          }

          let commandId: string | undefined;
          try {
            const raw = await webSocketDataToString(event.data);
            const command = clientCommandSchema.parse(JSON.parse(raw));
            commandId = command.id;

            if (command.roomId !== session.roomId) {
              throw new AppError("FORBIDDEN", "Command roomId does not match session", 403);
            }

            const meta = await deps.roomService.getRoomMeta(command.roomId);
            if (meta.closedAt) {
              throw new AppError("ROOM_CLOSED", "Room is closed", 410);
            }

            const state = await deps.stateStore.getRoomState(command.roomId);
            await RoomDispatcher.of(meta.roomType).dispatch(
              makeEventContext(deps, session, meta, state),
              {
                roomId: command.roomId,
                roomMeta: meta,
                eventType: command.type,
                payload: command.payload,
              },
            );
            await deps.stateStore.setRoomState(command.roomId, state);
            ws.send(JSON.stringify({ id: command.id, ok: true }));
          } catch (error) {
            const appError = error instanceof z.ZodError
              ? new AppError("VALIDATION_ERROR", z.prettifyError(error), 400)
              : toAppError(error);
            ws.send(JSON.stringify({
              id: commandId,
              ok: false,
              error: { code: appError.code, message: appError.message },
            }));
          }
        },
        async onClose(_event, ws) {
          if (!joinedRoomId || !session) {
            return;
          }

          deps.broadcastProvider.removeSocket(joinedRoomId, ws);
          if (!markSessionDisconnected(activeSessionConnections, session)) {
            return;
          }

          await dispatchSystemEvent(deps, session, "sys:userOffline");
          scheduleUserLeave(deps, leaveTimers, session);
        },
      };
    }),
  );

  return app;
}

function markSessionConnected(
  activeSessionConnections: Map<string, number>,
  leaveTimers: Map<string, Timer>,
  session: Session,
): void {
  activeSessionConnections.set(
    session.sessionId,
    (activeSessionConnections.get(session.sessionId) ?? 0) + 1,
  );

  const leaveTimer = leaveTimers.get(session.sessionId);
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimers.delete(session.sessionId);
  }
}

function markSessionDisconnected(
  activeSessionConnections: Map<string, number>,
  session: Session,
): boolean {
  const nextCount = (activeSessionConnections.get(session.sessionId) ?? 1) - 1;
  if (nextCount > 0) {
    activeSessionConnections.set(session.sessionId, nextCount);
    return false;
  }

  activeSessionConnections.delete(session.sessionId);
  return true;
}

async function dispatchSystemEvent(
  deps: CommandSocketDeps,
  session: Session,
  eventType: "sys:userOffline" | "sys:userLeave",
): Promise<void> {
  const meta = await deps.roomService.getRoomMeta(session.roomId);
  const state = await deps.stateStore.getRoomState(session.roomId);
  await RoomDispatcher.of(meta.roomType).dispatch(
    makeEventContext(deps, session, meta, state),
    {
      roomId: session.roomId,
      roomMeta: meta,
      eventType,
      payload: session,
    },
  );
  await deps.stateStore.setRoomState(session.roomId, state);
}

function scheduleUserLeave(
  deps: CommandSocketDeps,
  leaveTimers: Map<string, Timer>,
  session: Session,
): void {
  const oldTimer = leaveTimers.get(session.sessionId);
  if (oldTimer) {
    clearTimeout(oldTimer);
  }

  const timer = setTimeout(() => {
    leaveTimers.delete(session.sessionId);
    void dispatchLeaveIfStillOffline(deps, session);
  }, OFFLINE_GRACE_MS);
  leaveTimers.set(session.sessionId, timer);
}

async function dispatchLeaveIfStillOffline(
  deps: CommandSocketDeps,
  session: Session,
): Promise<void> {
  try {
    const state = await deps.stateStore.getRoomState(session.roomId);
    const member = state.members[session.sessionId];
    if (!member || member.presence !== "offline") {
      return;
    }

    await dispatchSystemEvent(deps, session, "sys:userLeave");
  } catch (error) {
    console.error("Failed to dispatch delayed sys:userLeave", error);
  }
}

function makeEventContext(
  deps: Pick<CommandSocketDeps, "broadcastProvider">,
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

async function webSocketDataToString(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  throw new AppError("INVALID_WS_MESSAGE", "Unsupported WebSocket message data", 400);
}
