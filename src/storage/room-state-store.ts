import type { RoomState } from "../types";
import type { RedisFacade } from "./redis-facade";

export class RoomStateStore {
  constructor(private readonly redis: RedisFacade) {}

  async initRoomState(roomId: string): Promise<RoomState> {
    const state: RoomState = { members: {} };
    await this.redis.setJson(this.stateKey(roomId), state);
    await this.redis.setJson(this.seqKey(roomId), 0);
    return state;
  }

  async getRoomState(roomId: string): Promise<RoomState> {
    return (await this.redis.getJson<RoomState>(this.stateKey(roomId))) ?? { members: {} };
  }

  async setRoomState(roomId: string, state: RoomState): Promise<void> {
    await this.redis.setJson(this.stateKey(roomId), state);
  }

  async deleteRoomState(roomId: string): Promise<void> {
    await this.redis.delete(this.stateKey(roomId));
    await this.redis.delete(this.seqKey(roomId));
  }

  async nextSeq(roomId: string): Promise<number> {
    return await this.redis.incr(this.seqKey(roomId));
  }

  private stateKey(roomId: string): string {
    return `room:${roomId}:state`;
  }

  private seqKey(roomId: string): string {
    return `room:${roomId}:seq`;
  }
}
