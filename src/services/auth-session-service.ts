import type { RedisFacade } from "../storage/redis-facade";

export type AuthSession = {
  sessionId: string;
  userId: string;
  createdAt: number;
  refreshedAt: number;
};

export class AuthSessionService {
  constructor(
    private readonly redis: RedisFacade,
    private readonly ttlSeconds: number,
  ) {}

  async createSession(userId: string): Promise<string> {
    const token = this.createToken();
    const now = Date.now();
    const session: AuthSession = {
      sessionId: crypto.randomUUID(),
      userId,
      createdAt: now,
      refreshedAt: now,
    };
    await this.redis.setJson(this.sessionKey(token), session, this.ttlSeconds);
    return token;
  }

  async getSession(token: string): Promise<AuthSession | null> {
    return await this.redis.getJson<AuthSession>(this.sessionKey(token));
  }

  async refreshSession(token: string): Promise<boolean> {
    const session = await this.getSession(token);
    if (!session) {
      return false;
    }
    await this.redis.setJson(this.sessionKey(token), { ...session, refreshedAt: Date.now() }, this.ttlSeconds);
    return true;
  }

  async deleteSession(token: string): Promise<void> {
    await this.redis.delete(this.sessionKey(token));
  }

  private createToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Buffer.from(bytes).toString("base64url");
  }

  private sessionKey(token: string): string {
    return `auth:session:${token}`;
  }
}
