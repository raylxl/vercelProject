import {
  inferMappingFromHeaders,
  UNIVERSAL_IMPORT_FIELDS,
} from "@/lib/universal-import";
import {
  createDefaultRuleDsl,
  parseImportDocument,
  type SupportedImportFileType,
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

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请上传样例文件后再生成建议。" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const document = await parseImportDocument({
      fileBuffer,
      fileType,
      originalFileName: file.name,
    });

    const suggestedMapping = inferMappingFromHeaders(document.headers);
    const suggestedRule = createDefaultRuleDsl(suggestedMapping, fileType);

    const confidenceReport = UNIVERSAL_IMPORT_FIELDS.map((field) => ({
      field: field.key,
      confidence: typeof suggestedMapping[field.key] === "number" ? 0.92 : 0.45,
      source: typeof suggestedMapping[field.key] === "number" ? "header-match" : "inference",
    }));

    const riskNotes = [
      fileType !== "excel" ? "当前为非 Excel 文档，部分字段来自文本结构推断，建议人工确认。" : "",
      document.sections.length > 1 ? "检测到多段或多 Sheet 内容，建议开启多 Sheet 合并或卡片拆分规则。" : "",
      document.rawRows.length === 0 ? "未识别到标准表格数据，建议切换到纯文本解析模式。" : "",
    ].filter(Boolean);

    return NextResponse.json({
      documentSummary: {
        fileType,
        sheetName: document.sheetName,
        headers: document.headers,
        rowCount: document.rawRows.length,
        sectionCount: document.sections.length,
        textPreview: document.textContent.slice(0, 800),
      },
      suggestedRule,
      confidenceReport,
      riskNotes,
    });
  } catch (error) {
    console.error("POST /api/universal-import/templates/ai-suggest failed", error);
    return NextResponse.json({ error: "AI 规则建议生成失败，请稍后重试。" }, { status: 500 });
  }
}
