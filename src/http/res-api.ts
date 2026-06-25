import { Hono } from "hono";
import type { AppDeps } from "@/app";
import { AppError } from "../errors";

export function createResourceApi(deps: Pick<AppDeps, "resourceService">): Hono {
  const app = new Hono();

  app.put("/api/res/upload", async (c) => {
    if (!deps.resourceService) {
      throw new AppError("RESOURCE_SERVICE_DISABLED", "Resource service is disabled", 404);
    }

    const resourceId = c.req.query("resourceId");
    const expiresAt = Number(c.req.query("expiresAt"));
    const signature = c.req.query("signature");
    if (!resourceId || !Number.isFinite(expiresAt) || !signature) {
      throw new AppError("VALIDATION_ERROR", "Missing upload signature parameters", 400);
    }

    await deps.resourceService.handleLocalUpload(
      resourceId,
      expiresAt,
      signature,
      await c.req.arrayBuffer(),
    );
    return c.json({ ok: true });
  });

  app.get("/api/res/files/:resourceId", async (c) => {
    if (!deps.resourceService) {
      throw new AppError("RESOURCE_SERVICE_DISABLED", "Resource service is disabled", 404);
    }
    return await deps.resourceService.createDownloadResponse(c.req.param("resourceId"));
  });

  return app;
}
