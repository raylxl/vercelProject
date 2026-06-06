import {
  inferMappingFromHeaders,
  UNIVERSAL_IMPORT_FIELDS,
  type UniversalImportField,
  type UniversalImportMapping,
} from "@/lib/universal-import";
import {
  createDefaultRuleDsl,
  parseImportDocument,
  type SupportedImportFileType,
  type UniversalImportRuleDsl,
} from "@/lib/universal-import-engine";
import {
  createSiliconFlowChatCompletion,
  getSiliconFlowModel,
  isSiliconFlowConfigured,
} from "@/lib/siliconflow";
import { isAuthenticated } from "@/lib/operator-session";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const AI_SUGGEST_TIMEOUT_MS = 40_000;

type AiConfidenceItem = {
  field: UniversalImportField;
  confidence: number;
  source: string;
};

type AiRuleSuggestion = {
  summary: string;
  mode?: UniversalImportRuleDsl["mode"];
  mapping?: Partial<Record<UniversalImportField, number | null>>;
  enabledTransforms?: string[];
  transformConfigs?: Record<string, Record<string, unknown>>;
  confidenceReport?: AiConfidenceItem[];
  riskNotes?: string[];
};

type AiSuggestSuccessResponse = {
  documentSummary: {
    fileType: SupportedImportFileType;
    sheetName: string;
    headers: string[];
    rowCount: number;
    sectionCount: number;
    textPreview: string;
  };
  suggestedRule: UniversalImportRuleDsl;
  confidenceReport: AiConfidenceItem[];
  riskNotes: string[];
  provider: "siliconflow" | "fallback";
  model: string;
  aiSummary: string;
};

const SUPPORTED_TRANSFORMS = new Set<UniversalImportRuleDsl["transforms"][number]["type"]>([
  "header_mapping",
  "multisheet_merge",
  "group_by_external_code",
  "matrix_pivot",
  "split_multiline_cell",
  "tail_text_extract",
  "card_split",
  "text_record_split",
]);

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    mode: {
      type: "string",
      enum: ["mapping", "text", "structured"],
    },
    mapping: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        UNIVERSAL_IMPORT_FIELDS.map((field) => [
          field.key,
          {
            anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
          },
        ]),
      ),
    },
    enabledTransforms: {
      type: "array",
      items: { type: "string" },
    },
    transformConfigs: {
      type: "object",
      additionalProperties: {
        type: "object",
      },
    },
    confidenceReport: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: {
            type: "string",
            enum: UNIVERSAL_IMPORT_FIELDS.map((field) => field.key),
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
          source: { type: "string" },
        },
        required: ["field", "confidence", "source"],
      },
    },
    riskNotes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "mode", "mapping", "enabledTransforms", "transformConfigs", "confidenceReport", "riskNotes"],
} as const;

async function ensureAuthenticated() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "请先登录后再访问。" }, { status: 401 });
  }

  return null;
}

function createFallbackSuggestion(
  fileType: SupportedImportFileType,
  suggestedMapping: UniversalImportMapping,
  document: Awaited<ReturnType<typeof parseImportDocument>>,
): AiSuggestSuccessResponse {
  const suggestedRule = createDefaultRuleDsl(suggestedMapping, fileType);

  return {
    documentSummary: {
      fileType,
      sheetName: document.sheetName,
      headers: document.headers,
      rowCount: document.rawRows.length,
      sectionCount: document.sections.length,
      textPreview: document.textContent.slice(0, 800),
    },
    suggestedRule,
    confidenceReport: UNIVERSAL_IMPORT_FIELDS.map((field) => ({
      field: field.key,
      confidence: typeof suggestedMapping[field.key] === "number" ? 0.92 : 0.45,
      source: typeof suggestedMapping[field.key] === "number" ? "header-match" : "heuristic-fallback",
    })),
    riskNotes: [
      fileType !== "excel" ? "当前为非 Excel 文档，部分字段来自文本结构推断，建议人工确认。" : "",
      document.sections.length > 1 ? "检测到多段或多 Sheet 内容，建议开启多 Sheet 合并或卡片拆分规则。" : "",
      document.rawRows.length === 0 ? "未识别到标准表格数据，建议切换到纯文本解析模式。" : "",
      "当前结果来自本地兜底规则，并非大模型输出。",
    ].filter(Boolean),
    provider: "fallback",
    model: "local-heuristic",
    aiSummary: "本次 AI 建议走了本地兜底逻辑，未使用远程大模型输出。",
  };
}

function normalizeMapping(candidate: Partial<Record<UniversalImportField, number | null>> | undefined, fallback: UniversalImportMapping) {
  return Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => {
      const value = candidate?.[field.key];
      return [field.key, typeof value === "number" ? value : fallback[field.key]];
    }),
  ) as UniversalImportMapping;
}

function mergeTransforms(baseRule: UniversalImportRuleDsl, enabledTransforms: string[] | undefined) {
  if (!enabledTransforms?.length) {
    return baseRule;
  }

  const enabledSet = new Set(
    enabledTransforms.filter(
      (transform): transform is UniversalImportRuleDsl["transforms"][number]["type"] =>
        SUPPORTED_TRANSFORMS.has(transform as UniversalImportRuleDsl["transforms"][number]["type"]),
    ),
  );

  return {
    ...baseRule,
    transforms: baseRule.transforms.map((transform) => ({
      ...transform,
      enabled: enabledSet.has(transform.type),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAiTransformConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!isRecord(config)) {
    return {};
  }

  const nested = isRecord(config.config) ? normalizeAiTransformConfig(config.config) : {};
  const output: Record<string, unknown> = {};

  Object.entries(config).forEach(([key, value]) => {
    if (key !== "config" && key !== "type") {
      output[key] = value;
    }
  });

  return {
    ...output,
    ...nested,
  };
}

function mergeTransformConfigs(baseRule: UniversalImportRuleDsl, configs: Record<string, Record<string, unknown>> | undefined) {
  if (!configs) {
    return baseRule;
  }

  return {
    ...baseRule,
    transforms: baseRule.transforms.map((transform) => ({
      ...transform,
      config: {
        ...(transform.config ?? {}),
        ...normalizeAiTransformConfig(configs[transform.type]),
      },
    })),
  };
}

function ensureMultiSectionMerge(rule: UniversalImportRuleDsl, sectionCount: number) {
  if (sectionCount <= 1) {
    return rule;
  }

  return {
    ...rule,
    transforms: rule.transforms.map((transform) =>
      transform.type === "multisheet_merge"
        ? {
            ...transform,
            enabled: true,
            config: {
              ...(transform.config ?? {}),
              mergeAllSheets: true,
            },
          }
        : transform,
    ),
  };
}

function summarizeDocumentStructure(document: Awaited<ReturnType<typeof parseImportDocument>>) {
  const firstSection = document.sections[0];
  const headRows = firstSection?.rows.slice(0, 8) ?? [];
  const tailRows = firstSection?.rows.slice(-8) ?? [];
  const detailRows = firstSection?.rows
    .filter((row) => row.filter(Boolean).length >= 3)
    .slice(0, 12) ?? [];

  return {
    headRows,
    detailRows,
    tailRows,
    sectionTitles: document.sections.map((section) => section.title).slice(0, 8),
  };
}

function buildPrompt(document: Awaited<ReturnType<typeof parseImportDocument>>, fileType: SupportedImportFileType) {
  const sectionPreview = document.sections.slice(0, 4).map((section, index) => ({
    index,
    title: section.title,
    rowCount: section.rows.length,
    rows: section.rows.slice(0, 8),
  }));
  const structureSummary = summarizeDocumentStructure(document);

  return JSON.stringify(
    {
      task: "根据物流批量下单文件结构生成可编辑的导入规则建议",
      fileType,
      sheetName: document.sheetName,
      headers: document.headers,
      rawRowCount: document.rawRows.length,
      sectionCount: document.sections.length,
      sectionPreview,
      structureSummary,
      textPreview: document.textContent.slice(0, 1400),
      targetFields: UNIVERSAL_IMPORT_FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        required: field.required,
      })),
      availableTransforms: [
        "header_mapping",
        "multisheet_merge",
        "group_by_external_code",
        "matrix_pivot",
        "split_multiline_cell",
        "tail_text_extract",
        "card_split",
        "text_record_split",
      ],
      constraints: [
        "不要编造不存在的列索引",
        "如无法确定映射，请返回 null 并在 riskNotes 说明",
        "Excel 更倾向 structured 或 mapping，Word/PDF 更倾向 text 或 structured",
        "confidenceReport 要逐字段返回 0 到 1 的置信度",
        "enabledTransforms 只返回需要启用的 transform type",
        "enabledTransforms 只能从给定的 availableTransforms 中选择",
        "transformConfigs 必须把每个启用 transform 的执行参数写清楚，执行器只解释这些配置，不会按文件名或样例类型自动适配",
        "transformConfigs 的 key 必须是 transform type，value 必须是直接配置对象，例如 {\"header_mapping\":{\"headerRowIndex\":1}}，禁止写成 {\"header_mapping\":{\"type\":\"header_mapping\",\"config\":{...}}}",
        "fieldColumns、rowFieldColumns、itemColumns 必须使用对象映射，例如 {\"skuCode\":2,\"skuName\":3,\"skuQuantity\":5}，禁止使用数组形式",
        "fieldRegex 必须优先使用对象映射，例如 {\"receiverName\":\"收货人[:：]\\\\s*(.+)\"}；如使用命名捕获组，命名必须等于目标字段 key",
        "text_record_split.item 的 skuCodeGroup、skuNameGroup、skuSpecGroup、skuQuantityGroup 优先返回数字捕获组序号；只有使用命名捕获组时才返回字段名字符串",
        "矩阵转置时 rowFieldColumns 必须映射 SKU 行上的固定字段，matrixStartColumn/matrixEndColumn 才是需要转置为 receiverStore + skuQuantity 的列范围",
        "如果 sectionCount 大于 1 且每个 Sheet 都是同结构订单，请启用 multisheet_merge，并为每个 Sheet 使用相同配置解释后合并",
        "如果启用了 matrix_pivot，header_mapping 通常只作为字段识别参考，不要依赖它单独生成明细行；除非确实需要双产出，否则不要设置 emitWithMatrix",
        "matrix_pivot 的 matrixStartColumn/matrixEndColumn 必须覆盖横向业务维度列（如门店、日期），不要把库存数量、可用数量、结余、合计等数值指标列当作 receiverStore",
        "tail_text_extract 可以和 text_record_split 组合使用：前者提取全局收货信息，后者提取物品行，试解析时文本物品行会继承全局字段",
        "正则要避免贪婪吞掉后续字段：电话只捕获手机号/座机号，姓名/门店/地址遇到 | 或下一个标签时应停止",
        "header_mapping.config 可包含 headerRowIndex、dataStartRowIndex、dataEndRowIndex、fieldColumns、requiredRowFields、skipRowRegex",
        "tail_text_extract.config 可包含 fieldRegex 或 keyValueLabels，用来从尾部/全文提取收货信息、外部编码等",
        "matrix_pivot.config 可包含 headerRowIndex、dataStartRowIndex、rowFieldColumns、matrixStartColumn、matrixEndColumn、excludeHeaderRegex、externalCodeTemplate",
        "card_split.config 可包含 startRegex、itemHeaderRegex、fieldRegex、itemColumns",
        "text_record_split.config 可包含 recordSeparatorRegex、fieldRegex、item.regex 及 skuCodeGroup、skuNameGroup、skuSpecGroup、skuQuantityGroup",
        "如果文档是 PDF 或弱结构文本，请重点说明哪些字段需要通过尾部文本、分段或卡片拆分提取",
        "如果结构摘要里已经出现收货人、收货电话、收货地址、收货门店等键值，请优先依据这些信息给出风险说明",
        "如果明细行中 SKU 编码、名称、规格、单位、数量出现在同一行，请给出更明确的结构化建议",
      ],
    },
    null,
    2,
  );
}

async function generateRuleWithLlm(document: Awaited<ReturnType<typeof parseImportDocument>>, fileType: SupportedImportFileType, inferredMapping: UniversalImportMapping) {
  const content = await createSiliconFlowChatCompletion({
    messages: [
      {
        role: "system",
        content:
          "你是物流万能导入规则设计助手。你要根据文档结构生成稳定、保守、可编辑的规则建议。必须返回合法 JSON，不要输出额外解释。",
      },
      {
        role: "user",
        content: buildPrompt(document, fileType),
      },
    ],
    temperature: 0.1,
    maxTokens: 1400,
    timeoutMs: AI_SUGGEST_TIMEOUT_MS,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "universal_import_rule_suggestion",
        schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const parsed = JSON.parse(content) as AiRuleSuggestion;
  const mapping = normalizeMapping(parsed.mapping, inferredMapping);
  const baseRule = createDefaultRuleDsl(mapping, fileType);
  const mode = parsed.mode ?? baseRule.mode;
  const suggestedRule = ensureMultiSectionMerge(mergeTransformConfigs(mergeTransforms(
    {
      ...baseRule,
      mode,
      mapping,
    },
    parsed.enabledTransforms,
  ), parsed.transformConfigs), document.sections.length);

  return {
    suggestedRule,
    confidenceReport:
      parsed.confidenceReport?.map((item) => ({
        field: item.field,
        confidence: Math.max(0, Math.min(1, item.confidence)),
        source: item.source || "llm",
      })) ??
      UNIVERSAL_IMPORT_FIELDS.map((field) => ({
        field: field.key,
        confidence: typeof mapping[field.key] === "number" ? 0.8 : 0.3,
        source: "llm-default",
      })),
    riskNotes: parsed.riskNotes?.filter(Boolean) ?? [],
    aiSummary: parsed.summary,
  };
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

    const inferredMapping = inferMappingFromHeaders(document.headers);

    if (!isSiliconFlowConfigured()) {
      return NextResponse.json(createFallbackSuggestion(fileType, inferredMapping, document));
    }

    try {
      const llmResult = await generateRuleWithLlm(document, fileType, inferredMapping);

      return NextResponse.json({
        documentSummary: {
          fileType,
          sheetName: document.sheetName,
          headers: document.headers,
          rowCount: document.rawRows.length,
          sectionCount: document.sections.length,
          textPreview: document.textContent.slice(0, 800),
        },
        suggestedRule: llmResult.suggestedRule,
        confidenceReport: llmResult.confidenceReport,
        riskNotes: llmResult.riskNotes,
        provider: "siliconflow",
        model: getSiliconFlowModel(),
        aiSummary: llmResult.aiSummary,
      });
    } catch (llmError) {
      console.error("SiliconFlow ai-suggest failed, fallback to heuristic", llmError);
      return NextResponse.json(createFallbackSuggestion(fileType, inferredMapping, document));
    }
  } catch (error) {
    console.error("POST /api/universal-import/templates/ai-suggest failed", error);
    return NextResponse.json({ error: "AI 规则建议生成失败，请稍后重试。" }, { status: 500 });
  }
}
