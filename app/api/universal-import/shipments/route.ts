import {
  formatIssueLabel,
  type UniversalImportRow,
  validateImportRows,
} from "@/lib/universal-import";
import { sendDingTalkAlert } from "@/lib/dingtalk-alert";
import { getOperatorNameFromSession } from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

type ShipmentDraft = {
  externalCode: string;
  receiverStore: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  note: string | null;
  sourceRowCount: number;
  rows: UniversalImportRow[];
};

type ShipmentSubmitResult = {
  externalCode: string;
  receiverLabel: string;
  sourceRowCount: number;
  status: "success" | "failed";
  shipmentId?: string;
  rowIndexes: number[];
  error?: string;
};

async function ensureExamModeAccess() {
  // 考试模式不包含登录模块，万能导入 V2 API 直接开放给演示用户使用。
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

function buildReceiverLabel(shipment: ShipmentDraft) {
  return (
    shipment.receiverStore ||
    shipment.receiverName ||
    shipment.receiverAddress ||
    "未填写收货信息"
  );
}

export async function GET(request: Request) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();

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
    const unauthorizedResponse = await ensureExamModeAccess();

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
      ruleId?: string;
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
      await sendDingTalkAlert({
        title: "万能导入 V2 提交校验失败",
        message: `本次提交存在 ${issues.length} 个未修正问题，系统已阻止入库。`,
        tags: {
          module: "shipment-submit",
          fileName: body.originalFileName,
          rowCount: rows.length,
          firstIssue: issues[0] ? formatIssueLabel(issues[0]) : "",
        },
      });
      return NextResponse.json(
        {
          error: "存在未修正的错误行，无法提交。",
          issues: issues.map(formatIssueLabel),
        },
        { status: 400 },
      );
    }

    const operatorName = await getOperatorNameFromSession();
    const batchName = body.batchName?.trim() || body.originalFileName?.trim() || "智能多格式批量下单批次";

    const shipmentMap = new Map<string, ShipmentDraft>();

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

    if (!body.ruleId?.trim()) {
      return NextResponse.json(
        { error: "请先手动选择解析规则后再提交，系统不会按文件自动匹配规则。" },
        { status: 400 },
      );
    }

    const rule = await prisma.universalImportRule.findUnique({
      where: {
        id: body.ruleId.trim(),
      },
      select: {
        id: true,
        version: true,
      },
    });

    if (!rule) {
      return NextResponse.json(
        { error: "选中的解析规则不存在，请重新选择规则。" },
        { status: 400 },
      );
    }

    const batch = await prisma.universalImportBatch.create({
      data: {
        batchName,
        originalFileName: body.originalFileName?.trim() || "",
        sourceSheetName: body.sheetName?.trim() || "",
        fileType: body.fileType?.trim() || "excel",
        ruleId: rule.id,
        ruleVersion: rule.version,
        totalRows: rows.length,
        successRows: 0,
        failedRows: rows.length,
        status: "PROCESSING",
        parseSummary: {
          headers: (body.headers ?? []).map((header) => String(header ?? "")),
          fingerprint: body.fingerprint ?? "",
          mapping: (body.mapping ?? {}) as Prisma.InputJsonValue,
          shipmentCount: shipmentMap.size,
        } as Prisma.InputJsonValue,
        createdBy: operatorName,
      },
    });

    const shipmentResults: ShipmentSubmitResult[] = [];

    for (const shipment of shipmentMap.values()) {
      try {
        const createdShipment = await prisma.$transaction(async (tx) => {
          const nextShipment = await tx.universalImportShipment.create({
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
              shipmentId: nextShipment.id,
              sourceRowIndex: row.rowIndex,
              skuCode: row.skuCode.trim(),
              skuName: row.skuName.trim(),
              skuQuantity: Number.parseFloat(row.skuQuantity.trim()),
              skuSpec: row.skuSpec.trim() || null,
              raw: row,
            })),
          });

          return nextShipment;
        });

        shipmentResults.push({
          externalCode: shipment.externalCode,
          receiverLabel: buildReceiverLabel(shipment),
          sourceRowCount: shipment.sourceRowCount,
          status: "success",
          shipmentId: createdShipment.id,
          rowIndexes: shipment.rows.map((row) => row.rowIndex),
        });
      } catch (shipmentError) {
        shipmentResults.push({
          externalCode: shipment.externalCode,
          receiverLabel: buildReceiverLabel(shipment),
          sourceRowCount: shipment.sourceRowCount,
          status: "failed",
          rowIndexes: shipment.rows.map((row) => row.rowIndex),
          error: shipmentError instanceof Error ? shipmentError.message : "运单入库失败",
        });
      }
    }

    const successShipments = shipmentResults.filter((item) => item.status === "success");
    const failedShipments = shipmentResults.filter((item) => item.status === "failed");
    const successCount = successShipments.reduce((total, item) => total + item.sourceRowCount, 0);
    const failCount = failedShipments.reduce((total, item) => total + item.sourceRowCount, 0);

    const result = await prisma.universalImportBatch.update({
      where: {
        id: batch.id,
      },
      data: {
        successRows: successCount,
        failedRows: failCount,
        status: failedShipments.length === 0 ? "COMPLETED" : successShipments.length === 0 ? "FAILED" : "PARTIAL_FAILED",
        parseSummary: {
          headers: (body.headers ?? []).map((header) => String(header ?? "")),
          fingerprint: body.fingerprint ?? "",
          mapping: (body.mapping ?? {}) as Prisma.InputJsonValue,
          shipmentCount: shipmentMap.size,
          successShipmentCount: successShipments.length,
          failedShipmentCount: failedShipments.length,
          shipmentResults,
        } as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json({
      batch: result,
      summary: {
        successCount,
        failCount,
        shipmentCount: successShipments.length,
        failedShipmentCount: failedShipments.length,
      },
      results: shipmentResults,
    });
  } catch (error) {
    console.error("POST /api/universal-import/shipments failed", error);
    await sendDingTalkAlert({
      title: "万能导入 V2 提交异常",
      message: error instanceof Error ? error.message : "提交失败，请稍后重试。",
      tags: {
        module: "shipment-submit",
      },
    });
    return NextResponse.json({ error: "提交失败，请稍后重试。" }, { status: 500 });
  }
}
