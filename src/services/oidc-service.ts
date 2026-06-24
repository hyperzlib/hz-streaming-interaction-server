import * as oauth from "oauth4webapi";
import type { AppConfig } from "../config";
import { AppError } from "../errors";
import type { RedisFacade } from "../storage/redis-facade";
import type { UserService } from "./user-service";

export type LoginCallbackMode = "redirect" | "iframe";

export type LoginRequest = {
  callbackMode: LoginCallbackMode;
  redirectUrl?: string;
};

export type OidcCallbackResult = {
  userId: string;
  state: string;
  loginState: {
    callbackMode: LoginCallbackMode;
    redirectUrl?: string;
  };
};

export class OidcService {
  private server?: oauth.AuthorizationServer;
  private client?: oauth.Client;

  constructor(
    private readonly config: AppConfig["auth"],
    private readonly redis: RedisFacade,
    private readonly userService: UserService,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async createLoginUrl(input: LoginRequest): Promise<string> {
    this.assertEnabled();
    const { server, client } = await this.getClient();
    const state = oauth.generateRandomState();
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
    const parameters = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: this.config.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    await this.redis.setJson(
      this.loginStateKey(state),
      {
        codeVerifier,
        callbackMode: input.callbackMode,
        redirectUrl: input.redirectUrl,
      },
      this.config.loginStateTtlSeconds,
    );

    return `${server.authorization_endpoint}?${parameters.toString()}`;
  }

  async handleCallback(callbackUrl: URL): Promise<OidcCallbackResult> {
    this.assertEnabled();
    const { server, client } = await this.getClient();
    const state = callbackUrl.searchParams.get("state");
    if (!state) {
      throw new AppError("OIDC_INVALID_STATE", "Missing OIDC state", 400);
    }

    const loginState = await this.redis.getJson<{
      codeVerifier: string;
      callbackMode: LoginCallbackMode;
      redirectUrl?: string;
    }>(this.loginStateKey(state));
    if (!loginState) {
      throw new AppError("OIDC_INVALID_STATE", "OIDC state expired or invalid", 401);
    }

    const params = oauth.validateAuthResponse(server, client, callbackUrl, state);
    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      server,
      client,
      this.config.clientSecret ? oauth.ClientSecretPost(this.config.clientSecret) : oauth.None(),
      params,
      this.config.redirectUri,
      loginState.codeVerifier,
    );
    const tokenResult = await oauth.processAuthorizationCodeResponse(server, client, tokenResponse);

    const claims = tokenResult.id_token ? oauth.getValidatedIdTokenClaims(tokenResult) : undefined;
    const userInfoResponse = await oauth.userInfoRequest(server, client, tokenResult.access_token);
    const expectedSubject = typeof claims?.sub === "string" ? claims.sub : oauth.skipSubjectCheck;
    const userInfo = await oauth.processUserInfoResponse(server, client, expectedSubject, userInfoResponse);

    const subject = String(userInfo.sub ?? claims?.sub ?? "");
    if (!subject) {
      throw new AppError("OIDC_MISSING_SUBJECT", "OIDC user has no subject", 401);
    }

    const user = await this.userService.upsertOidcUser({
      id: subject,
      displayName: stringClaim(userInfo.name) ?? stringClaim(userInfo.preferred_username) ?? stringClaim(userInfo.email) ?? subject,
      avatarUrl: stringClaim(userInfo.picture) ?? null,
      email: stringClaim(userInfo.email) ?? null,
    });

    await this.redis.delete(this.loginStateKey(state));
    return {
      userId: user.id,
      state,
      loginState: {
        callbackMode: loginState.callbackMode,
        redirectUrl: loginState.redirectUrl,
      },
    };
  }

  async getLoginState(state: string): Promise<{ callbackMode: LoginCallbackMode; redirectUrl?: string } | null> {
    return await this.redis.getJson<{ callbackMode: LoginCallbackMode; redirectUrl?: string }>(this.loginStateKey(state));
  }

  getEditProfileUrl(): string | null {
    return this.config.editProfileUrl || null;
  }

  async getLogoutUrl(): Promise<string | null> {
    this.assertEnabled();
    const { server, client } = await this.getClient();
    if (!server.end_session_endpoint) {
      return null;
    }
    const url = new URL(server.end_session_endpoint);
    url.searchParams.set("client_id", client.client_id);
    if (this.config.postLogoutRedirectUri) {
      url.searchParams.set("post_logout_redirect_uri", this.config.postLogoutRedirectUri);
    }
    return url.toString();
  }

  private async getClient(): Promise<{ server: oauth.AuthorizationServer; client: oauth.Client }> {
    if (this.server && this.client) {
      return { server: this.server, client: this.client };
    }
    const issuer = new URL(this.config.issuer);
    this.server = await oauth.discoveryRequest(issuer).then((response) => oauth.processDiscoveryResponse(issuer, response));
    this.client = {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret || undefined,
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    };
    return { server: this.server, client: this.client };
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new AppError("OIDC_DISABLED", "OpenID Connect login is not enabled", 404);
    }
    if (!this.config.issuer || !this.config.clientId || !this.config.redirectUri) {
      throw new AppError("OIDC_NOT_CONFIGURED", "OpenID Connect is not configured", 500);
    }
  }

  private loginStateKey(state: string): string {
    return `oidc:login:${state}`;
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
