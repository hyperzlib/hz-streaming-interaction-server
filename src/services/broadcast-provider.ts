import type { BroadcastOpts, RoomEvent } from "../types";
import type { RoomStateStore } from "../storage/room-state-store";

type WebSocketLike = {
  send(data: string): void;
};

type SocketEntry = {
  ws: WebSocketLike;
  isGuest: boolean;
};

export interface BroadcastProvider {
  publishRoomEvent(event: Omit<RoomEvent, "seq" | "timestamp">, opts?: BroadcastOpts): Promise<RoomEvent>;
}

export class InProcessWsBroadcastProvider implements BroadcastProvider {
  private readonly roomSockets = new Map<string, Set<SocketEntry>>();

  constructor(private readonly stateStore: RoomStateStore) {}

  addSocket(roomId: string, ws: WebSocketLike, isGuest: boolean): void {
    if (!this.roomSockets.has(roomId)) {
      this.roomSockets.set(roomId, new Set());
    }
    this.roomSockets.get(roomId)!.add({ ws, isGuest });
  }

  removeSocket(roomId: string, ws: WebSocketLike): void {
    const sockets = this.roomSockets.get(roomId);
    if (!sockets) {
      return;
    }
    for (const entry of sockets) {
      if (entry.ws === ws) {
        sockets.delete(entry);
        break;
      }
    }
    if (!sockets.size) {
      this.roomSockets.delete(roomId);
    }
  }

  async publishRoomEvent(event: Omit<RoomEvent, "seq" | "timestamp">, opts?: BroadcastOpts): Promise<RoomEvent> {
    const fullEvent: RoomEvent = {
      ...event,
      seq: await this.stateStore.nextSeq(event.roomId),
      timestamp: Date.now(),
    };

    const data = JSON.stringify(fullEvent);
    const excludeGuests = opts?.excludeGuests ?? false;
    for (const entry of this.roomSockets.get(event.roomId) ?? []) {
      if (excludeGuests && entry.isGuest) {
        continue;
      }
      try {
        entry.ws.send(data);
      } catch {
        this.roomSockets.get(event.roomId)?.delete(entry);
      }
    }

    return fullEvent;
  }
}
