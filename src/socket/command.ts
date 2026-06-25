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
import type { RoomState } from "../storage/room-state";
import type { RoomStateStore } from "../storage/room-state-store";
import type { RoomMeta, Session, EventContext } from "../types";
import { WSContext } from "hono/ws";

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
  const sessionSockets = new Map<string, Set<WSContext<any>>>();

  app.get(
    "/ws/command",
    upgradeWebSocket((c) => {
      let joinedRoomId: string | null = null;
      let session: Session | null = null;
      let token: string | null = null;

      return {
        async onOpen(_event, ws) {
          token = readBearerOrQueryToken(c);
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
          joinedRoomId = session.roomId;
          deps.broadcastProvider.addSocket(joinedRoomId, ws);
          markSessionConnected(activeSessionConnections, leaveTimers, session);
          addSessionSocket(sessionSockets, session.sessionId, ws);
          const state = deps.stateStore.forRoom(session.roomId);
          await RoomDispatcher.of(meta.roomType).dispatch(
            makeEventContext(deps, session, meta, state, ws),
            {
              roomId: session.roomId,
              roomMeta: meta,
              eventType: "sys:userJoin",
              payload: session,
            },
          );
        },
        async onMessage(event, ws) {
          if (!session) {
            ws.send(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } }));
            return;
          }

          let commandId: string | undefined;
          try {
            if (!token || !await isTokenStillValid(deps, token, session)) {
              ws.send(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } }));
              ws.close(1008, "Invalid token");
              return;
            }

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

            if (command.type === "room:kick") {
              await handleKickCommand(deps, sessionSockets, session, command.payload);
              ws.send(JSON.stringify({ id: command.id, ok: true }));
              return;
            }

            const state = deps.stateStore.forRoom(command.roomId);
            await RoomDispatcher.of(meta.roomType).dispatch(
              makeEventContext(deps, session, meta, state),
              {
                roomId: command.roomId,
                roomMeta: meta,
                eventType: command.type,
                payload: command.payload,
              },
            );
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
          removeSessionSocket(sessionSockets, session.sessionId, ws);
          if (!markSessionDisconnected(activeSessionConnections, session)) {
            return;
          }
          if (token && !await isTokenStillValid(deps, token, session)) {
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

const kickPayloadSchema = z.object({
  sessionId: z.string().min(1),
});

async function handleKickCommand(
  deps: CommandSocketDeps,
  sessionSockets: Map<string, Set<WSContext<any>>>,
  actor: Session,
  payload: unknown,
): Promise<void> {
  if (actor.role !== "host") {
    throw new AppError("FORBIDDEN", "Only host can kick room users", 403);
  }

  const data = kickPayloadSchema.parse(payload);
  const payloadOut = await deps.roomService.kickSession(actor, data.sessionId);

  await deps.broadcastProvider.publishRoomEvent({
    roomId: actor.roomId,
    type: "sys:userKicked",
    payload: payloadOut,
  });

  const sockets = sessionSockets.get(payloadOut.sessionId);
  if (!sockets) {
    return;
  }
  for (const targetWs of [...sockets]) {
    try {
      targetWs.send(JSON.stringify({
        type: "sys:kicked",
        payload: payloadOut,
      }));
      targetWs.close(1008, "Kicked");
    } catch {
      // Socket cleanup also happens through onClose.
    }
  }
}

async function isTokenStillValid(
  deps: CommandSocketDeps,
  token: string,
  session: Session,
): Promise<boolean> {
  const current = await deps.sessionService.getSession(token);
  return current?.sessionId === session.sessionId && current.roomId === session.roomId;
}

function addSessionSocket(
  sessionSockets: Map<string, Set<WSContext<any>>>,
  sessionId: string,
  ws: WSContext<any>,
): void {
  if (!sessionSockets.has(sessionId)) {
    sessionSockets.set(sessionId, new Set());
  }
  sessionSockets.get(sessionId)!.add(ws);
}

function removeSessionSocket(
  sessionSockets: Map<string, Set<WSContext<any>>>,
  sessionId: string,
  ws: WSContext<any>,
): void {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    return;
  }
  sockets.delete(ws);
  if (!sockets.size) {
    sessionSockets.delete(sessionId);
  }
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
  const state = deps.stateStore.forRoom(session.roomId);
  await RoomDispatcher.of(meta.roomType).dispatch(
    makeEventContext(deps, session, meta, state),
    {
      roomId: session.roomId,
      roomMeta: meta,
      eventType,
      payload: session,
    },
  );
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
    const state = deps.stateStore.forRoom(session.roomId);
    const member = await state.members.get(session.sessionId);
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
  ws?: WSContext<any>
) {
  return {
    roomId: roomMeta.roomId,
    roomMeta,
    session,
    state,
    send: async (event: { type: string; payload: unknown }) => {
      ws?.send(JSON.stringify(event));
    },
    broadcast: async (event: { type: string; payload: unknown }) => {
      await deps.broadcastProvider.publishRoomEvent({
        roomId: roomMeta.roomId,
        type: event.type,
        payload: event.payload,
      });
    },
  } satisfies EventContext;
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
