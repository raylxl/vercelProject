import { OPERATOR_COOKIE_NAME, SYSTEM_USER_NAME } from "@/lib/fee-type-config";
import { cookies } from "next/headers";

export function normalizeOperatorName(input: string | null | undefined) {
  const value = input?.trim() ?? "";

  if (!value) {
    return SYSTEM_USER_NAME;
  }

  return value.slice(0, 32);
}

export async function getOperatorNameFromSession() {
  const cookieStore = await cookies();
  return normalizeOperatorName(cookieStore.get(OPERATOR_COOKIE_NAME)?.value);
}
