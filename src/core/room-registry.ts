import { AppError } from "../errors";
import type { RuleSet } from "./rule-set";

export class RoomRegistry {
  private static readonly ruleSets = new Map<string, RuleSet>();

  static register(roomType: string, ruleSet: RuleSet): void {
    this.ruleSets.set(roomType, ruleSet);
  }

  static get(roomType: string): RuleSet {
    const ruleSet = this.ruleSets.get(roomType);
    if (!ruleSet) {
      throw new AppError("UNKNOWN_ROOM_TYPE", `Unknown room type: ${roomType}`, 400);
    }
    return ruleSet;
  }

  static has(roomType: string): boolean {
    return this.ruleSets.has(roomType);
  }

  static clear(): void {
    this.ruleSets.clear();
  }
}
