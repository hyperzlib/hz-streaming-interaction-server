import { RoomDispatcher } from "../core/room-dispatcher";
import type { InProcessWsBroadcastProvider } from "./broadcast-provider";
import type { RoomService } from "./room-service";
import type { RoomStateStore } from "../storage/room-state-store";
import type { Member, RoomCloseReason, RoomMeta, RoomState, Session } from "../types";

export type RoomCleanupConfig = {
  ownerOfflineGraceSeconds: number;
  emptyRoomGraceSeconds: number;
  closedRoomRetentionSeconds: number;
  scanIntervalSeconds: number;
};

type CleanupState = {
  emptyRoomSince?: number;
  ownerOfflineSince?: number;
};

const CLEANUP_STATE_KEY = "__roomCleanup";

export class RoomCleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly roomService: RoomService,
    private readonly stateStore: RoomStateStore,
    private readonly broadcastProvider: InProcessWsBroadcastProvider,
    private readonly config: RoomCleanupConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        console.error("Failed to run room cleanup scan", error);
      });
    }, this.config.scanIntervalSeconds * 1000);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    await this.scanOnce();
    await this.deleteExpiredOnce();
  }

  async scanOnce(): Promise<void> {
    const now = this.now();
    for (const meta of await this.roomService.getActiveRooms()) {
      const state = await this.stateStore.getRoomState(meta.roomId);
      const cleanup = cleanupState(state);

      if (this.shouldCloseForOwnerOffline(meta, state, cleanup, now)) {
        await this.closeRoom(meta, state, "owner_offline", now);
        continue;
      }

      if (this.shouldCloseForEmptyRoom(state, cleanup, now)) {
        await this.closeRoom(meta, state, "empty_room", now);
        continue;
      }

      await this.stateStore.setRoomState(meta.roomId, state);
    }
  }

  async deleteExpiredOnce(): Promise<void> {
    const cutoff = this.now() - this.config.closedRoomRetentionSeconds * 1000;
    for (const meta of await this.roomService.getClosedRoomsBefore(cutoff)) {
      await this.roomService.deleteRoom(meta.roomId);
    }
  }

  private shouldCloseForOwnerOffline(
    meta: RoomMeta,
    state: RoomState,
    cleanup: CleanupState,
    now: number,
  ): boolean {
    const owner = findOwnerMember(meta, state);
    if (owner?.presence === "online") {
      cleanup.ownerOfflineSince = undefined;
      return false;
    }

    const ownerOfflineSince = owner?.lastSeenAt ?? cleanup.ownerOfflineSince ?? now;
    cleanup.ownerOfflineSince = ownerOfflineSince;
    return now - ownerOfflineSince >= this.config.ownerOfflineGraceSeconds * 1000;
  }

  private shouldCloseForEmptyRoom(state: RoomState, cleanup: CleanupState, now: number): boolean {
    if (effectiveMemberCount(state) > 0) {
      cleanup.emptyRoomSince = undefined;
      return false;
    }

    cleanup.emptyRoomSince ??= now;
    return now - cleanup.emptyRoomSince >= this.config.emptyRoomGraceSeconds * 1000;
  }

  private async closeRoom(
    meta: RoomMeta,
    state: RoomState,
    reason: RoomCloseReason,
    closedAt: number,
  ): Promise<void> {
    await RoomDispatcher.of(meta.roomType).dispatch(
      makeSystemEventContext(this.broadcastProvider, meta, state),
      {
        roomId: meta.roomId,
        roomMeta: meta,
        eventType: "sys:roomClosed",
        payload: {
          roomId: meta.roomId,
          reason,
          closedAt,
        },
      },
    );
    await this.stateStore.setRoomState(meta.roomId, state);
    await this.roomService.closeRoom(meta.roomId, reason, closedAt);
  }
}

function cleanupState(state: RoomState): CleanupState {
  const existing = state[CLEANUP_STATE_KEY];
  if (existing && typeof existing === "object") {
    return existing as CleanupState;
  }

  const cleanup: CleanupState = {};
  state[CLEANUP_STATE_KEY] = cleanup;
  return cleanup;
}

function findOwnerMember(meta: RoomMeta, state: RoomState): Member | undefined {
  return Object.values(state.members ?? {}).find(
    (member) => member.role === "host" || member.userId === meta.ownerId,
  );
}

function effectiveMemberCount(state: RoomState): number {
  return Object.keys(state.members ?? {}).length;
}

function makeSystemEventContext(
  broadcastProvider: InProcessWsBroadcastProvider,
  roomMeta: RoomMeta,
  state: RoomState,
) {
  const session: Session = {
    sessionId: "system",
    roomId: roomMeta.roomId,
    role: "host",
    userId: "system",
  };

  return {
    roomId: roomMeta.roomId,
    roomMeta,
    session,
    state,
    broadcast: async (event: { type: string; payload: unknown }) => {
      await broadcastProvider.publishRoomEvent({
        roomId: roomMeta.roomId,
        type: event.type,
        payload: event.payload,
      });
    },
  };
}
