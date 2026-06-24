import argon2 from "argon2";
import type { Repository } from "typeorm";
import { z } from "zod";
import { AppError } from "../errors";
import { RoomRegistry } from "../core/room-registry";
import type { RoomCloseReason, RoomMeta, RoomState } from "../types";
import { RoomMetaEntity } from "../storage/room-meta.entity";
import type { RoomStateStore } from "../storage/room-state-store";
import type { SessionService } from "./session-service";

export const createRoomInputSchema = z.object({
  roomType: z.string().min(1),
  ownerId: z.string().min(1),
  isPublicRead: z.boolean().optional().default(false),
  password: z.string().min(1).optional(),
});

export const joinRoomInputSchema = z.object({
  roomId: z.string().min(1),
  userId: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

export type CreateRoomInput = z.infer<typeof createRoomInputSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomInputSchema>;

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

    const roomId = crypto.randomUUID();
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

    const { token } = await this.sessionService.createSession({
      roomId: meta.roomId,
      role: "participant",
      userId: input.userId,
    });
    return { token };
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

  async getSnapshot(roomId: string): Promise<{ meta: RoomMeta; state: RoomState }> {
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
}

export function createRoomRepository(dataSource: { getRepository: typeof import("typeorm").DataSource.prototype.getRepository }) {
  return dataSource.getRepository(RoomMetaEntity);
}
