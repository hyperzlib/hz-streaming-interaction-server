type StoredValue = {
  value: string;
  expiresAt?: number;
};

export interface RedisFacade {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  hGetJson<T>(key: string, field: string): Promise<T | null>;
  hSetJson(key: string, field: string, value: unknown): Promise<void>;
  hDel(key: string, ...fields: string[]): Promise<void>;
  hGetAllJson<T>(key: string): Promise<Record<string, T>>;
  hLen(key: string): Promise<number>;
}

export class BunRedisFacade implements RedisFacade {
  private readonly client: InstanceType<typeof Bun.RedisClient>;

  constructor(
    url: string,
    private readonly keyPrefix: string,
  ) {
    this.client = new Bun.RedisClient(url);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.client.get(this.fullKey(key));
    return value ? (JSON.parse(value) as T) : null;
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.set(this.fullKey(key), serialized, "EX", ttlSeconds);
      return;
    }
    await this.client.set(this.fullKey(key), serialized);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.fullKey(key));
  }

  async incr(key: string): Promise<number> {
    return await this.client.incr(this.fullKey(key));
  }

  async keys(pattern: string): Promise<string[]> {
    const prefixPattern = this.fullKey(pattern);
    const keys = await this.client.keys(prefixPattern);
    return keys.map((key) => key.replace(this.keyPrefix, ""));
  }

  async hGetJson<T>(key: string, field: string): Promise<T | null> {
    const value = await this.client.hget(this.fullKey(key), field);
    return value ? (JSON.parse(value) as T) : null;
  }

  async hSetJson(key: string, field: string, value: unknown): Promise<void> {
    await this.client.hset(this.fullKey(key), field, JSON.stringify(value));
  }

  async hDel(key: string, ...fields: string[]): Promise<void> {
    if (!fields.length) {
      return;
    }
    await this.client.hdel(this.fullKey(key), fields[0]!, ...fields.slice(1));
  }

  async hGetAllJson<T>(key: string): Promise<Record<string, T>> {
    const values: Record<string, T> = {};
    let cursor = "0";
    do {
      const [nextCursor, entries] = await this.client.hscan(this.fullKey(key), cursor);
      cursor = nextCursor;
      for (let i = 0; i < entries.length; i += 2) {
        const field = entries[i];
        const value = entries[i + 1];
        if (field && value) {
          values[field] = JSON.parse(value) as T;
        }
      }
    } while (cursor !== "0");
    return values;
  }

  async hLen(key: string): Promise<number> {
    return await this.client.hlen(this.fullKey(key));
  }

  private fullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}

export class MemoryRedisFacade implements RedisFacade {
  private readonly values = new Map<string, StoredValue>();
  private readonly hashes = new Map<string, Map<string, string>>();

  async getJson<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    if (!value) {
      return null;
    }
    if (value.expiresAt && value.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return JSON.parse(value.value) as T;
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.values.set(key, {
      value: JSON.stringify(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.hashes.delete(key);
  }

  async incr(key: string): Promise<number> {
    const current = Number((await this.getJson<number>(key)) ?? 0);
    const next = current + 1;
    await this.setJson(key, next);
    return next;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replaceAll("*", ".*")}$`);
    return [...new Set([...this.values.keys(), ...this.hashes.keys()])].filter((key) => regex.test(key));
  }

  async hGetJson<T>(key: string, field: string): Promise<T | null> {
    const value = this.hashes.get(key)?.get(field);
    return value ? (JSON.parse(value) as T) : null;
  }

  async hSetJson(key: string, field: string, value: unknown): Promise<void> {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map());
    }
    this.hashes.get(key)!.set(field, JSON.stringify(value));
  }

  async hDel(key: string, ...fields: string[]): Promise<void> {
    const hash = this.hashes.get(key);
    if (!hash) {
      return;
    }
    for (const field of fields) {
      hash.delete(field);
    }
    if (!hash.size) {
      this.hashes.delete(key);
    }
  }

  async hGetAllJson<T>(key: string): Promise<Record<string, T>> {
    const hash = this.hashes.get(key);
    if (!hash) {
      return {};
    }
    return Object.fromEntries(
      [...hash.entries()].map(([field, value]) => [field, JSON.parse(value) as T]),
    );
  }

  async hLen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0;
  }
}
