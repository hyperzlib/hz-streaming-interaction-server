import type { Session } from "../types";
import type { RedisFacade } from "../storage/redis-facade";

export class SessionService {
  constructor(
    private readonly redis: RedisFacade,
    private readonly ttlSeconds: number,
  ) {}

  async createSession(input: Omit<Session, "sessionId">): Promise<{ token: string; session: Session }> {
    const token = this.createToken();
    const session: Session = {
      ...input,
      sessionId: crypto.randomUUID(),
    };
    await this.redis.setJson(this.sessionKey(token), session, this.ttlSeconds);
    return { token, session };
  }

  async getSession(token: string): Promise<Session | null> {
    return await this.redis.getJson<Session>(this.sessionKey(token));
  }

  async deleteSession(token: string): Promise<void> {
    await this.redis.delete(this.sessionKey(token));
  }

  private createToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Buffer.from(bytes).toString("base64url");
  }

  private sessionKey(token: string): string {
    return `session:${token}`;
  }
}
