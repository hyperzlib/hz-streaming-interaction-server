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
    await this.redis.hSetJson(this.roomSessionsKey(session.roomId), session.sessionId, token);
    return { token, session };
  }

  async getSession(token: string): Promise<Session | null> {
    return await this.redis.getJson<Session>(this.sessionKey(token));
  }

  async deleteSession(token: string): Promise<void> {
    const session = await this.getSession(token);
    await this.redis.delete(this.sessionKey(token));
    if (session) {
      await this.redis.hDel(this.roomSessionsKey(session.roomId), session.sessionId);
    }
  }

  async getRoomSessions(roomId: string): Promise<Session[]> {
    const indexed = await this.redis.hGetAllJson<string>(this.roomSessionsKey(roomId));
    const sessions: Session[] = [];
    for (const [sessionId, token] of Object.entries(indexed)) {
      const session = await this.getSession(token);
      if (!session || session.roomId !== roomId || session.sessionId !== sessionId) {
        await this.redis.hDel(this.roomSessionsKey(roomId), sessionId);
        continue;
      }
      sessions.push(session);
    }
    return sessions;
  }

  async deleteRoomSession(roomId: string, sessionId: string): Promise<Session | null> {
    const token = await this.redis.hGetJson<string>(this.roomSessionsKey(roomId), sessionId);
    if (!token) {
      return null;
    }

    const session = await this.getSession(token);
    await this.redis.delete(this.sessionKey(token));
    await this.redis.hDel(this.roomSessionsKey(roomId), sessionId);
    return session;
  }

  private createToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Buffer.from(bytes).toString("base64url");
  }

  private sessionKey(token: string): string {
    return `session:${token}`;
  }

  private roomSessionsKey(roomId: string): string {
    return `room:${roomId}:sessions`;
  }
}
