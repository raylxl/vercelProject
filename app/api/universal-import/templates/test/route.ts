import {
  buildTemplateFingerprint,
  inferBestImportHeaderRowIndex,
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
import { resolveImportFileType } from "@/lib/universal-import-file-type";
import { buildHeuristicImportRule } from "@/lib/universal-import-heuristics";
import { mergeRiskNotes } from "@/lib/universal-import-risk";
import { sendDingTalkAlert } from "@/lib/dingtalk-alert";
import { ensureUniversalImportAccess } from "@/lib/universal-import-access";
import { NextResponse } from "next/server";

function parseJsonField<T>(rawValue: string, fieldName: string) {
  try {
    return JSON.parse(rawValue) as T;
  } catch {
    throw new Error(`${fieldName} 不是合法 JSON，请检查规则编辑器中的配置。`);
  }
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureUniversalImportAccess();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const requestedFileType = (formData.get("fileType")?.toString() || "excel") as SupportedImportFileType;
    const mappingRaw = formData.get("mapping")?.toString() ?? "";
    const ruleDslRaw = formData.get("ruleDsl")?.toString() ?? "";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请先上传样例文件后再试解析。" }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "文件为空，请重新上传包含出库单内容的文件。" }, { status: 400 });
    }

    const fileType = resolveImportFileType(file.name, requestedFileType);
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const document = await parseImportDocument({
      fileBuffer,
      fileType,
      originalFileName: file.name,
    }).catch((parseError) => {
      console.error("Rule test parse document failed", parseError);
      return null;
    });

    if (!document) {
      return NextResponse.json(
        {
          error:
            fileType === "word"
              ? "Word 文件内容暂时无法读取，请确认文件未损坏，或先转为 Excel/PDF 后重试。"
              : "文件内容暂时无法读取，请确认文件未损坏后重试。",
        },
        { status: 422 },
      );
    }

    const inferredHeaderRowIndex = inferBestImportHeaderRowIndex(document.sections[0]?.rows ?? [], 16);
    const inferredHeaders = document.sections[0]?.rows[inferredHeaderRowIndex] ?? document.headers;
    const inferredMapping = inferMappingFromHeaders(inferredHeaders);
    const heuristic = buildHeuristicImportRule(document, fileType);
    const mapping = mappingRaw
      ? parseJsonField<UniversalImportMapping>(mappingRaw, "字段映射")
      : heuristic.mapping;
    const ruleDsl = ruleDslRaw
      ? parseJsonField<UniversalImportRuleDsl>(ruleDslRaw, "解析规则 DSL")
      : mappingRaw
        ? createDefaultRuleDsl(mapping, fileType)
        : heuristic.rule;

    const effectiveRuleDsl = ruleDslRaw
      ? ruleDsl
      : mappingRaw
        ? {
            ...ruleDsl,
            mapping,
            transforms: ruleDsl.transforms.map((transform) =>
              transform.type === "header_mapping"
                ? {
                    ...transform,
                    config: {
                      ...(transform.config ?? {}),
                      headerRowIndex: inferredHeaderRowIndex,
                      dataStartRowIndex:
                        typeof transform.config?.dataStartRowIndex === "number" &&
                        transform.config.dataStartRowIndex > inferredHeaderRowIndex
                          ? transform.config.dataStartRowIndex
                          : inferredHeaderRowIndex + 1,
                      fieldColumns: mapping,
                    },
                  }
                : transform,
            ),
          }
        : {
            ...heuristic.rule,
            mapping,
          };

    const result = await executeUniversalImportRule({
      fileBuffer,
      fileType,
      originalFileName: file.name,
      rule: effectiveRuleDsl,
    });

    if ((result.rowCount ?? result.previewRows.length) === 0) {
      return NextResponse.json(
        {
          error: "未解析出任何有效下单数据，请检查样例文件、字段映射和 Transform Config 后重试。",
          document,
          summary: result.summary,
          inferredMapping,
          fingerprint: buildTemplateFingerprint(document.sheetName, document.headers),
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      ...result,
      fingerprint: buildTemplateFingerprint(document.sheetName, document.headers),
      inferredMapping,
      riskNotes: mergeRiskNotes(result.riskNotes),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "试解析失败，请稍后重试。";
    console.error("POST /api/universal-import/templates/test failed", error);
    await sendDingTalkAlert({
      title: "万能导入试解析失败",
      message,
      tags: {
        module: "rule-test",
      },
    });
    return NextResponse.json({ error: message }, { status: message.includes("JSON") ? 400 : 500 });
  }
}
