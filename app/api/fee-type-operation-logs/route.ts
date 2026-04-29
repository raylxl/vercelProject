import { OPERATION_LOG_TAKE } from "@/lib/fee-type-config";
import { isAuthenticated } from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: "请先登录后再访问。" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const requestedTake = Number.parseInt(
      searchParams.get("take") ?? String(OPERATION_LOG_TAKE),
      10,
    );
    const take = Number.isFinite(requestedTake)
      ? Math.min(Math.max(requestedTake, 1), 30)
      : OPERATION_LOG_TAKE;

    const logs = await prisma.feeTypeOperationLog.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take,
    });

    return NextResponse.json({ logs });
  } catch (error) {
    console.error("GET /api/fee-type-operation-logs failed", error);
    return NextResponse.json({ error: "查询操作日志失败，请稍后重试。" }, { status: 500 });
  }
}
