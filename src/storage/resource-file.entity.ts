import { EntitySchema } from "typeorm";

export type ResourceStorageProvider = "local" | "s3";
export type ResourceFileStatus = "pending" | "uploaded" | "deleted";

export type ResourceFile = {
  resourceId: string;
  resourceKey: string;
  stateKey: string;
  usedBy: string;
  uploaderSessionId: string;
  uploaderUserId: string | null;
  storageProvider: ResourceStorageProvider;
  objectKey: string;
  contentType: string | null;
  size: number | null;
  status: ResourceFileStatus;
  url: string | null;
  ttlExpiresAt: number | null;
  uploadExpiresAt: number;
  createdAt: number;
  uploadedAt: number | null;
  deletedAt: number | null;
};

export const ResourceFileEntity = new EntitySchema<ResourceFile>({
  name: "ResourceFile",
  tableName: "resource_files",
  columns: {
    resourceId: {
      type: "varchar",
      length: 64,
      primary: true,
    },
    resourceKey: {
      type: "varchar",
      length: 512,
    },
    stateKey: {
      type: "varchar",
      length: 768,
    },
    usedBy: {
      type: "varchar",
      length: 512,
    },
    uploaderSessionId: {
      type: "varchar",
      length: 255,
    },
    uploaderUserId: {
      type: "varchar",
      length: 255,
      nullable: true,
    },
    storageProvider: {
      type: "varchar",
      length: 32,
    },
    objectKey: {
      type: "varchar",
      length: 1024,
    },
    contentType: {
      type: "varchar",
      length: 255,
      nullable: true,
    },
    size: {
      type: "integer",
      nullable: true,
    },
    status: {
      type: "varchar",
      length: 32,
    },
    url: {
      type: "varchar",
      length: 2048,
      nullable: true,
    },
    ttlExpiresAt: {
      type: "integer",
      nullable: true,
    },
    uploadExpiresAt: {
      type: "integer",
    },
    createdAt: {
      type: "integer",
    },
    uploadedAt: {
      type: "integer",
      nullable: true,
    },
    deletedAt: {
      type: "integer",
      nullable: true,
    },
  },
  indices: [
    { name: "IDX_resource_files_usedBy_stateKey", columns: ["usedBy", "stateKey"] },
    { name: "IDX_resource_files_usedBy", columns: ["usedBy"] },
    { name: "IDX_resource_files_status_ttl", columns: ["status", "ttlExpiresAt"] },
    { name: "IDX_resource_files_status_upload", columns: ["status", "uploadExpiresAt"] },
  ],
});
