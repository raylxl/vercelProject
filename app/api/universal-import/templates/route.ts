import {
  buildTemplateFingerprint,
  inferMappingFromHeaders,
  type UniversalImportMapping,
} from "@/lib/universal-import";
import { getOperatorNameFromSession, isAuthenticated } from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

async function ensureAuthenticated() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "请先登录后再访问。" }, { status: 401 });
  }

  return null;
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
      const templates = await prisma.universalImportTemplate.findMany({
        orderBy: { updatedAt: "desc" },
        take: 20,
      });

      return NextResponse.json({ templates });
    }

    const template = await prisma.universalImportTemplate.findUnique({
      where: { fingerprint },
    });

    return NextResponse.json({ template });
  } catch (error) {
    console.error("GET /api/universal-import/templates failed", error);
    return NextResponse.json({ error: "查询模板失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureAuthenticated();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = (await request.json()) as {
      sheetName?: string;
      headers?: unknown[];
      mapping?: UniversalImportMapping;
    };

    const headers = body.headers ?? [];
    const fingerprint = buildTemplateFingerprint(body.sheetName ?? "Sheet1", headers);
    const inferredMapping = inferMappingFromHeaders(headers);
    const operatorName = await getOperatorNameFromSession();

    const template = await prisma.universalImportTemplate.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        templateName: body.sheetName?.trim() || "Excel模板",
        mapping: body.mapping ?? inferredMapping,
        createdBy: operatorName,
        updatedBy: operatorName,
      },
      update: {
        templateName: body.sheetName?.trim() || "Excel模板",
        mapping: body.mapping ?? inferredMapping,
        updatedBy: operatorName,
      },
    });

    return NextResponse.json({ template });
  } catch (error) {
    console.error("POST /api/universal-import/templates failed", error);
    return NextResponse.json({ error: "保存模板失败，请稍后重试。" }, { status: 500 });
  }
}
