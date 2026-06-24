import type { Member, RoomStateSnapshot } from "../types";
import type { RedisFacade } from "./redis-facade";

export class RoomState {
  readonly members: RoomStateMembers;
  readonly fields: RoomStateFields;

  constructor(
    private readonly roomId: string,
    private readonly redis: RedisFacade,
  ) {
    this.members = new RoomStateMembers(redis, this.membersKey());
    this.fields = new RoomStateFields(redis, this.fieldsKey());
  }

  async snapshot(): Promise<RoomStateSnapshot> {
    return {
      members: await this.members.all(),
      ...(await this.fields.all()),
    };
  }

  async replace(snapshot: RoomStateSnapshot): Promise<void> {
    await this.redis.delete(this.membersKey());
    await this.redis.delete(this.fieldsKey());

    const members = snapshot.members ?? {};
    for (const [sessionId, member] of Object.entries(members)) {
      await this.members.set(sessionId, member);
    }

    for (const [field, value] of Object.entries(snapshot)) {
      if (field === "members") {
        continue;
      }
      await this.fields.set(field, value);
    }
  }

  async delete(): Promise<void> {
    await this.redis.delete(this.membersKey());
    await this.redis.delete(this.fieldsKey());
    await this.redis.delete(this.seqKey());
  }

  async nextSeq(): Promise<number> {
    return await this.redis.incr(this.seqKey());
  }

  private baseKey(): string {
    return `room:${this.roomId}`;
  }

  private membersKey(): string {
    return `${this.baseKey()}:members`;
  }

  private fieldsKey(): string {
    return `${this.baseKey()}:fields`;
  }

  private seqKey(): string {
    return `${this.baseKey()}:seq`;
  }
}

class RoomStateMembers {
  constructor(
    private readonly redis: RedisFacade,
    private readonly key: string,
  ) {}

  async get(sessionId: string): Promise<Member | null> {
    return await this.redis.hGetJson<Member>(this.key, sessionId);
  }

  async set(sessionId: string, member: Member): Promise<void> {
    await this.redis.hSetJson(this.key, sessionId, member);
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.hDel(this.key, sessionId);
  }

  async all(): Promise<Record<string, Member>> {
    return await this.redis.hGetAllJson<Member>(this.key);
  }

  async count(): Promise<number> {
    return await this.redis.hLen(this.key);
  }

  async find(predicate: (member: Member) => boolean): Promise<Member | undefined> {
    return Object.values(await this.all()).find(predicate);
  }
}

class RoomStateFields {
  constructor(
    private readonly redis: RedisFacade,
    private readonly key: string,
  ) {}

  async get<T>(name: string): Promise<T | null>;
  async get<T>(name: string, defaultValue: T): Promise<T>;
  async get<T>(name: string, defaultValue?: T): Promise<T | null> {
    const value = await this.redis.hGetJson<T>(this.key, name);
    return value ?? defaultValue ?? null;
  }

  async set(name: string, value: unknown): Promise<void> {
    await this.redis.hSetJson(this.key, name, value);
  }

  async delete(name: string): Promise<void> {
    await this.redis.hDel(this.key, name);
  }

  async all(): Promise<Record<string, unknown>> {
    return await this.redis.hGetAllJson<unknown>(this.key);
  }
}
