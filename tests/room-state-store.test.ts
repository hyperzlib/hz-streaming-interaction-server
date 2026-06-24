import { describe, expect, test } from "bun:test";
import { MemoryRedisFacade } from "../src/storage/redis-facade";
import { RoomStateStore } from "../src/storage/room-state-store";
import type { Member } from "../src/types";

const host: Member = {
  sessionId: "host",
  role: "host",
  userId: "owner-1",
  joinedAt: 1,
  lastSeenAt: 2,
  presence: "online",
};

const participant: Member = {
  sessionId: "participant",
  role: "participant",
  userId: "user-1",
  joinedAt: 3,
  lastSeenAt: 4,
  presence: "offline",
};

describe("RoomStateStore", () => {
  test("updates one member without touching other members", async () => {
    const state = new RoomStateStore(new MemoryRedisFacade()).forRoom("room-1");

    await state.members.set(host.sessionId, host);
    await state.members.set(participant.sessionId, participant);
    await state.members.delete(host.sessionId);

    expect(await state.members.get(host.sessionId)).toBeNull();
    expect(await state.members.get(participant.sessionId)).toEqual(participant);
    expect(await state.members.count()).toBe(1);
  });

  test("updates fields independently from members", async () => {
    const state = new RoomStateStore(new MemoryRedisFacade()).forRoom("room-1");

    await state.members.set(host.sessionId, host);
    await state.fields.set("scores", { "owner-1": 10 });
    await state.fields.delete("scores");

    expect(await state.fields.get("scores")).toBeNull();
    expect(await state.members.get(host.sessionId)).toEqual(host);
  });

  test("snapshot aggregates members and extension fields", async () => {
    const state = new RoomStateStore(new MemoryRedisFacade()).forRoom("room-1");

    await state.members.set(host.sessionId, host);
    await state.fields.set("scores", { "owner-1": 10 });
    await state.fields.set("__roomCleanup", { emptyRoomSince: 1000 });

    expect(await state.snapshot()).toEqual({
      members: { host },
      scores: { "owner-1": 10 },
      __roomCleanup: { emptyRoomSince: 1000 },
    });
  });

  test("replace removes stale members and fields", async () => {
    const stateStore = new RoomStateStore(new MemoryRedisFacade());
    const state = stateStore.forRoom("room-1");

    await state.replace({
      members: { host, participant },
      scores: { "owner-1": 10 },
      __roomCleanup: { emptyRoomSince: 1000 },
    });
    await state.replace({ members: { participant } });

    expect(await state.snapshot()).toEqual({ members: { participant } });
  });

  test("deleteRoomState clears members, fields, and seq", async () => {
    const stateStore = new RoomStateStore(new MemoryRedisFacade());
    const roomId = "room-1";
    const state = stateStore.forRoom(roomId);

    await state.members.set(host.sessionId, host);
    await state.fields.set("scores", { "owner-1": 10 });
    expect(await stateStore.nextSeq(roomId)).toBe(1);

    await stateStore.deleteRoomState(roomId);

    expect(await stateStore.getRoomState(roomId)).toEqual({ members: {} });
    expect(await stateStore.nextSeq(roomId)).toBe(1);
  });
});
