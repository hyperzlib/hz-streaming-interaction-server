import type { Repository } from "typeorm";
import { AppError } from "../errors";
import { ResourceFileEntity, type ResourceFile } from "../storage/resource-file.entity";
import { LocalResourceStorage, type PreparedUpload, type ResourceStorage } from "./resource-storage";

export type PrepareResourceInput = {
  usedBy: string;
  resourceKey: string;
  stateKey: string;
  uploaderSessionId: string;
  uploaderUserId?: string | null;
  contentType?: string | null;
  size?: number | null;
  ttlSeconds?: number | null;
  maxTtlSeconds?: number;
};

export type FinishResourceInput = {
  resourceId: string;
  usedBy: string;
  uploaderSessionId: string;
};

export type FinishedResource = {
  file: ResourceFile;
  replaced: ResourceFile[];
};

export type ResourceServiceConfig = {
  publicBaseUrl: string;
  uploadUrlTtlSeconds: number;
};

export class ResourceService {
  constructor(
    private readonly files: Repository<ResourceFile>,
    private readonly storage: ResourceStorage,
    private readonly config: ResourceServiceConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async prepareUpload(input: PrepareResourceInput): Promise<{ file: ResourceFile; upload: PreparedUpload }> {
    const now = this.now();
    const resourceId = crypto.randomUUID();
    const file: ResourceFile = {
      resourceId,
      resourceKey: input.resourceKey,
      stateKey: input.stateKey,
      usedBy: input.usedBy,
      uploaderSessionId: input.uploaderSessionId,
      uploaderUserId: input.uploaderUserId ?? null,
      storageProvider: this.storage.provider,
      objectKey: makeObjectKey(input.usedBy, resourceId),
      contentType: input.contentType ?? null,
      size: input.size ?? null,
      status: "pending",
      url: null,
      ttlExpiresAt: ttlExpiresAt(now, input.ttlSeconds, input.maxTtlSeconds),
      uploadExpiresAt: now + this.config.uploadUrlTtlSeconds * 1000,
      createdAt: now,
      uploadedAt: null,
      deletedAt: null,
    };

    await this.files.save(file);
    return { file, upload: await this.storage.prepareUpload(file) };
  }

  async finishUpload(input: FinishResourceInput): Promise<FinishedResource> {
    const file = await this.getFile(input.resourceId);
    this.assertPendingOwner(file, input);
    this.assertUploadNotExpired(file);

    const verified = await this.storage.verifyUploaded(file);
    const now = this.now();
    const url = this.resourceUrl(file.resourceId);
    const uploaded: ResourceFile = {
      ...file,
      status: "uploaded",
      size: verified.size ?? file.size,
      contentType: verified.contentType ?? file.contentType,
      url,
      uploadedAt: now,
    };

    await this.files.save(uploaded);
    const replaced = await this.replaceOlderResources(uploaded);
    return { file: uploaded, replaced };
  }

  async handleLocalUpload(resourceId: string, expiresAt: number, signature: string, body: ArrayBuffer): Promise<void> {
    if (!(this.storage instanceof LocalResourceStorage)) {
      throw new AppError("UNSUPPORTED_UPLOAD_ROUTE", "Local upload route is disabled for this storage provider", 404);
    }

    const file = await this.getFile(resourceId);
    if (file.status !== "pending" || file.deletedAt) {
      throw new AppError("INVALID_RESOURCE_STATE", "Resource is not pending upload", 409);
    }

    this.storage.verifyUploadSignature(file, expiresAt, signature, this.now());
    await this.storage.writeUpload(file, body);
  }

  async createDownloadResponse(resourceId: string): Promise<Response> {
    const file = await this.getFile(resourceId);
    if (file.status !== "uploaded" || file.deletedAt) {
      throw new AppError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    }
    if (file.ttlExpiresAt !== null && file.ttlExpiresAt <= this.now()) {
      throw new AppError("RESOURCE_EXPIRED", "Resource has expired", 410);
    }
    return await this.storage.createDownloadResponse(file);
  }

  async deleteByUsedBy(usedBy: string): Promise<ResourceFile[]> {
    const files = await this.files
      .createQueryBuilder("resource")
      .where("resource.usedBy = :usedBy", { usedBy })
      .andWhere("resource.deletedAt IS NULL")
      .getMany();

    const deleted: ResourceFile[] = [];
    for (const file of files) {
      deleted.push(await this.deleteFile(file));
    }
    return deleted;
  }

  async deleteByUsedByStateKey(usedBy: string, stateKey: string): Promise<ResourceFile[]> {
    const files = await this.files
      .createQueryBuilder("resource")
      .where("resource.usedBy = :usedBy", { usedBy })
      .andWhere("resource.stateKey = :stateKey", { stateKey })
      .andWhere("resource.deletedAt IS NULL")
      .getMany();

    const deleted: ResourceFile[] = [];
    for (const file of files) {
      deleted.push(await this.deleteFile(file));
    }
    return deleted;
  }

  async deleteExpiredOnce(): Promise<ResourceFile[]> {
    const now = this.now();
    const expired = await this.files
      .createQueryBuilder("resource")
      .where("resource.deletedAt IS NULL")
      .andWhere(
        "(resource.ttlExpiresAt IS NOT NULL AND resource.ttlExpiresAt <= :now) OR (resource.status = :pending AND resource.uploadExpiresAt <= :now)",
        { now, pending: "pending" },
      )
      .getMany();

    const deleted: ResourceFile[] = [];
    for (const file of expired) {
      deleted.push(await this.deleteFile(file));
    }
    return deleted;
  }

  async getFile(resourceId: string): Promise<ResourceFile> {
    const file = await this.files.findOneBy({ resourceId });
    if (!file) {
      throw new AppError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    }
    return file;
  }

  private async replaceOlderResources(file: ResourceFile): Promise<ResourceFile[]> {
    const older = await this.files
      .createQueryBuilder("resource")
      .where("resource.usedBy = :usedBy", { usedBy: file.usedBy })
      .andWhere("resource.stateKey = :stateKey", { stateKey: file.stateKey })
      .andWhere("resource.resourceId != :resourceId", { resourceId: file.resourceId })
      .andWhere("resource.deletedAt IS NULL")
      .getMany();

    const deleted: ResourceFile[] = [];
    for (const oldFile of older) {
      deleted.push(await this.deleteFile(oldFile));
    }
    return deleted;
  }

  private async deleteFile(file: ResourceFile): Promise<ResourceFile> {
    const deletedAt = this.now();
    const deleted = {
      ...file,
      status: "deleted" as const,
      deletedAt,
    };
    await this.files.save(deleted);

    try {
      await this.storage.deleteObject(file);
    } catch (error) {
      console.error("Failed to delete resource object", {
        resourceId: file.resourceId,
        objectKey: file.objectKey,
        error,
      });
    }

    return deleted;
  }

  private assertPendingOwner(file: ResourceFile, input: FinishResourceInput): void {
    if (file.status !== "pending" || file.deletedAt) {
      throw new AppError("INVALID_RESOURCE_STATE", "Resource is not pending upload", 409);
    }
    if (file.usedBy !== input.usedBy || file.uploaderSessionId !== input.uploaderSessionId) {
      throw new AppError("FORBIDDEN", "Resource does not belong to this session", 403);
    }
  }

  private assertUploadNotExpired(file: ResourceFile): void {
    if (file.uploadExpiresAt <= this.now()) {
      throw new AppError("UPLOAD_EXPIRED", "Upload URL has expired", 410);
    }
  }

  private resourceUrl(resourceId: string): string {
    return new URL(`/api/res/files/${resourceId}`, this.config.publicBaseUrl).toString();
  }
}

export class ResourceCleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly resourceService: ResourceService,
    private readonly scanIntervalSeconds: number,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.resourceService.deleteExpiredOnce().catch((error) => {
        console.error("Failed to run resource cleanup scan", error);
      });
    }, this.scanIntervalSeconds * 1000);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function createResourceRepository(dataSource: { getRepository: typeof import("typeorm").DataSource.prototype.getRepository }) {
  return dataSource.getRepository(ResourceFileEntity);
}

function ttlExpiresAt(now: number, ttlSeconds: number | null | undefined, maxTtlSeconds: number | undefined): number | null {
  if (ttlSeconds === null) {
    return null;
  }

  const effectiveTtl = ttlSeconds === undefined
    ? maxTtlSeconds
    : maxTtlSeconds === undefined
      ? ttlSeconds
      : Math.min(ttlSeconds, maxTtlSeconds);

  return effectiveTtl === undefined ? null : now + effectiveTtl * 1000;
}

function makeObjectKey(usedBy: string, resourceId: string): string {
  const safeUsedBy = usedBy
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `resources/${safeUsedBy}/${resourceId}`;
}
