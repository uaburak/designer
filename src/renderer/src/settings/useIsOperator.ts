import { useEffect, useState } from "react";
import type { AccountUsage } from "@shared/quota";
import { useAccount } from "../files/account";
import { accountCall } from "./bridge";

/** Whether the signed-in account operates the server (asked once per account; `ask` false: not asked, false): Settings › Operator, Home's Developer button */
export function useIsOperator(ask = true): boolean {
  const userId = useAccount().state?.user?.id ?? null;
  const [answer, setAnswer] = useState<{ userId: string; operator: boolean } | null>(null);
  useEffect(() => {
    if (!userId || !ask) return;
    let live = true;
    accountCall<AccountUsage>("GET", "/me/usage").then(
      (u) => live && setAnswer({ userId, operator: u.operator === true }),
      () => live && setAnswer({ userId, operator: false }),
    );
    return () => {
      live = false;
    };
  }, [userId, ask]);
  return !!userId && answer?.userId === userId && answer.operator;
}
