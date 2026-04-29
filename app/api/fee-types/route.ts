import { prisma } from "@/lib/prisma";
import { SYSTEM_USER_NAME } from "@/lib/fee-type-config";
import { type FeeTypePayload, validateFeeTypePayload } from "@/lib/fee-type-validation";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

function parseQuoteTypes(searchParams: URLSearchParams) {
  return searchParams
    .getAll("quoteType")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const feeCode = searchParams.get("feeCode")?.trim() ?? "";
    const feeName = searchParams.get("feeName")?.trim() ?? "";
    const businessDomain = searchParams.get("businessDomain")?.trim() ?? "";
    const quoteTypes = parseQuoteTypes(searchParams);

    const where: Prisma.FeeTypeWhereInput = {
      ...(feeCode
        ? {
            feeCode: {
              contains: feeCode,
              mode: "insensitive",
            },
          }
        : {}),
      ...(feeName
        ? {
            feeName: {
              contains: feeName,
              mode: "insensitive",
            },
          }
        : {}),
      ...(businessDomain ? { businessDomain } : {}),
      ...(quoteTypes.length > 0
        ? {
            quoteTypes: {
              hasSome: quoteTypes,
            },
          }
        : {}),
    };

    const feeTypes = await prisma.feeType.findMany({
      where,
      orderBy: {
        feeCode: "asc",
      },
    });

    return NextResponse.json({ feeTypes });
  } catch (error) {
    console.error("GET /api/fee-types failed", error);
    return NextResponse.json({ error: "查询费用类型失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as FeeTypePayload;
    const validation = validateFeeTypePayload(payload);

    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const feeType = await prisma.feeType.create({
      data: {
        ...validation.data,
        createdBy: SYSTEM_USER_NAME,
        updatedBy: SYSTEM_USER_NAME,
      },
    });

    return NextResponse.json({ feeType }, { status: 201 });
  } catch (error) {
    console.error("POST /api/fee-types failed", error);

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json({ error: "费用编号已存在，请重新输入。" }, { status: 409 });
    }

    return NextResponse.json({ error: "新增费用类型失败，请稍后重试。" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { ids?: string[] };
    const ids = Array.from(new Set(body.ids?.filter(Boolean) ?? []));

    if (ids.length === 0) {
      return NextResponse.json({ error: "请至少选择一条费用类型数据。" }, { status: 400 });
    }

    const result = await prisma.feeType.deleteMany({
      where: {
        id: {
          in: ids,
        },
      },
    });

    return NextResponse.json({ deletedCount: result.count });
  } catch (error) {
    console.error("DELETE /api/fee-types failed", error);
    return NextResponse.json({ error: "删除费用类型失败，请稍后重试。" }, { status: 500 });
  }
}
