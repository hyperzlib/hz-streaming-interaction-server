import type { RoomStateSnapshot } from "../types";
import type { RedisFacade } from "./redis-facade";
import { RoomState } from "./room-state";

export class RoomStateStore {
  constructor(private readonly redis: RedisFacade) {}

  forRoom(roomId: string): RoomState {
    return new RoomState(roomId, this.redis);
  }

  async initRoomState(roomId: string): Promise<RoomStateSnapshot> {
    const state: RoomStateSnapshot = { members: {} };
    await this.forRoom(roomId).replace(state);
    await this.redis.setJson(this.seqKey(roomId), 0);
    return state;
  }

  async getRoomState(roomId: string): Promise<RoomStateSnapshot> {
    return await this.forRoom(roomId).snapshot();
  }

  async setRoomState(roomId: string, state: RoomStateSnapshot): Promise<void> {
    await this.forRoom(roomId).replace(state);
  }

  async deleteRoomState(roomId: string): Promise<void> {
    await this.forRoom(roomId).delete();
  }

  async nextSeq(roomId: string): Promise<number> {
    return await this.forRoom(roomId).nextSeq();
  }

  private seqKey(roomId: string): string {
    return `room:${roomId}:seq`;
  }
}
