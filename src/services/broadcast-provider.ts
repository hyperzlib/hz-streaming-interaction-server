import type { RoomEvent } from "../types";
import type { RoomStateStore } from "../storage/room-state-store";

type WebSocketLike = {
  send(data: string): void;
};

export interface BroadcastProvider {
  publishRoomEvent(event: Omit<RoomEvent, "seq" | "timestamp">): Promise<RoomEvent>;
}

export class InProcessWsBroadcastProvider implements BroadcastProvider {
  private readonly roomSockets = new Map<string, Set<WebSocketLike>>();

  constructor(private readonly stateStore: RoomStateStore) {}

  addSocket(roomId: string, ws: WebSocketLike): void {
    if (!this.roomSockets.has(roomId)) {
      this.roomSockets.set(roomId, new Set());
    }
    this.roomSockets.get(roomId)!.add(ws);
  }

  removeSocket(roomId: string, ws: WebSocketLike): void {
    this.roomSockets.get(roomId)?.delete(ws);
  }

  async publishRoomEvent(event: Omit<RoomEvent, "seq" | "timestamp">): Promise<RoomEvent> {
    const fullEvent: RoomEvent = {
      ...event,
      seq: await this.stateStore.nextSeq(event.roomId),
      timestamp: Date.now(),
    };

    const data = JSON.stringify(fullEvent);
    for (const ws of this.roomSockets.get(event.roomId) ?? []) {
      try {
        ws.send(data);
      } catch {
        this.roomSockets.get(event.roomId)?.delete(ws);
      }
    }

    return fullEvent;
  }
}
