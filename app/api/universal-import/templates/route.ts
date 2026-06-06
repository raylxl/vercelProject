import {
  buildTemplateFingerprint,
  inferMappingFromHeaders,
  type UniversalImportMapping,
} from "@/lib/universal-import";
import {
  createDefaultRuleDsl,
  type SupportedImportFileType,
} from "@/lib/universal-import-engine";
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

function buildSampleMeta(headers: unknown[]) {
  return {
    headers: headers.map((header) => String(header ?? "")),
    source: "manual-mapping",
  } as Prisma.InputJsonValue;
}

function createRuleFingerprint(sheetName: string, headers: unknown[]) {
  return `${buildTemplateFingerprint(sheetName, headers)}::${crypto.randomUUID()}`;
}

export async function GET(request: Request) {
  try {
    const unauthorizedResponse = await ensureAuthenticated();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { searchParams } = new URL(request.url);
    const fingerprint = searchParams.get("fingerprint")?.trim() ?? "";

    if (!fingerprint) {
      const templates = await prisma.universalImportRule.findMany({
        orderBy: { updatedAt: "desc" },
        take: 50,
        include: {
          _count: {
            select: {
              batches: true,
            },
          },
        },
      });

      return NextResponse.json({ templates });
    }

    const template = await prisma.universalImportRule.findUnique({
      where: { fingerprint },
      include: {
        _count: {
          select: {
            batches: true,
          },
        },
      },
    });

    return NextResponse.json({ template });
  } catch (error) {
    console.error("GET /api/universal-import/templates failed", error);
    return NextResponse.json({ error: "查询规则失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureAuthenticated();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = (await request.json()) as {
      ruleName?: string;
      sheetName?: string;
      headers?: unknown[];
      mapping?: UniversalImportMapping;
      fileType?: SupportedImportFileType;
      status?: string;
      ruleDsl?: Prisma.InputJsonValue;
    };

    const headers = body.headers ?? [];
    const fingerprint = createRuleFingerprint(body.sheetName ?? "Sheet1", headers);
    const inferredMapping = inferMappingFromHeaders(headers);
    const operatorName = await getOperatorNameFromSession();
    const fileType = (body.fileType?.trim() || "excel") as SupportedImportFileType;
    const mapping = body.mapping ?? inferredMapping;
    const ruleDsl = body.ruleDsl ?? (createDefaultRuleDsl(mapping, fileType) as Prisma.InputJsonValue);
    const sampleMeta = buildSampleMeta(headers);

    const template = await prisma.universalImportRule.create({
      data: {
        fingerprint,
        ruleName: body.ruleName?.trim() || body.sheetName?.trim() || "导入规则",
        fileType,
        status: body.status?.trim() || "ACTIVE",
        mapping,
        ruleDsl,
        sampleMeta,
        createdBy: operatorName,
        updatedBy: operatorName,
      },
      include: {
        _count: {
          select: {
            batches: true,
          },
        },
      },
    });

    return NextResponse.json({ template });
  } catch (error) {
    console.error("POST /api/universal-import/templates failed", error);
    return NextResponse.json({ error: "保存规则失败，请稍后重试。" }, { status: 500 });
  }
}
