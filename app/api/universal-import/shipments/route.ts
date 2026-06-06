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

    const where = {
      ...(externalCode
        ? {
            externalCode: {
              contains: externalCode,
              mode: "insensitive" as const,
            },
          }
        : {}),
      ...(receiverName
        ? {
            receiverName: {
              contains: receiverName,
              mode: "insensitive" as const,
            },
          }
        : {}),
      ...(query
        ? {
            OR: [
              {
                externalCode: {
                  contains: query,
                  mode: "insensitive" as const,
                },
              },
              {
                receiverName: {
                  contains: query,
                  mode: "insensitive" as const,
                },
              },
              {
                receiverStore: {
                  contains: query,
                  mode: "insensitive" as const,
                },
              },
              {
                batch: {
                  batchName: {
                    contains: query,
                    mode: "insensitive" as const,
                  },
                },
              },
              {
                batch: {
                  originalFileName: {
                    contains: query,
                    mode: "insensitive" as const,
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

    const total = await prisma.universalImportShipment.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);

    const records = await prisma.universalImportShipment.findMany({
      where,
      include: {
        batch: true,
        items: {
          orderBy: {
            sourceRowIndex: "asc",
          },
        },
      },
      orderBy: [
        {
          createdAt: "desc",
        },
        {
          externalCode: "asc",
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
      fileType?: string;
      sheetName?: string;
      headers?: unknown[];
      rows?: UniversalImportRow[];
      mapping?: Record<string, number | null>;
      fingerprint?: string;
    };

    const rows = body.rows ?? [];

    const importExternalCodes = Array.from(
      new Set(
        rows
          .map((row) => row.externalCode.trim())
          .filter(Boolean),
      ),
    );

    const existingShipments =
      importExternalCodes.length === 0
        ? []
        : await prisma.universalImportShipment.findMany({
            where: {
              externalCode: {
                in: importExternalCodes,
              },
            },
            select: {
              externalCode: true,
              batch: {
                select: {
                  batchName: true,
                  createdAt: true,
                },
              },
            },
          });

    const existingExternalCodes = existingShipments.map((record) => ({
      externalCode: record.externalCode,
      batchName: record.batch.batchName,
      batchCreatedAt: record.batch.createdAt.toISOString(),
    }));

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

    const shipmentMap = new Map<
      string,
      {
        externalCode: string;
        receiverStore: string | null;
        receiverName: string | null;
        receiverPhone: string | null;
        receiverAddress: string | null;
        note: string | null;
        sourceRowCount: number;
        rows: UniversalImportRow[];
      }
    >();

    rows.forEach((row) => {
      const externalCode = row.externalCode.trim() || `AUTO-${row.rowIndex}`;
      const current = shipmentMap.get(externalCode);

      if (current) {
        current.rows.push(row);
        current.sourceRowCount += 1;
        if (!current.receiverStore && row.receiverStore.trim()) {
          current.receiverStore = row.receiverStore.trim();
        }
        if (!current.receiverName && row.receiverName.trim()) {
          current.receiverName = row.receiverName.trim();
        }
        if (!current.receiverPhone && row.receiverPhone.trim()) {
          current.receiverPhone = row.receiverPhone.trim();
        }
        if (!current.receiverAddress && row.receiverAddress.trim()) {
          current.receiverAddress = row.receiverAddress.trim();
        }
        if (!current.note && row.note.trim()) {
          current.note = row.note.trim();
        }
        return;
      }

      shipmentMap.set(externalCode, {
        externalCode,
        receiverStore: row.receiverStore.trim() || null,
        receiverName: row.receiverName.trim() || null,
        receiverPhone: row.receiverPhone.trim() || null,
        receiverAddress: row.receiverAddress.trim() || null,
        note: row.note.trim() || null,
        sourceRowCount: 1,
        rows: [row],
      });
    });

    const rule = body.fingerprint?.trim()
      ? await prisma.universalImportRule.findUnique({
          where: {
            fingerprint: body.fingerprint.trim(),
          },
          select: {
            id: true,
            version: true,
          },
        })
      : null;

    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.universalImportBatch.create({
        data: {
          batchName,
          originalFileName: body.originalFileName?.trim() || "",
          sourceSheetName: body.sheetName?.trim() || "",
          fileType: body.fileType?.trim() || "excel",
          ruleId: rule?.id ?? null,
          ruleVersion: rule?.version ?? null,
          totalRows: rows.length,
          successRows: rows.length,
          failedRows: 0,
          status: "COMPLETED",
          parseSummary: {
            headers: (body.headers ?? []).map((header) => String(header ?? "")),
            fingerprint: body.fingerprint ?? "",
            mapping: (body.mapping ?? {}) as Prisma.InputJsonValue,
            shipmentCount: shipmentMap.size,
          } as Prisma.InputJsonValue,
          createdBy: operatorName,
        },
      });

      for (const shipment of shipmentMap.values()) {
        const createdShipment = await tx.universalImportShipment.create({
          data: {
            batchId: batch.id,
            externalCode: shipment.externalCode,
            receiverStore: shipment.receiverStore,
            receiverName: shipment.receiverName,
            receiverPhone: shipment.receiverPhone,
            receiverAddress: shipment.receiverAddress,
            note: shipment.note,
            sourceRowCount: shipment.sourceRowCount,
            raw: shipment.rows,
          },
        });

        await tx.universalImportShipmentItem.createMany({
          data: shipment.rows.map((row) => ({
            shipmentId: createdShipment.id,
            sourceRowIndex: row.rowIndex,
            skuCode: row.skuCode.trim(),
            skuName: row.skuName.trim(),
            skuQuantity: Number.parseFloat(row.skuQuantity.trim()),
            skuSpec: row.skuSpec.trim() || null,
            raw: row,
          })),
        });
      }

      return batch;
    });

    return NextResponse.json({
      batch: result,
      summary: {
        successCount: rows.length,
        failCount: 0,
        shipmentCount: shipmentMap.size,
      },
    });
  } catch (error) {
    console.error("POST /api/universal-import/shipments failed", error);
    return NextResponse.json({ error: "提交失败，请稍后重试。" }, { status: 500 });
  }
}
