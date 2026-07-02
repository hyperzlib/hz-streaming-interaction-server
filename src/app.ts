import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { toAppError } from "./errors";
import { createAuthRoutes } from "./http/auth-routes";
import { createResourceApi } from "./http/res-api";
import { createRoomApi } from "./http/room-api";
import { createCommandSocketApi, type CommandSocketDeps } from "./socket/command";
import { RoomService } from "./services/room-service";
import { SessionService } from "./services/session-service";
import { RoomStateStore } from "./storage/room-state-store";
import { InProcessWsBroadcastProvider } from "./services/broadcast-provider";
import { OidcService } from "./services/oidc-service";
import { AuthSessionService } from "./services/auth-session-service";
import { UserService } from "./services/user-service";
import type { ResourceService } from "./services/resource-service";

export type AppDeps = {
  roomService: RoomService;
  sessionService: SessionService;
  stateStore: RoomStateStore;
  broadcastProvider: InProcessWsBroadcastProvider;
  resourceService?: ResourceService;
  sockets: {
    commandUrl: string;
  };
  auth?: {
    oidcService: OidcService;
    authSessionService: AuthSessionService;
    userService: UserService;
  };
  frontend: {
    allowedOrigins: string[];
  };
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: deps.frontend.allowedOrigins,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json(
        { error: { code: "HTTP_ERROR", message: error.message } },
        error.status,
      );
    }

    if (error instanceof z.ZodError) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: z.prettifyError(error) } },
        400,
      );
    }

    const appError = toAppError(error);
    return c.json(
      { error: { code: appError.code, message: appError.message } },
      appError.status as 400,
    );
  });

  app.get("/health", (c) => c.json({ ok: true }));

  if (deps.auth) {
    app.route("/", createAuthRoutes(deps));
  }

  app.route("/", createRoomApi(deps));
  app.route("/", createResourceApi(deps));
  app.route("/", createCommandSocketApi(deps));

  return app;
}
