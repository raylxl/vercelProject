import {
  formatIssueLabel,
  type UniversalImportRow,
  validateImportRows,
} from "@/lib/universal-import";
import { getOperatorNameFromSession, isAuthenticated } from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

async function ensureAuthenticated() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "请先登录后再访问。" }, { status: 401 });
  }

  return null;
}

function parsePagination(searchParams: URLSearchParams) {
  const page = Math.max(Number.parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);
  const pageSize = Math.min(
    Math.max(Number.parseInt(searchParams.get("pageSize") ?? "10", 10) || 10, 1),
    1000,
  );

  return { page, pageSize };
}

export async function GET(request: Request) {
  try {
    const unauthorizedResponse = await ensureAuthenticated();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("query")?.trim() ?? "";
    const externalCode = searchParams.get("externalCode")?.trim() ?? "";
    const receiverName = searchParams.get("receiverName")?.trim() ?? "";
    const submittedAt = searchParams.get("submittedAt")?.trim() ?? "";
    const { page, pageSize } = parsePagination(searchParams);

    const submittedDate =
      submittedAt && !Number.isNaN(Date.parse(`${submittedAt}T00:00:00`))
        ? new Date(`${submittedAt}T00:00:00`)
        : null;
    const nextDate = submittedDate
      ? new Date(submittedDate.getTime() + 24 * 60 * 60 * 1000)
      : null;

    const where: Prisma.UniversalImportRecordWhereInput = {
      ...(externalCode
        ? {
            externalCode: {
              contains: externalCode,
              mode: "insensitive",
            },
          }
        : {}),
      ...(receiverName
        ? {
            receiverName: {
              contains: receiverName,
              mode: "insensitive",
            },
          }
        : {}),
      ...(query
        ? {
            OR: [
              {
                externalCode: {
                  contains: query,
                  mode: "insensitive",
                },
              },
              {
                receiverName: {
                  contains: query,
                  mode: "insensitive",
                },
              },
              {
                receiverPhone: {
                  contains: query,
                  mode: "insensitive",
                },
              },
              {
                batch: {
                  batchName: {
                    contains: query,
                    mode: "insensitive",
                  },
                },
              },
              {
                batch: {
                  originalFileName: {
                    contains: query,
                    mode: "insensitive",
                  },
                },
              },
            ],
          }
        : {}),
      ...(submittedDate && nextDate
        ? {
            createdAt: {
              gte: submittedDate,
              lt: nextDate,
            },
          }
        : {}),
    };

    const total = await prisma.universalImportRecord.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);

    const records = await prisma.universalImportRecord.findMany({
      where,
      include: {
        batch: true,
      },
      orderBy: [
        {
          createdAt: "desc",
        },
        {
          rowIndex: "asc",
        },
      ],
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
    });

    return NextResponse.json({
      records,
      total,
      page: currentPage,
      pageSize,
      totalPages,
    });
  } catch (error) {
    console.error("GET /api/universal-import/shipments failed", error);
    return NextResponse.json({ error: "查询运单失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureAuthenticated();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = (await request.json()) as {
      batchName?: string;
      originalFileName?: string;
      sheetName?: string;
      headers?: unknown[];
      rows?: UniversalImportRow[];
      mapping?: Record<string, number | null>;
      fingerprint?: string;
    };

    const rows = body.rows ?? [];
    const existingRecords = await prisma.universalImportRecord.findMany({
      select: { externalCode: true },
      where: {
        externalCode: { not: null },
      },
    });

    const existingExternalCodes = new Set(
      existingRecords.map((record) => record.externalCode?.toLowerCase() ?? ""),
    );

    const { issues } = validateImportRows(rows, existingExternalCodes);

    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: "存在未修正的错误行，无法提交。",
          issues: issues.map(formatIssueLabel),
        },
        { status: 400 },
      );
    }

    const operatorName = await getOperatorNameFromSession();
    const batchName = body.batchName?.trim() || body.originalFileName?.trim() || "万能导入批次";

    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.universalImportBatch.create({
        data: {
          batchName,
          originalFileName: body.originalFileName?.trim() || "",
          sheetName: body.sheetName?.trim() || "",
          totalRows: rows.length,
          successRows: rows.length,
          failedRows: 0,
          status: "COMPLETED",
          createdBy: operatorName,
        },
      });

      await tx.universalImportRecord.createMany({
        data: rows.map((row) => ({
          batchId: batch.id,
          externalCode: row.externalCode.trim() || null,
          senderName: row.senderName.trim(),
          senderPhone: row.senderPhone.trim(),
          senderAddress: row.senderAddress.trim(),
          receiverName: row.receiverName.trim(),
          receiverPhone: row.receiverPhone.trim(),
          receiverAddress: row.receiverAddress.trim(),
          weight: new Prisma.Decimal(row.weight.trim()),
          pieces: Number.parseInt(row.pieces.trim(), 10),
          temperature: row.temperature.trim(),
          note: row.note.trim() || null,
          rowIndex: row.rowIndex,
          raw: row,
        })),
      });

      return batch;
    });

    return NextResponse.json({
      batch: result,
      summary: {
        successCount: rows.length,
        failCount: 0,
      },
    });
  } catch (error) {
    console.error("POST /api/universal-import/shipments failed", error);
    return NextResponse.json({ error: "提交失败，请稍后重试。" }, { status: 500 });
  }
}
