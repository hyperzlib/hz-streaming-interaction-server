import { AppError } from "../errors";
import type { EventContext } from "../types";
import type { RuleSet } from "./rule-set";

export async function executeRuleSet(
  ruleSet: RuleSet,
  eventType: string,
  ctx: EventContext,
  payload: unknown,
): Promise<void> {
  const handlers = ruleSet.get(eventType);
  let index = -1;

  const dispatch = async (i: number): Promise<void> => {
    if (i <= index) {
      throw new AppError("NEXT_CALLED_MULTIPLE_TIMES", "next() called multiple times", 500);
    }

    index = i;
    const handler = handlers[i];
    if (!handler) {
      return;
    }

    await handler(ctx, payload, () => dispatch(i + 1));
  };

  await dispatch(0);
}
