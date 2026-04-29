import { OPERATOR_COOKIE_NAME } from "@/lib/fee-type-config";
import {
  getOperatorNameFromSession,
  normalizeOperatorName,
} from "@/lib/operator-session";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const operatorName = await getOperatorNameFromSession();
  return NextResponse.json({ operatorName });
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { operatorName?: string };
    const operatorName = normalizeOperatorName(body.operatorName);
    const cookieStore = await cookies();

    cookieStore.set(OPERATOR_COOKIE_NAME, operatorName, {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });

    return NextResponse.json({ operatorName });
  } catch (error) {
    console.error("PUT /api/session failed", error);
    return NextResponse.json({ error: "切换登录人失败，请稍后重试。" }, { status: 500 });
  }
}
