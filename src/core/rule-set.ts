import type { EventContext } from "../types";

export type RuleHandler = (
  ctx: EventContext,
  payload: unknown,
  next: () => Promise<void>,
) => Promise<void>;

export type RuleSet = {
  on(eventType: string, handler: RuleHandler): RuleSet;
  use(other: RuleSet): RuleSet;
  get(eventType: string): RuleHandler[];
  entries(): IterableIterator<[string, RuleHandler[]]>;
};

export function createRuleSet(): RuleSet {
  const rules = new Map<string, RuleHandler[]>();

  return {
    on(eventType, handler) {
      if (!rules.has(eventType)) {
        rules.set(eventType, []);
      }
      rules.get(eventType)!.push(handler);
      return this;
    },
    use(other) {
      for (const [eventType, handlers] of other.entries()) {
        if (!rules.has(eventType)) {
          rules.set(eventType, []);
        }
        rules.get(eventType)!.push(...handlers);
      }
      return this;
    },
    get(eventType) {
      return rules.get(eventType) ?? [];
    },
    entries() {
      return rules.entries();
    },
  };
}
