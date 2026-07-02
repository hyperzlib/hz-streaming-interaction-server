import { createHash } from "node:crypto";
import argon2 from "argon2";
import type { Repository } from "typeorm";
import { z } from "zod";
import { AppError } from "../errors";
import { RoomRegistry } from "../core/room-registry";
import type { RoomCloseReason, RoomMeta, RoomStateSnapshot, Session } from "../types";
import { RoomMetaEntity } from "../storage/room-meta.entity";
import type { RoomStateStore } from "../storage/room-state-store";
import type { SessionService } from "./session-service";
import { randomRoomId } from "@/utils/random";

export const createRoomInputSchema = z.object({
  roomType: z.string().min(1),
  ownerId: z.string().min(1),
  isPublicRead: z.boolean().optional().default(false),
  password: z.string().min(1).optional(),
});

export const joinRoomInputSchema = z.object({
  roomId: z.string().min(1),
  password: z.string().min(1).optional(),
  roomUserName: z.string().optional(),
});

export type CreateRoomInput = z.infer<typeof createRoomInputSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomInputSchema> & {
  userId?: string;
};

export type KickedSessionPayload = {
  sessionId: string;
  roomUserId: string;
  roomUserName?: string;
  userId?: string;
};

const MAX_TEMP_USER_NAME_LENGTH = 32;

export class RoomService {
  constructor(
    private readonly rooms: Repository<RoomMeta>,
    private readonly stateStore: RoomStateStore,
    private readonly sessionService: SessionService,
  ) {}

  async createRoom(input: CreateRoomInput): Promise<{ roomId: string; token: string }> {
    if (!RoomRegistry.has(input.roomType)) {
      throw new AppError("UNKNOWN_ROOM_TYPE", `Unknown room type: ${input.roomType}`, 400);
    }

    let roomId = '';
    for (let i = 0; i < 5; i++) {
      roomId = randomRoomId();
      const existing = await this.rooms.findOneBy({ roomId });
      if (!existing) {
        break;
      }
    }
    if (!roomId) {
      throw new AppError("ROOM_ID_GENERATION_FAILED", "Failed to generate unique room ID", 500);
    }
    
    const now = Date.now();
    const passwordHash = input.password ? await argon2.hash(input.password) : null;
    const meta: RoomMeta = {
      roomId,
      roomType: input.roomType,
      ownerId: input.ownerId,
      isPublicRead: input.isPublicRead,
      passwordHash,
      createdAt: now,
      closedAt: null,
      closedReason: null,
    };

    await this.rooms.save(meta);
    await this.stateStore.initRoomState(roomId);
    const { token } = await this.sessionService.createSession({
      roomId,
      role: "host",
      roomUserId: roomUserIdForLoggedInUser(input.ownerId),
      userId: input.ownerId,
    });

    return { roomId, token };
  }

  async joinRoom(input: JoinRoomInput): Promise<{ token: string }> {
    const meta = await this.getRoomMeta(input.roomId);
    if (meta.closedAt) {
      throw new AppError("ROOM_CLOSED", "Room is closed", 410);
    }

    if (meta.passwordHash) {
      const ok = input.password ? await argon2.verify(meta.passwordHash, input.password) : false;
      if (!ok) {
        throw new AppError("INVALID_ROOM_PASSWORD", "Invalid room password", 401);
      }
    }

    const roomUserIdentity = await this.resolveJoinRoomUserIdentity(meta, input);
    const { token } = await this.sessionService.createSession({
      roomId: meta.roomId,
      role: "participant",
      roomUserId: roomUserIdentity.roomUserId,
      roomUserName: roomUserIdentity.roomUserName,
      userId: input.userId,
    });
    return { token };
  }

  private async resolveJoinRoomUserIdentity(
    meta: RoomMeta,
    input: JoinRoomInput,
  ): Promise<{ roomUserId: string; roomUserName?: string }> {
    if (input.userId) {
      return {
        roomUserId: roomUserIdForLoggedInUser(input.userId),
      };
    }

    const ruleSet = RoomRegistry.get(meta.roomType);
    if (!ruleSet.options().tempUserNameEnabled) {
      return {
        roomUserId: roomUserIdForTemporaryUser(),
      };
    }

    if (!meta.passwordHash) {
      throw new AppError("TEMP_USER_NAME_REQUIRES_PASSWORD", "Temporary user names require a room password", 400);
    }

    const roomUserName = normalizeTempUserName(input.roomUserName);
    const roomUserId = roomUserIdForTemporaryUserName(meta.roomId, roomUserName);
    const activeSessions = await this.sessionService.getRoomSessions(meta.roomId);
    if (activeSessions.some((session) => session.roomUserId === roomUserId)) {
      throw new AppError("ROOM_USER_NAME_TAKEN", "Room user name is already taken", 409);
    }

    return {
      roomUserId,
      roomUserName,
    };
  }

  async getRoomMeta(roomId: string): Promise<RoomMeta> {
    const meta = await this.rooms.findOneBy({ roomId });
    if (!meta) {
      throw new AppError("ROOM_NOT_FOUND", "Room not found", 404);
    }
    return meta;
  }

  async updateRoomMeta(roomId: string, roomMeta: RoomMeta): Promise<void> {
    await this.rooms.save({ ...roomMeta, roomId });
  }

  async closeRoom(roomId: string, reason: RoomCloseReason, closedAt = Date.now()): Promise<void> {
    const meta = await this.getRoomMeta(roomId);
    if (meta.closedAt) {
      return;
    }
    await this.updateRoomMeta(roomId, { ...meta, closedAt, closedReason: reason });
  }

  async getSnapshot(roomId: string): Promise<{ meta: RoomMeta; state: RoomStateSnapshot }> {
    return {
      meta: await this.getRoomMeta(roomId),
      state: await this.stateStore.getRoomState(roomId),
    };
  }

  async getActiveRooms(): Promise<RoomMeta[]> {
    return await this.rooms
      .createQueryBuilder("room")
      .where("room.closedAt IS NULL")
      .getMany();
  }

  async getClosedRoomsBefore(cutoff: number): Promise<RoomMeta[]> {
    return await this.rooms
      .createQueryBuilder("room")
      .where("room.closedAt IS NOT NULL")
      .andWhere("room.closedAt <= :cutoff", { cutoff })
      .getMany();
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.rooms.delete({ roomId });
    await this.stateStore.deleteRoomState(roomId);
  }

  async kickSession(actor: Session, targetSessionId: string): Promise<KickedSessionPayload> {
    if (actor.role !== "host") {
      throw new AppError("FORBIDDEN", "Only host can kick room users", 403);
    }
    if (targetSessionId === actor.sessionId) {
      throw new AppError("CANNOT_KICK_SELF", "Host cannot kick self", 400);
    }

    const target = await this.sessionService.deleteRoomSession(actor.roomId, targetSessionId);
    if (!target || target.roomId !== actor.roomId) {
      throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    }

    await this.stateStore.forRoom(actor.roomId).members.delete(target.sessionId);
    return {
      sessionId: target.sessionId,
      roomUserId: target.roomUserId,
      roomUserName: target.roomUserName,
      userId: target.userId,
    };
  }
}

function roomUserIdForLoggedInUser(userId: string): string {
  return `user:${userId}`;
}

function roomUserIdForTemporaryUser(): string {
  return `temp:${crypto.randomUUID()}`;
}

function normalizeTempUserName(value: string | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) {
    throw new AppError("ROOM_USER_NAME_REQUIRED", "Room user name is required", 400);
  }
  if (normalized.length > MAX_TEMP_USER_NAME_LENGTH) {
    throw new AppError("ROOM_USER_NAME_TOO_LONG", "Room user name is too long", 400);
  }
  return normalized;
}

function roomUserIdForTemporaryUserName(roomId: string, roomUserName: string): string {
  const hash = createHash("sha256")
    .update(`${roomId}\0${roomUserName}`)
    .digest("hex");
  return `temp:${hash}`;
}

export function createRoomRepository(dataSource: { getRepository: typeof import("typeorm").DataSource.prototype.getRepository }) {
  return dataSource.getRepository(RoomMetaEntity);
}
