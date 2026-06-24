import { EntitySchema } from "typeorm";
import type { RoomMeta } from "../types";

export const RoomMetaEntity = new EntitySchema<RoomMeta>({
  name: "RoomMeta",
  tableName: "room_meta",
  columns: {
    roomId: {
      type: "varchar",
      primary: true,
    },
    roomType: {
      type: "varchar",
    },
    ownerId: {
      type: "varchar",
    },
    isPublicRead: {
      type: "boolean",
      default: false,
    },
    passwordHash: {
      type: "varchar",
      nullable: true,
    },
    createdAt: {
      type: "integer",
    },
    closedAt: {
      type: "integer",
      nullable: true,
    },
    closedReason: {
      type: "varchar",
      nullable: true,
    },
  },
});
