import type { Context } from "hono";
import { AppError } from "../errors";
import type { Session } from "../types";
import type { SessionService } from "../services/session-service";
import { AppDeps } from "@/app";
import type { User } from "../storage/user.entity";

export function readBearerOrQueryToken(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return c.req.query("token") ?? null;
}

export async function requireSession(c: Context, sessionService: SessionService): Promise<Session> {
  const token = readBearerOrQueryToken(c);
  if (!token) {
    throw new AppError("UNAUTHORIZED", "Missing token", 401);
  }

  const session = await sessionService.getSession(token);
  if (!session) {
    throw new AppError("UNAUTHORIZED", "Invalid token", 401);
  }
  return session;
}

export async function requireAuthUser(authorization: string | undefined, deps: AppDeps) {
  const token = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : null;
  if (!token) {
    throw new AppError("UNAUTHORIZED", "Missing token", 401);
  }

  if (!deps.auth) {
    throw new AppError("UNAUTHORIZED", "Auth module not enabled");
  }

  const session = await deps.auth.authSessionService.getSession(token);
  if (!session) {
    throw new AppError("UNAUTHORIZED", "Invalid token", 401);
  }

  const user = await deps.auth.userService.getUser(session.userId);
  if (!user) {
    throw new AppError("UNAUTHORIZED", "User not found", 401);
  }
  if (user.isBanned) {
    throw new AppError("USER_BANNED", "User is banned", 403);
  }
  return user;
}

export async function getOptionalAuthUser(authorization: string | undefined, deps: AppDeps): Promise<User | null> {
  const token = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : null;
  if (!token) {
    return null;
  }
  if (!deps.auth) {
    throw new AppError("UNAUTHORIZED", "Auth module not enabled");
  }

  const session = await deps.auth.authSessionService.getSession(token);
  if (!session) {
    throw new AppError("UNAUTHORIZED", "Invalid token", 401);
  }

  const user = await deps.auth.userService.getUser(session.userId);
  if (!user) {
    throw new AppError("UNAUTHORIZED", "User not found", 401);
  }
  if (user.isBanned) {
    throw new AppError("USER_BANNED", "User is banned", 403);
  }
  return user;
}
