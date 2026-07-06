import { isAuthenticated, isExamModeEnabled } from "@/lib/operator-session";
import { NextResponse } from "next/server";

export async function ensureUniversalImportAccess() {
  if (isExamModeEnabled()) {
    return null;
  }

  if (await isAuthenticated()) {
    return null;
  }

  return NextResponse.json(
    {
      error: "请先登录后再操作万能导入。",
    },
    { status: 401 },
  );
}
