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

  private fullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}

export class MemoryRedisFacade implements RedisFacade {
  private readonly values = new Map<string, StoredValue>();

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
  }

  async incr(key: string): Promise<number> {
    const current = Number((await this.getJson<number>(key)) ?? 0);
    const next = current + 1;
    await this.setJson(key, next);
    return next;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replaceAll("*", ".*")}$`);
    return [...this.values.keys()].filter((key) => regex.test(key));
  }
}
