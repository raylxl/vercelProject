import { buildUpdateSummary } from "@/lib/fee-type-operation-log";
import {
  getOperatorNameFromSession,
  isAuthenticated,
} from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { type FeeTypePayload, validateFeeTypePayload } from "@/lib/fee-type-validation";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await isAuthenticated())) {
      return NextResponse.json({ error: "请先登录后再访问。" }, { status: 401 });
    }

    const { id } = await context.params;
    const payload = (await request.json()) as FeeTypePayload;
    const validation = validateFeeTypePayload(payload);

    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const existing = await prisma.feeType.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json({ error: "未找到需要编辑的费用类型。" }, { status: 404 });
    }

    if (existing.feeCode !== validation.data.feeCode) {
      return NextResponse.json({ error: "编辑时不允许修改费用编号。" }, { status: 400 });
    }

    const operatorName = await getOperatorNameFromSession();

    const feeType = await prisma.$transaction(async (tx) => {
      const updated = await tx.feeType.update({
        where: { id },
        data: {
          feeName: validation.data.feeName,
          businessDomain: validation.data.businessDomain,
          quoteTypes: validation.data.quoteTypes,
          note: validation.data.note,
          updatedBy: operatorName,
        },
      });

      await tx.feeTypeOperationLog.create({
        data: {
          feeTypeId: updated.id,
          feeCode: updated.feeCode,
          feeName: updated.feeName,
          operationType: "UPDATE",
          operatorName,
          summary: buildUpdateSummary(existing, {
            feeCode: updated.feeCode,
            feeName: updated.feeName,
            businessDomain: updated.businessDomain,
            quoteTypes: updated.quoteTypes,
            note: updated.note,
          }),
        },
      });

      return updated;
    });

    return NextResponse.json({ feeType });
  } catch (error) {
    console.error("PUT /api/fee-types/[id] failed", error);

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "未找到需要编辑的费用类型。" }, { status: 404 });
    }

    return NextResponse.json({ error: "编辑费用类型失败，请稍后重试。" }, { status: 500 });
  }
}
