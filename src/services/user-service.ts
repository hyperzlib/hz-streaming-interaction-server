import type { Repository } from "typeorm";
import type { User } from "../storage/user.entity";
import { UserEntity } from "../storage/user.entity";

export type UpsertOidcUserInput = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
};

export class UserService {
  constructor(private readonly users: Repository<User>) {}

  async upsertOidcUser(input: UpsertOidcUserInput): Promise<User> {
    const now = Math.round(Date.now() / 1000);
    const existing = await this.users.findOneBy({ id: input.id });
    if (!existing) {
      return await this.users.save(this.users.create({
        id: input.id,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        email: input.email,
        lastSeenAt: now,
        level: 1,
        storytellerLevel: 0,
        isCertifiedStoryteller: false,
        isAdmin: false,
        isBanned: false,
        hideGameResults: false,
        vipExpireAt: null,
        createdAt: now,
        updatedAt: now,
      }));
    }

    return await this.users.save({
      ...existing,
      displayName: input.displayName || existing.displayName,
      avatarUrl: input.avatarUrl,
      email: input.email,
      lastSeenAt: now,
      updatedAt: now,
    });
  }

  async getUser(userId: string): Promise<User | null> {
    return await this.users.findOneBy({ id: userId });
  }
}

export function createUserRepository(dataSource: { getRepository: typeof import("typeorm").DataSource.prototype.getRepository }) {
  return dataSource.getRepository(UserEntity);
}
