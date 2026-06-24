import { EntitySchema } from "typeorm";

export type User = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
  lastSeenAt: number;
  level: number;
  storytellerLevel: number;
  isCertifiedStoryteller: boolean;
  isAdmin: boolean;
  isBanned: boolean;
  hideGameResults: boolean;
  vipExpireAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export const UserEntity = new EntitySchema<User>({
  name: "User",
  tableName: "users",
  columns: {
    id: {
      type: "varchar",
      length: 255,
      primary: true,
    },
    displayName: {
      type: "varchar",
      length: 255,
      default: "",
    },
    avatarUrl: {
      type: "varchar",
      length: 1024,
      nullable: true,
    },
    email: {
      type: "varchar",
      length: 320,
      nullable: true,
    },
    lastSeenAt: {
      type: "integer",
      default: 0,
    },
    level: {
      type: "integer",
      default: 1,
    },
    storytellerLevel: {
      type: "integer",
      default: 0,
    },
    isCertifiedStoryteller: {
      type: "boolean",
      default: false,
    },
    isAdmin: {
      type: "boolean",
      default: false,
    },
    isBanned: {
      type: "boolean",
      default: false,
    },
    hideGameResults: {
      type: "boolean",
      default: false,
    },
    vipExpireAt: {
      type: "integer",
      nullable: true,
    },
    createdAt: {
      type: "integer",
      default: 0,
    },
    updatedAt: {
      type: "integer",
      default: 0,
    },
  },
  indices: [
    { name: "IDX_users_level", columns: ["level"] },
    { name: "IDX_users_storytellerLevel", columns: ["storytellerLevel"] },
    { name: "IDX_users_isCertifiedStoryteller", columns: ["isCertifiedStoryteller"] },
  ],
});
