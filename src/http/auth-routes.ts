import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../errors";
import { readBearerOrQueryToken, requireAuthUser } from "./auth";
import { AppDeps } from "@/app";

const loginQuerySchema = z.object({
  callbackMode: z.enum(["redirect", "iframe"]).optional().default("redirect"),
  redirectUrl: z.string().optional(),
});

export function createAuthRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/auth/login", async (c) => {
    const query = loginQuerySchema.parse(c.req.query());
    const loginUrl = await deps.auth!.oidcService.createLoginUrl({
      callbackMode: query.callbackMode,
      redirectUrl: sanitizeRedirectUrl(query.redirectUrl, deps.frontend.allowedOrigins),
    });
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.redirect(loginUrl);
  });

  app.get("/auth/callback", async (c) => {
    const callbackUrl = new URL(c.req.url);
    const result = await deps.auth!.oidcService.handleCallback(callbackUrl);
    const token = await deps.auth!.authSessionService.createSession(result.userId);
    const callbackMode = result.loginState.callbackMode;

    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (callbackMode === "iframe") {
      return c.html(renderIframeCallback(token));
    }

    const redirectUrl = sanitizeRedirectUrl(result.loginState.redirectUrl, deps.frontend.allowedOrigins) ?? "/";
    const url = new URL(redirectUrl, "http://localhost");
    url.searchParams.set("token", token);
    return c.redirect(`${url.pathname}${url.search}${url.hash}`);
  });

  app.get("/auth/edit-profile", async (c) => {
    await requireAuthUser(c.req.header("authorization"), deps);
    const editProfileUrl = deps.auth!.oidcService.getEditProfileUrl();
    if (!editProfileUrl) {
      throw new AppError("EDIT_PROFILE_NOT_SUPPORTED", "IDP does not support profile editing", 501);
    }
    return c.redirect(editProfileUrl);
  });

  app.post("/api/auth/logout", async (c) => {
    const token = readBearerOrQueryToken(c);
    if (token) {
      await deps.auth!.authSessionService.deleteSession(token);
    }
    const logoutUrl = deps.auth!.oidcService.isEnabled() ? await deps.auth!.oidcService.getLogoutUrl() : null;
    return c.json({ ok: true, logoutUrl });
  });

  app.get("/api/auth/me", async (c) => {
    const user = await requireAuthUser(c.req.header("authorization"), deps);
    return c.json({
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      email: user.email,
      level: user.level,
      storytellerLevel: user.storytellerLevel,
      isCertifiedStoryteller: user.isCertifiedStoryteller,
    });
  });

  app.post("/api/auth/refresh-token", async (c) => {
    const token = readBearerOrQueryToken(c);
    if (!token) {
      throw new AppError("UNAUTHORIZED", "Missing token", 401);
    }
    const ok = await deps.auth!.authSessionService.refreshSession(token);
    if (!ok) {
      throw new AppError("SESSION_EXPIRED", "Session expired", 401);
    }
    return c.json({ ok: true });
  });

  return app;
}

function sanitizeRedirectUrl(url: string | undefined, allowedOrigins: string[]): string | undefined {
  if (!url) {
    return undefined;
  }
  // Relative paths (e.g. /dashboard)
  if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\\\")) {
    return url;
  }
  // Absolute URLs must match an allowed origin
  try {
    const parsed = new URL(url);
    if (allowedOrigins.includes(parsed.origin)) {
      return url;
    }
  } catch {
    // Invalid URL → rejected below
  }
  return undefined;
}

function renderIframeCallback(token: string): string {
  const payload = JSON.stringify({ type: "oidc-login", token });
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body>
<script>
window.parent && window.parent.postMessage(${payload}, window.location.origin);
</script>
</body>
</html>`;
}

function renderRedirectCallback(token: string, redirectUrl: string): string {
  const localStorageKey = "livetoolboxUserToken";

  // 同时把 token 添加到 localStorage 和 URL 参数中
  let redirectUri = new URL(redirectUrl, "http://localhost");
  redirectUri.searchParams.set("token", token);

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body>
<script>
localStorage.setItem(${JSON.stringify(localStorageKey)}, ${JSON.stringify(token)});
window.location.href = ${JSON.stringify(redirectUri.toString())};
</script>
</body>
</html>`;
}
