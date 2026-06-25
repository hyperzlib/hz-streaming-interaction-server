import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "../errors";
import type { ResourceFile, ResourceStorageProvider } from "../storage/resource-file.entity";

export type PreparedUpload = {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
};

export type ResourceStorage = {
  readonly provider: ResourceStorageProvider;
  prepareUpload(file: ResourceFile): Promise<PreparedUpload>;
  verifyUploaded(file: ResourceFile): Promise<{ size?: number | null; contentType?: string | null }>;
  deleteObject(file: ResourceFile): Promise<void>;
  createDownloadResponse(file: ResourceFile): Promise<Response>;
};

export type LocalResourceStorageConfig = {
  publicBaseUrl: string;
  localDir: string;
  signingSecret: string;
};

export class LocalResourceStorage implements ResourceStorage {
  readonly provider = "local" as const;

  constructor(private readonly config: LocalResourceStorageConfig) {}

  async prepareUpload(file: ResourceFile): Promise<PreparedUpload> {
    const expiresAt = file.uploadExpiresAt;
    const signature = this.sign(file.resourceId, file.objectKey, expiresAt);
    const url = new URL("/api/res/upload", this.config.publicBaseUrl);
    url.searchParams.set("resourceId", file.resourceId);
    url.searchParams.set("expiresAt", String(expiresAt));
    url.searchParams.set("signature", signature);

    return {
      uploadUrl: url.toString(),
      method: "PUT",
      headers: file.contentType ? { "content-type": file.contentType } : {},
      expiresAt,
    };
  }

  async writeUpload(file: ResourceFile, body: ArrayBuffer): Promise<void> {
    const path = this.objectPath(file.objectKey);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, body);
  }

  verifyUploadSignature(file: ResourceFile, expiresAt: number, signature: string, now = Date.now()): void {
    if (expiresAt !== file.uploadExpiresAt || expiresAt <= now) {
      throw new AppError("UPLOAD_EXPIRED", "Upload URL has expired", 410);
    }

    const expected = this.sign(file.resourceId, file.objectKey, expiresAt);
    if (!safeEqual(expected, signature)) {
      throw new AppError("INVALID_UPLOAD_SIGNATURE", "Invalid upload signature", 403);
    }
  }

  async verifyUploaded(file: ResourceFile): Promise<{ size?: number | null; contentType?: string | null }> {
    try {
      const info = await stat(this.objectPath(file.objectKey));
      return { size: info.size, contentType: file.contentType };
    } catch {
      throw new AppError("RESOURCE_NOT_UPLOADED", "Resource object was not uploaded", 400);
    }
  }

  async deleteObject(file: ResourceFile): Promise<void> {
    try {
      await unlink(this.objectPath(file.objectKey));
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async createDownloadResponse(file: ResourceFile): Promise<Response> {
    const body = await readFile(this.objectPath(file.objectKey));
    return new Response(body, {
      headers: {
        "content-type": file.contentType ?? "application/octet-stream",
        "content-length": String(body.byteLength),
      },
    });
  }

  private sign(resourceId: string, objectKey: string, expiresAt: number): string {
    return createHmac("sha256", this.config.signingSecret)
      .update(`${resourceId}.${objectKey}.${expiresAt}`)
      .digest("hex");
  }

  private objectPath(objectKey: string): string {
    const root = resolve(this.config.localDir);
    const path = resolve(root, objectKey);
    if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) {
      throw new AppError("INVALID_OBJECT_KEY", "Invalid resource object key", 400);
    }
    return path;
  }
}

export type S3ResourceStorageConfig = {
  region: string;
  bucket: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  publicBaseUrl?: string;
};

export class S3ResourceStorage implements ResourceStorage {
  readonly provider = "s3" as const;
  private readonly client: S3Client;

  constructor(private readonly config: S3ResourceStorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async prepareUpload(file: ResourceFile): Promise<PreparedUpload> {
    const expiresIn = Math.max(1, Math.floor((file.uploadExpiresAt - Date.now()) / 1000));
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: file.objectKey,
      ContentType: file.contentType ?? undefined,
    });
    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn });
    return {
      uploadUrl,
      method: "PUT",
      headers: file.contentType ? { "content-type": file.contentType } : {},
      expiresAt: file.uploadExpiresAt,
    };
  }

  async verifyUploaded(file: ResourceFile): Promise<{ size?: number | null; contentType?: string | null }> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: file.objectKey,
      }));
      return {
        size: result.ContentLength ?? null,
        contentType: result.ContentType ?? file.contentType,
      };
    } catch {
      throw new AppError("RESOURCE_NOT_UPLOADED", "Resource object was not uploaded", 400);
    }
  }

  async deleteObject(file: ResourceFile): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: file.objectKey,
    }));
  }

  async createDownloadResponse(file: ResourceFile): Promise<Response> {
    const url = this.config.publicBaseUrl
      ? `${this.config.publicBaseUrl.replace(/\/$/, "")}/${file.objectKey}`
      : await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.config.bucket, Key: file.objectKey }),
        { expiresIn: 300 },
      );
    return Response.redirect(url, 302);
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
