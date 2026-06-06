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
  createLlmChatCompletion,
  getConfiguredLlmModel,
  getConfiguredLlmProvider,
  isLlmConfigured,
} from "@/lib/siliconflow";
import { sendDingTalkAlert } from "@/lib/dingtalk-alert";
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
    headerRowIndex: number;
    columnOptions: Array<{
      index: number;
      header: string;
      samples: string[];
    }>;
    rowCount: number;
    sectionCount: number;
    textPreview: string;
  };
  suggestedRule: UniversalImportRuleDsl;
  confidenceReport: AiConfidenceItem[];
  riskNotes: string[];
  provider: "deepseek" | "siliconflow" | "fallback";
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

async function ensureExamModeAccess() {
  // 考试模式不包含登录模块，AI 规则建议 API 直接开放给演示用户使用。
  return null;
}

function normalizeHeaderText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[()[\]{}<>【】“”"'`’‘、，。；：！？,.!?/\\|]/g, "");
}

function scoreHeaderRow(row: string[]) {
  const normalizedCells = row.map((cell) => normalizeHeaderText(cell)).filter(Boolean);
  if (normalizedCells.length === 0) {
    return 0;
  }

  const aliasScore = UNIVERSAL_IMPORT_FIELDS.reduce((score, field) => {
    const aliases = field.aliases.map((alias) => normalizeHeaderText(alias)).filter(Boolean);
    const matched = normalizedCells.some((cell) =>
      aliases.some((alias) => cell === alias || cell.includes(alias) || alias.includes(cell)),
    );
    return score + (matched ? 4 : 0);
  }, 0);

  return normalizedCells.length + aliasScore;
}

function inferBestHeaderRowIndex(document: Awaited<ReturnType<typeof parseImportDocument>>) {
  const rows = document.sections[0]?.rows ?? [];
  const candidates = rows.slice(0, 12);
  if (candidates.length === 0) {
    return 0;
  }

  return candidates.reduce(
    (best, row, index) => {
      const score = scoreHeaderRow(row);
      return score > best.score ? { index, score } : best;
    },
    { index: 0, score: 0 },
  ).index;
}

function getTransformConfig(rule: UniversalImportRuleDsl, transformType: string) {
  return rule.transforms.find((transform) => transform.type === transformType)?.config;
}

function getRecommendedHeaderRowIndex(document: Awaited<ReturnType<typeof parseImportDocument>>, rule: UniversalImportRuleDsl) {
  const headerConfig = getTransformConfig(rule, "header_mapping");
  const matrixConfig = getTransformConfig(rule, "matrix_pivot");
  const explicit = headerConfig?.headerRowIndex ?? matrixConfig?.headerRowIndex;

  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  if (typeof explicit === "string" && /^\d+$/.test(explicit.trim())) {
    return Number(explicit);
  }

  return inferBestHeaderRowIndex(document);
}

function buildColumnOptions(document: Awaited<ReturnType<typeof parseImportDocument>>, headerRowIndex: number) {
  const rows = document.sections[0]?.rows ?? [];
  const headers = rows[headerRowIndex] ?? document.headers ?? [];
  const maxColumnCount = rows.reduce((max, row) => Math.max(max, row.length), headers.length);
  const sampleRows = rows.slice(headerRowIndex + 1, headerRowIndex + 8);

  return Array.from({ length: maxColumnCount }, (_, index) => ({
    index,
    header: headers[index] || "",
    samples: sampleRows
      .map((row) => row[index])
      .filter((value): value is string => Boolean(value?.trim()))
      .slice(0, 3),
  }));
}

function buildDocumentSummary(
  fileType: SupportedImportFileType,
  document: Awaited<ReturnType<typeof parseImportDocument>>,
  rule: UniversalImportRuleDsl,
) {
  const headerRowIndex = getRecommendedHeaderRowIndex(document, rule);
  const columnOptions = buildColumnOptions(document, headerRowIndex);

  return {
    fileType,
    sheetName: document.sheetName,
    headers: columnOptions.map((option) => option.header),
    headerRowIndex,
    columnOptions,
    rowCount: document.rawRows.length,
    sectionCount: document.sections.length,
    textPreview: document.textContent.slice(0, 800),
  };
}

function getAiConfiguredFieldColumns(configs: Record<string, Record<string, unknown>> | undefined) {
  if (!configs) {
    return undefined;
  }

  const headerConfig = normalizeAiTransformConfig(configs.header_mapping ?? configs.headerMapping);
  const candidate = headerConfig.fieldColumns;
  if (!isRecord(candidate)) {
    return undefined;
  }

  return candidate as Partial<Record<UniversalImportField, number | null>>;
}

function mergeMappingCandidates(
  primary: Partial<Record<UniversalImportField, number | null>> | undefined,
  secondary: Partial<Record<UniversalImportField, number | null>> | undefined,
  fallback: UniversalImportMapping,
) {
  return Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => {
      const primaryValue = primary?.[field.key];
      const secondaryValue = secondary?.[field.key];
      return [
        field.key,
        typeof primaryValue === "number"
          ? primaryValue
          : typeof secondaryValue === "number"
            ? secondaryValue
            : fallback[field.key],
      ];
    }),
  ) as UniversalImportMapping;
}

function applyHeaderRecommendation(rule: UniversalImportRuleDsl, headerRowIndex: number, mapping: UniversalImportMapping) {
  const nextDataStartRowIndex = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > headerRowIndex
      ? value
      : headerRowIndex + 1;

  return {
    ...rule,
    mapping,
    transforms: rule.transforms.map((transform) =>
      transform.type === "header_mapping"
        ? {
            ...transform,
            enabled: true,
            config: {
              ...(transform.config ?? {}),
              headerRowIndex,
              dataStartRowIndex: nextDataStartRowIndex(transform.config?.dataStartRowIndex),
              fieldColumns: mapping,
            },
          }
        : transform,
    ),
  };
}

function createFallbackSuggestion(
  fileType: SupportedImportFileType,
  suggestedMapping: UniversalImportMapping,
  document: Awaited<ReturnType<typeof parseImportDocument>>,
): AiSuggestSuccessResponse {
  const suggestedRule = createDefaultRuleDsl(suggestedMapping, fileType);
  const headerRowIndex = inferBestHeaderRowIndex(document);
  const columnOptions = buildColumnOptions(document, headerRowIndex);
  const effectiveHeaders = columnOptions.map((option) => option.header);
  const effectiveMapping = fileType === "excel"
    ? mergeMappingCandidates(undefined, inferMappingFromHeaders(effectiveHeaders), suggestedMapping)
    : suggestedMapping;
  const recommendedRule = applyHeaderRecommendation(suggestedRule, headerRowIndex, effectiveMapping);
  const confidenceReport = UNIVERSAL_IMPORT_FIELDS.map((field) => ({
    field: field.key,
    confidence: typeof effectiveMapping[field.key] === "number" ? 0.92 : 0.45,
    source: typeof effectiveMapping[field.key] === "number" ? "header-match" : "heuristic-fallback",
  }));

  return {
    documentSummary: buildDocumentSummary(fileType, document, recommendedRule),
    suggestedRule: {
      ...recommendedRule,
      aiConfidenceReport: confidenceReport,
    },
    confidenceReport,
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

function parseAiJson(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    return JSON.parse(trimmed) as AiRuleSuggestion;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as AiRuleSuggestion;
    }

    throw new Error("LLM returned non-JSON content");
  }
}

function normalizeEnabledTransforms(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  return typeof value === "string"
    ? value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)
    : undefined;
}

function normalizeConfidenceReport(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is AiConfidenceItem => {
    if (!isRecord(item)) {
      return false;
    }

    return typeof item.field === "string" && typeof item.confidence === "number";
  });
}

function normalizeRiskNotes(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  return typeof value === "string" && value.trim() ? [value.trim()] : [];
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
  const headerCandidates = (firstSection?.rows ?? [])
    .slice(0, 12)
    .map((row, index) => ({
      rowIndex: index,
      score: scoreHeaderRow(row),
      cells: row,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  return {
    headRows,
    detailRows,
    tailRows,
    headerCandidates,
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
        "split_multiline_cell.config 用于日期×门店、门店×日期等矩阵中单元格含多行物品的场景，可包含 headerRowIndex、dataStartRowIndex、dataEndRowIndex、rowFieldColumns、matrixStartColumn、matrixEndColumn、columnValueField、itemRegex、itemDelimiterRegex、skuNameGroup、skuQuantityGroup、skuSpecGroup、skuCodeGroup、skuCodeTemplate、defaultSkuCodePrefix、externalCodeTemplate、excludeHeaderRegex",
        "split_multiline_cell 的 rowFieldColumns 映射纵向固定字段，例如 receiverStore 或 externalCode；matrixStartColumn/matrixEndColumn 覆盖横向日期/门店列；columnValueField 指定横向列头落到哪个字段，通常可设为 note 或 receiverStore",
        "如果单元格内容是“物品名x数量\\n物品名x数量”，请启用 split_multiline_cell，itemRegex 可使用 \"([^\\\\n\\\\r,，;；|]+?)\\\\s*(?:x|X|×|\\\\*)\\\\s*(\\\\d+(?:\\\\.\\\\d+)?)\"，skuNameGroup=1，skuQuantityGroup=2",
        "card_split.config 可包含 startRegex、itemHeaderRegex、fieldRegex、itemColumns",
        "text_record_split.config 可包含 recordSeparatorRegex、fieldRegex、item.regex 及 skuCodeGroup、skuNameGroup、skuSpecGroup、skuQuantityGroup",
        "一个 PDF/Word 内有多张独立订单时，请用 text_record_split.recordSeparatorRegex 按分隔线或订单标题拆记录，再用 fieldRegex 和 item.regex 在每条记录内配对收货信息与物品明细",
        "如果文档是 PDF 或弱结构文本，请重点说明哪些字段需要通过尾部文本、分段或卡片拆分提取",
        "如果结构摘要里已经出现收货人、收货电话、收货地址、收货门店等键值，请优先依据这些信息给出风险说明",
        "如果明细行中 SKU 编码、名称、规格、单位、数量出现在同一行，请给出更明确的结构化建议",
        "如果 structureSummary.headerCandidates 给出了高分候选行，请优先选择该行作为 header_mapping.config.headerRowIndex，并基于该行列号输出 mapping 或 fieldColumns",
      ],
    },
    null,
    2,
  );
}

async function generateRuleWithLlm(document: Awaited<ReturnType<typeof parseImportDocument>>, fileType: SupportedImportFileType, inferredMapping: UniversalImportMapping) {
  const content = await createLlmChatCompletion({
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
    maxTokens: 2600,
    timeoutMs: AI_SUGGEST_TIMEOUT_MS,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "universal_import_rule_suggestion",
        schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const parsed = parseAiJson(content);
  const confidenceReport = normalizeConfidenceReport(parsed.confidenceReport);
  const riskNotes = normalizeRiskNotes(parsed.riskNotes);
  const transformConfigs = isRecord(parsed.transformConfigs)
    ? parsed.transformConfigs as Record<string, Record<string, unknown>>
    : undefined;
  const aiMapping = mergeMappingCandidates(
    isRecord(parsed.mapping) ? parsed.mapping : undefined,
    getAiConfiguredFieldColumns(transformConfigs),
    inferredMapping,
  );
  const baseRule = createDefaultRuleDsl(aiMapping, fileType);
  const mode = parsed.mode ?? baseRule.mode;
  const mergedRule = ensureMultiSectionMerge(mergeTransformConfigs(mergeTransforms(
    {
      ...baseRule,
      mode,
      mapping: aiMapping,
    },
    normalizeEnabledTransforms(parsed.enabledTransforms),
  ), transformConfigs), document.sections.length);
  const headerRowIndex = getRecommendedHeaderRowIndex(document, mergedRule);
  const headerMapping = inferMappingFromHeaders(
    buildColumnOptions(document, headerRowIndex).map((option) => option.header),
  );
  const headerBackedMapping = mergeMappingCandidates(undefined, headerMapping, inferredMapping);
  const mapping = mergeMappingCandidates(
    isRecord(parsed.mapping) ? parsed.mapping : undefined,
    getAiConfiguredFieldColumns(transformConfigs),
    headerBackedMapping,
  );
  const suggestedRule = applyHeaderRecommendation(mergedRule, headerRowIndex, mapping);

  const normalizedConfidenceReport =
      confidenceReport?.map((item) => ({
        field: item.field,
        confidence: Math.max(0, Math.min(1, item.confidence)),
        source: item.source || "llm",
      })) ??
      UNIVERSAL_IMPORT_FIELDS.map((field) => ({
        field: field.key,
        confidence: typeof mapping[field.key] === "number" ? 0.8 : 0.3,
        source: "llm-default",
      }));

  return {
    suggestedRule: {
      ...suggestedRule,
      aiConfidenceReport: normalizedConfidenceReport,
    },
    confidenceReport: normalizedConfidenceReport,
    riskNotes,
    aiSummary: parsed.summary,
  };
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();
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

    if (!isLlmConfigured()) {
      return NextResponse.json(createFallbackSuggestion(fileType, inferredMapping, document));
    }

    try {
      const llmResult = await generateRuleWithLlm(document, fileType, inferredMapping);

      return NextResponse.json({
        documentSummary: buildDocumentSummary(fileType, document, llmResult.suggestedRule),
        suggestedRule: llmResult.suggestedRule,
        confidenceReport: llmResult.confidenceReport,
        riskNotes: llmResult.riskNotes,
        provider: getConfiguredLlmProvider(),
        model: getConfiguredLlmModel(),
        aiSummary: llmResult.aiSummary,
      });
    } catch (llmError) {
      console.error("LLM ai-suggest failed, fallback to heuristic", llmError);
      await sendDingTalkAlert({
        title: "万能导入 V2 AI 规则生成降级",
        message: llmError instanceof Error ? llmError.message : "LLM 调用失败，已降级为本地兜底规则。",
        tags: {
          module: "ai-suggest",
          provider: getConfiguredLlmProvider(),
          model: getConfiguredLlmModel(),
          fileType,
          fileName: file.name,
        },
      });
      return NextResponse.json(createFallbackSuggestion(fileType, inferredMapping, document));
    }
  } catch (error) {
    console.error("POST /api/universal-import/templates/ai-suggest failed", error);
    await sendDingTalkAlert({
      title: "万能导入 V2 AI 规则生成失败",
      message: error instanceof Error ? error.message : "AI 规则建议生成失败，请稍后重试。",
      tags: {
        module: "ai-suggest",
      },
    });
    return NextResponse.json({ error: "AI 规则建议生成失败，请稍后重试。" }, { status: 500 });
  }
}
