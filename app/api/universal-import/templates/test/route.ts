import {
  buildTemplateFingerprint,
  inferMappingFromHeaders,
  type UniversalImportMapping,
} from "@/lib/universal-import";
import {
  createDefaultRuleDsl,
  executeUniversalImportRule,
  parseImportDocument,
  type SupportedImportFileType,
  type UniversalImportRuleDsl,
} from "@/lib/universal-import-engine";
import { isAuthenticated } from "@/lib/operator-session";
import { NextResponse } from "next/server";

async function ensureAuthenticated() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "请先登录后再访问。" }, { status: 401 });
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureAuthenticated();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const fileType = (formData.get("fileType")?.toString() || "excel") as SupportedImportFileType;
    const mappingRaw = formData.get("mapping")?.toString() ?? "";
    const ruleDslRaw = formData.get("ruleDsl")?.toString() ?? "";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请上传样例文件后再试解析。" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const document = await parseImportDocument({
      fileBuffer,
      fileType,
      originalFileName: file.name,
    });

    const inferredMapping = inferMappingFromHeaders(document.headers);
    const mapping = mappingRaw
      ? (JSON.parse(mappingRaw) as UniversalImportMapping)
      : inferredMapping;
    const ruleDsl = ruleDslRaw
      ? (JSON.parse(ruleDslRaw) as UniversalImportRuleDsl)
      : createDefaultRuleDsl(mapping, fileType);

    const result = await executeUniversalImportRule({
      fileBuffer,
      fileType,
      originalFileName: file.name,
      rule: ruleDsl,
    });

    return NextResponse.json({
      ...result,
      fingerprint: buildTemplateFingerprint(document.sheetName, document.headers),
      inferredMapping,
    });
  } catch (error) {
    console.error("POST /api/universal-import/templates/test failed", error);
    return NextResponse.json({ error: "试解析失败，请稍后重试。" }, { status: 500 });
  }
}
