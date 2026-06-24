import { AppError } from "../errors";
import type { DispatchRequest, EventContext } from "../types";
import { executeRuleSet } from "./event-pipeline";
import { RoomRegistry } from "./room-registry";
import type { RuleSet } from "./rule-set";

export class RoomDispatcher {
  static _dispatchers: Map<string, RoomDispatcher> = new Map();

  static of(roomType: string): RoomDispatcher {
    if (!this._dispatchers.has(roomType)) {
      const ruleSet = RoomRegistry.get(roomType);
      const dispatcher = new RoomDispatcher(ruleSet);
      this._dispatchers.set(roomType, dispatcher);
      return dispatcher;
    }
    return this._dispatchers.get(roomType)!;
  }

  constructor(private readonly ruleSet: RuleSet) {}

  async dispatch(ctx: EventContext, req: DispatchRequest): Promise<void> {
    const handlers = this.ruleSet.get(req.eventType);
    if (!handlers.length) {
      throw new AppError("UNKNOWN_EVENT", `Unknown event: ${req.eventType}`, 400);
    }

    await executeRuleSet(this.ruleSet, req.eventType, ctx, req.payload);
  }
}
