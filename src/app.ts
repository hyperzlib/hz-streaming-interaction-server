import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { toAppError } from "./errors";
import { createAuthRoutes } from "./http/auth-routes";
import { createRoomApi } from "./http/room-api";
import { createCommandSocketApi, type CommandSocketDeps } from "./socket/command";
import { RoomService } from "./services/room-service";
import { SessionService } from "./services/session-service";
import { RoomStateStore } from "./storage/room-state-store";
import { InProcessWsBroadcastProvider } from "./services/broadcast-provider";
import { OidcService } from "./services/oidc-service";
import { AuthSessionService } from "./services/auth-session-service";
import { UserService } from "./services/user-service";

export type AppDeps = {
  roomService: RoomService;
  sessionService: SessionService;
  stateStore: RoomStateStore;
  broadcastProvider: InProcessWsBroadcastProvider;
  sockets: {
    commandUrl: string;
  };
  auth?: {
    oidcService: OidcService;
    authSessionService: AuthSessionService;
    userService: UserService;
  }
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

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
  app.route("/", createCommandSocketApi(deps));

  return app;
}
