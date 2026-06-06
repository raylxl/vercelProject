"use client";

import * as XLSX from "xlsx";
import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  UNIVERSAL_IMPORT_FIELDS,
  UNIVERSAL_IMPORT_FIELD_LABELS,
  formatIssueLabel,
  type ExistingExternalCodeEntry,
  type UniversalImportField,
  type UniversalImportIssue,
  type UniversalImportMapping,
  type UniversalImportRow,
  validateImportRows,
} from "@/lib/universal-import";
import type {
  RuleTransformType,
  SupportedImportFileType,
  UniversalImportRuleDsl,
} from "@/lib/universal-import-engine";

type ToastTone = "success" | "error" | "info";

type DraftRow = UniversalImportRow & {
  id: string;
};

type ShipmentHistoryRecord = {
  id: string;
  externalCode: string;
  receiverStore: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  note: string | null;
  sourceRowCount: number;
  createdAt: string;
  items: Array<{
    id: string;
    sourceRowIndex: number;
    skuCode: string;
    skuName: string;
    skuQuantity: number;
    skuSpec: string | null;
  }>;
  batch: {
    batchName: string;
    originalFileName: string;
    sourceSheetName: string;
    fileType: string;
    status: string;
    totalRows: number;
    createdBy: string;
    createdAt: string;
  };
};

type ShipmentHistoryResponse = {
  records?: ShipmentHistoryRecord[];
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  error?: string;
};

type RuleRecord = {
  id: string;
  fingerprint: string;
  ruleName: string;
  fileType: string;
  version: number;
  status: string;
  mapping: UniversalImportMapping;
  ruleDsl?: UniversalImportRuleDsl | null;
  sampleMeta?: unknown;
  updatedAt: string;
  createdAt: string;
  _count?: {
    batches: number;
  };
};

type RuleListResponse = {
  templates?: RuleRecord[];
  error?: string;
};

type RuleUpsertResponse = {
  template?: RuleRecord | null;
  error?: string;
};

type RuleTestResponse = {
  previewRows?: UniversalImportRow[];
  issues?: string[];
  issueCount?: number;
  rowCount?: number;
  summary?: string[];
  fingerprint?: string;
  inferredMapping?: UniversalImportMapping;
  document?: {
    fileType: SupportedImportFileType;
    sheetName: string;
    headers: string[];
    rawRows: string[][];
    textContent: string;
    sections: Array<{
      title: string;
      rows: string[][];
      text: string;
    }>;
  };
  error?: string;
};

type AiSuggestResponse = {
  documentSummary?: {
    fileType: SupportedImportFileType;
    sheetName: string;
    headers: string[];
    rowCount: number;
    sectionCount: number;
  };
  suggestedRule?: UniversalImportRuleDsl;
  confidenceReport?: AiConfidenceItem[];
  riskNotes?: string[];
  provider?: string;
  model?: string;
  aiSummary?: string;
  error?: string;
};

type AiConfidenceItem = {
  field: UniversalImportField;
  confidence: number;
  source: string;
};

type HistoryFilters = {
  query: string;
  externalCode: string;
  receiverName: string;
  submittedAt: string;
  page: number;
  pageSize: number;
};

type SidebarMenuItem = {
  label: string;
  href?: string;
  children?: SidebarMenuItem[];
};

type ProgressState = {
  active: boolean;
  value: number;
  label: string;
  processed: number;
  total: number;
};

type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
};

const DEFAULT_MAPPING = Object.fromEntries(
  UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, null]),
) as UniversalImportMapping;

const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  query: "",
  externalCode: "",
  receiverName: "",
  submittedAt: "",
  page: 1,
  pageSize: 10,
};

const PREVIEW_INITIAL_RENDER_COUNT = 160;
const PREVIEW_RENDER_BATCH_SIZE = 160;
const MAX_VISIBLE_ISSUES = 200;

const TOP_NAV_ITEMS = ["智能多格式批量下单系统"] as const;

const UNIVERSAL_SIDEBAR_MENUS: SidebarMenuItem[] = [
  {
    label: "智能多格式批量下单系统",
    children: [
      { label: "万能导入V2", href: "/universal-import" },
      { label: "规则管理", href: "/universal-import?tab=rules" },
      { label: "历史运单", href: "/universal-import?tab=history" },
    ],
  },
];

function createRowId() {
  return globalThis.crypto.randomUUID();
}

function createEmptyDraftRow(rowIndex: number): DraftRow {
  return {
    externalCode: "",
    receiverStore: "",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
    skuCode: "",
    skuName: "",
    skuQuantity: "",
    skuSpec: "",
    note: "",
    rowIndex,
    id: createRowId(),
  };
}

function toDraftRows(rows: UniversalImportRow[]) {
  return rows.map((row, index) => ({
    ...row,
    rowIndex: index + 1,
    id: createRowId(),
  }));
}

function toSafeSheetName(name: string) {
  return name.trim().slice(0, 30) || "Sheet1";
}

function downloadWorkbook(rows: DraftRow[], sheetName: string) {
  const workbook = XLSX.utils.book_new();
  const exportRows = rows.map((row) =>
    Object.fromEntries(
      UNIVERSAL_IMPORT_FIELDS.map((field) => [
        UNIVERSAL_IMPORT_FIELD_LABELS[field.key],
        row[field.key],
      ]),
    ),
  );
  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  XLSX.utils.book_append_sheet(workbook, worksheet, toSafeSheetName(sheetName));
  XLSX.writeFile(workbook, `${toSafeSheetName(sheetName)}_预览导出.xlsx`);
}

function normalizeMapping(raw: unknown): UniversalImportMapping | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  return Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, typeof candidate[field.key] === "number" ? candidate[field.key] : null]),
  ) as UniversalImportMapping;
}

function getSampleHeaders(sampleMeta: unknown) {
  if (!sampleMeta || typeof sampleMeta !== "object") {
    return [];
  }

  const headers = (sampleMeta as { headers?: unknown }).headers;
  if (!Array.isArray(headers)) {
    return [];
  }

  return headers.map((header) => String(header ?? ""));
}

function buildDefaultRuleDsl(mapping: UniversalImportMapping, fileType: SupportedImportFileType): UniversalImportRuleDsl {
  return {
    fileType,
    mode: fileType === "excel" ? "mapping" : "text",
    mapping,
    transforms: [
      { type: "header_mapping", enabled: fileType === "excel" },
      { type: "multisheet_merge", enabled: fileType === "excel" },
      { type: "group_by_external_code", enabled: true },
      { type: "split_multiline_cell", enabled: true, config: { field: "skuName", quantityField: "skuQuantity" } },
      { type: "tail_text_extract", enabled: fileType !== "excel" },
    ],
  };
}

function makeFormData(file: File, fileType: SupportedImportFileType, mapping: UniversalImportMapping, ruleDsl: UniversalImportRuleDsl) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("fileType", fileType);
  formData.append("mapping", JSON.stringify(mapping));
  formData.append("ruleDsl", JSON.stringify(ruleDsl));
  return formData;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatFileTypeLabel(value: string) {
  if (value === "pdf") {
    return "PDF";
  }

  if (value === "word") {
    return "Word";
  }

  return "Excel";
}

function formatTransformConfig(config: Record<string, unknown> | undefined) {
  return JSON.stringify(config ?? {}, null, 2);
}

function getAiMappingStatus(item: AiConfidenceItem | undefined) {
  if (!item) {
    return {
      label: "需确认",
      tone: "warning",
      detail: "AI 未返回置信度，请人工确认",
    };
  }

  if (item.confidence >= 0.85) {
    return {
      label: "高置信",
      tone: "success",
      detail: `${Math.round(item.confidence * 100)}% / ${item.source}`,
    };
  }

  if (item.confidence >= 0.55) {
    return {
      label: "AI推测",
      tone: "info",
      detail: `${Math.round(item.confidence * 100)}% / ${item.source}`,
    };
  }

  return {
    label: "需确认",
    tone: "warning",
    detail: `${Math.round(item.confidence * 100)}% / ${item.source}`,
  };
}

function formatReceiverSummary(record: ShipmentHistoryRecord) {
  return (
    record.receiverStore ||
    [record.receiverName, record.receiverPhone].filter(Boolean).join(" / ") ||
    record.receiverAddress ||
    "-"
  );
}

export function UniversalImportClient({
  operatorName,
  initialTab = "import",
}: {
  operatorName: string;
  initialTab?: "import" | "history" | "rules";
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLInputElement>());
  const toastTimerRef = useRef<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState<SupportedImportFileType>("excel");
  const [fileName, setFileName] = useState("");
  const [sheetName, setSheetName] = useState("Sheet1");
  const [fingerprint, setFingerprint] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [mapping, setMapping] = useState<UniversalImportMapping>(DEFAULT_MAPPING);
  const [ruleDsl, setRuleDsl] = useState<UniversalImportRuleDsl>(buildDefaultRuleDsl(DEFAULT_MAPPING, "excel"));
  const [status, setStatus] = useState("");
  const [historyStatus, setHistoryStatus] = useState("");
  const [parseProgress, setParseProgress] = useState<ProgressState>({
    active: false,
    value: 0,
    label: "",
    processed: 0,
    total: 0,
  });
  const [submitProgress, setSubmitProgress] = useState<ProgressState>({
    active: false,
    value: 0,
    label: "",
    processed: 0,
    total: 0,
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyData, setHistoryData] = useState<ShipmentHistoryResponse>({});
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const [templateInfo, setTemplateInfo] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [existingCodeRows, setExistingCodeRows] = useState<ExistingExternalCodeEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"import" | "history" | "rules">(initialTab);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [previewRenderLimit, setPreviewRenderLimit] = useState(PREVIEW_INITIAL_RENDER_COUNT);
  const [ruleList, setRuleList] = useState<RuleRecord[]>([]);
  const [ruleLoading, setRuleLoading] = useState(false);
  const [ruleStatus, setRuleStatus] = useState("");
  const [ruleNameInput, setRuleNameInput] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [ruleTestSummary, setRuleTestSummary] = useState("");
  const [aiSummary, setAiSummary] = useState("");
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiRiskNotes, setAiRiskNotes] = useState<string[]>([]);
  const [aiConfidenceReport, setAiConfidenceReport] = useState<AiConfidenceItem[]>([]);
  const [aiProviderLabel, setAiProviderLabel] = useState("");
  const [aiModelLabel, setAiModelLabel] = useState("");
  const [transformConfigDrafts, setTransformConfigDrafts] = useState<Record<string, string>>({});
  const [expandedMenuPaths, setExpandedMenuPaths] = useState<string[]>([
    "智能多格式批量下单系统",
  ]);
  const [activeMenuPath, setActiveMenuPath] = useState("智能多格式批量下单系统/万能导入V2");
  const deferredDraftRows = useDeferredValue(draftRows);

  const existingExternalCodes = useMemo(
    () =>
      new Map(
        existingCodeRows
          .map((record) => [record.externalCode.trim().toLowerCase(), record] as const)
          .filter(([value]) => Boolean(value)),
      ),
    [existingCodeRows],
  );

  const validation = useMemo(
    () => validateImportRows(deferredDraftRows, existingExternalCodes),
    [deferredDraftRows, existingExternalCodes],
  );

  const errorRowCount = useMemo(
    () => new Set(validation.issues.map((issue) => issue.rowIndex)).size,
    [validation.issues],
  );

  const rowErrorsById = useMemo(() => {
    const map = new Map<string, UniversalImportIssue[]>();
    validation.issues.forEach((issue) => {
      const row = deferredDraftRows[issue.rowIndex - 1];
      if (!row) {
        return;
      }
      const current = map.get(row.id) ?? [];
      current.push(issue);
      map.set(row.id, current);
    });
    return map;
  }, [deferredDraftRows, validation.issues]);

  const rowErrorSummary = useMemo(
    () => validation.issues.map((issue) => formatIssueLabel(issue)),
    [validation.issues],
  );
  const visibleIssueSummary = useMemo(
    () => rowErrorSummary.slice(0, MAX_VISIBLE_ISSUES),
    [rowErrorSummary],
  );
  const hiddenIssueCount = Math.max(rowErrorSummary.length - visibleIssueSummary.length, 0);

  const historyShipmentCount = historyData.total ?? 0;
  const historyItemCount = useMemo(
    () => (historyData.records ?? []).reduce((sum, record) => sum + record.items.length, 0),
    [historyData.records],
  );
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const selectedHistoryRecord = useMemo(
    () => historyData.records?.find((record) => record.id === selectedHistoryId) ?? historyData.records?.[0] ?? null,
    [historyData.records, selectedHistoryId],
  );
  const hasBlockingErrors = validation.issues.length > 0;
  const allRowsSelected = draftRows.length > 0 && selectedIds.length === draftRows.length;
  const selectedCount = selectedIds.length;
  const totalCount = draftRows.length;
  const visibleDraftRows = useMemo(
    () => draftRows.slice(0, previewRenderLimit),
    [draftRows, previewRenderLimit],
  );
  const hiddenPreviewRowCount = Math.max(draftRows.length - visibleDraftRows.length, 0);
  const groupedPreviewCount = useMemo(() => new Set(draftRows.map((row) => row.externalCode.trim())).size, [draftRows]);
  const aiConfidenceByField = useMemo(
    () => new Map(aiConfidenceReport.map((item) => [item.field, item] as const)),
    [aiConfidenceReport],
  );

  function pushToast(message: string, tone: ToastTone = "info") {
    const id = createRowId();
    setToasts((current) => [...current, { id, message, tone }]);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 2600);
  }

  function syncRuleMapping(nextMapping: UniversalImportMapping) {
    setRuleDsl((current) => mergeRuleDslMapping(current, nextMapping));
  }

  function mergeRuleDslMapping(current: UniversalImportRuleDsl, nextMapping: UniversalImportMapping) {
    return {
      ...current,
      mapping: nextMapping,
      transforms: current.transforms.map((transform) =>
        transform.type === "header_mapping"
          ? {
              ...transform,
              config: {
                ...(transform.config ?? {}),
                fieldColumns: nextMapping,
              },
            }
          : transform,
      ),
    };
  }

  function handleMappingColumnChange(field: UniversalImportField, value: string) {
    const columnIndex = value === "" ? null : Number(value);
    const nextMapping = {
      ...mapping,
      [field]: Number.isFinite(columnIndex) ? columnIndex : null,
    } as UniversalImportMapping;

    setMapping(nextMapping);
    syncRuleMapping(nextMapping);
    setRuleStatus("映射列已更新，请确认后保存规则。");
  }

  function handleTransformConfigDraftChange(transformType: RuleTransformType, value: string) {
    setTransformConfigDrafts((current) => ({
      ...current,
      [transformType]: value,
    }));
  }

  function handleTransformConfigCommit(transformType: RuleTransformType) {
    const transform = ruleDsl.transforms.find((item) => item.type === transformType);
    const rawValue = transformConfigDrafts[transformType] ?? formatTransformConfig(transform?.config);
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Transform config 必须是 JSON 对象。");
      }

      setRuleDsl((current) => ({
        ...current,
        transforms: current.transforms.map((transform) =>
          transform.type === transformType
            ? {
                ...transform,
                config: parsed as Record<string, unknown>,
              }
            : transform,
        ),
      }));
      setTransformConfigDrafts((current) => ({
        ...current,
        [transformType]: JSON.stringify(parsed, null, 2),
      }));
      setRuleStatus(`${transformType} 配置已更新，请确认后保存规则。`);
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "Transform config JSON 格式不正确，请修正后再保存。");
    }
  }

  function buildRuleDslFromEditor() {
    const nextRuleDsl = mergeRuleDslMapping(ruleDsl, mapping);
    const transforms = nextRuleDsl.transforms.map((transform) => {
      const rawValue = transformConfigDrafts[transform.type];
      if (rawValue === undefined) {
        return transform;
      }

      const parsed = JSON.parse(rawValue) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${transform.type} 的 transform config 必须是 JSON 对象。`);
      }

      return {
        ...transform,
        config: parsed as Record<string, unknown>,
      };
    });

    return {
      ...nextRuleDsl,
      aiConfidenceReport,
      transforms,
    };
  }

  function registerCellRef(rowId: string, field: UniversalImportField, node: HTMLInputElement | null) {
    const key = `${rowId}:${field}`;
    if (node) {
      cellRefs.current.set(key, node);
      return;
    }
    cellRefs.current.delete(key);
  }

  function focusCell(rowId: string, field: UniversalImportField) {
    const target = cellRefs.current.get(`${rowId}:${field}`);
    if (!target) {
      return;
    }
    target.focus();
    target.select();
  }

  function moveCellFocus(rowId: string, field: UniversalImportField, direction: "right" | "down") {
    const rowIndex = draftRows.findIndex((row) => row.id === rowId);
    const fieldIndex = UNIVERSAL_IMPORT_FIELDS.findIndex((item) => item.key === field);
    if (rowIndex < 0 || fieldIndex < 0) {
      return;
    }
    let nextRowIndex = rowIndex;
    let nextFieldIndex = fieldIndex;
    if (direction === "right") {
      if (fieldIndex < UNIVERSAL_IMPORT_FIELDS.length - 1) {
        nextFieldIndex += 1;
      } else if (rowIndex < draftRows.length - 1) {
        nextRowIndex += 1;
        nextFieldIndex = 0;
      }
    } else if (rowIndex < draftRows.length - 1) {
      nextRowIndex += 1;
    }
    const nextRow = draftRows[nextRowIndex];
    const nextField = UNIVERSAL_IMPORT_FIELDS[nextFieldIndex];
    if (!nextRow || !nextField) {
      return;
    }
    window.requestAnimationFrame(() => {
      focusCell(nextRow.id, nextField.key);
    });
  }

  function handleCellKeyDown(event: React.KeyboardEvent<HTMLInputElement>, rowId: string, field: UniversalImportField) {
    if (event.key === "Enter") {
      event.preventDefault();
      moveCellFocus(rowId, field, "down");
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      moveCellFocus(rowId, field, "right");
    }
  }

  async function loadHistory(nextFilters: HistoryFilters) {
    setHistoryLoading(true);
    setHistoryStatus("");
    try {
      const params = new URLSearchParams();
      if (nextFilters.query.trim()) params.set("query", nextFilters.query.trim());
      if (nextFilters.externalCode.trim()) params.set("externalCode", nextFilters.externalCode.trim());
      if (nextFilters.receiverName.trim()) params.set("receiverName", nextFilters.receiverName.trim());
      if (nextFilters.submittedAt.trim()) params.set("submittedAt", nextFilters.submittedAt.trim());
      params.set("page", String(nextFilters.page));
      params.set("pageSize", String(nextFilters.pageSize));
      const response = await fetch(`/api/universal-import/shipments?${params.toString()}`);
      const data = (await response.json()) as ShipmentHistoryResponse;
      if (!response.ok || !data.records || typeof data.total !== "number") {
        throw new Error(data.error ?? "查询历史运单失败，请稍后重试。");
      }
      setHistoryData(data);
    } catch (error) {
      setHistoryStatus(error instanceof Error ? error.message : "查询历史运单失败，请稍后重试。");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadHistoryCodes() {
    try {
      const collected: ExistingExternalCodeEntry[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const response = await fetch(`/api/universal-import/shipments?page=${page}&pageSize=1000`);
        const data = (await response.json()) as ShipmentHistoryResponse;
        if (!response.ok || !data.records) {
          return;
        }
        collected.push(
          ...data.records
            .filter((record) => Boolean(record.externalCode?.trim()))
            .map((record) => ({
              externalCode: record.externalCode,
              batchName: record.batch.batchName,
              batchCreatedAt: record.batch.createdAt,
            })),
        );
        totalPages = data.totalPages ?? page;
        page += 1;
      } while (page <= totalPages);
      setExistingCodeRows(collected);
    } catch {
      // ignore warmup errors
    }
  }

  async function loadRules() {
    setRuleLoading(true);
    setRuleStatus("");
    try {
      const response = await fetch("/api/universal-import/templates");
      const data = (await response.json()) as RuleListResponse;
      if (!response.ok || !data.templates) {
        throw new Error(data.error ?? "加载规则列表失败，请稍后重试。");
      }
      setRuleList(data.templates);
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "加载规则列表失败，请稍后重试。");
    } finally {
      setRuleLoading(false);
    }
  }

  function handleFileSelected(file: File, nextFileType: SupportedImportFileType) {
    setSelectedFile(file);
    setFileName(file.name);
    setFileType(nextFileType);
    setDraftRows([]);
    setPreviewRenderLimit(PREVIEW_INITIAL_RENDER_COUNT);
    setSelectedIds([]);
    setHeaders([]);
    setFingerprint("");
    setRuleTestSummary("");
    setAiSummary("");
    setAiRiskNotes([]);
    setAiConfidenceReport([]);
    setAiProviderLabel("");
    setAiModelLabel("");
    setStatus(
      selectedRuleId
        ? "文件已上传，请点击“试解析选中规则”。"
        : "文件已上传，请先在“选择解析规则”中手动选择一条规则。",
    );
  }

  function handleRuleSelect(ruleId: string) {
    if (!ruleId) {
      setSelectedRuleId("");
      setRuleNameInput("");
      setAiRiskNotes([]);
      setAiConfidenceReport([]);
      setAiProviderLabel("");
      setAiModelLabel("");
      setTemplateInfo("请先手动选择解析规则，不做自动匹配。");
      setStatus("已清空解析规则选择，试解析和提交前必须重新选择规则。");
      return;
    }

    const rule = ruleList.find((item) => item.id === ruleId);
    if (rule) {
      handleApplyRule(rule);
      setFileType(rule.fileType as SupportedImportFileType);
      setDraftRows([]);
      setPreviewRenderLimit(PREVIEW_INITIAL_RENDER_COUNT);
      setSelectedIds([]);
      setFingerprint("");
      setRuleTestSummary("");
    }
  }

  function handleFileTypeChange(nextFileType: SupportedImportFileType) {
    setFileType(nextFileType);
    setSelectedRuleId("");
    setRuleNameInput("");
    setDraftRows([]);
    setPreviewRenderLimit(PREVIEW_INITIAL_RENDER_COUNT);
    setSelectedIds([]);
    setHeaders([]);
    setFingerprint("");
    setRuleTestSummary("");
    setTransformConfigDrafts({});
    setAiSummary("");
    setAiRiskNotes([]);
    setAiConfidenceReport([]);
    setAiProviderLabel("");
    setAiModelLabel("");
    setTemplateInfo("文件类型已变更，请重新手动选择解析规则。");
    setStatus("文件类型已变更，请重新在“选择解析规则”中选择已保存规则。");
  }

  function applyRuleToState(rows: UniversalImportRow[], nextMapping: UniversalImportMapping, nextRuleDsl: UniversalImportRuleDsl, nextSheetName: string, nextFingerprint: string, nextHeaders: string[]) {
    setDraftRows(toDraftRows(rows));
    setPreviewRenderLimit(PREVIEW_INITIAL_RENDER_COUNT);
    setMapping(nextMapping);
    setRuleDsl(nextRuleDsl);
    setSheetName(nextSheetName);
    setFingerprint(nextFingerprint);
    setHeaders(nextHeaders);
    setSelectedIds([]);
    setTransformConfigDrafts({});
  }

  async function handleFileParse(file: File, nextFileType: SupportedImportFileType, nextMapping?: UniversalImportMapping, nextRuleDsl?: UniversalImportRuleDsl) {
    setSelectedFile(file);
    setFileName(file.name);
    setFileType(nextFileType);
    setStatus("");
    setAiSummary("");
    setParseProgress({ active: true, value: 12, label: "正在试解析文件...", processed: 0, total: 100 });

    try {
      const effectiveMapping = nextMapping ?? mapping;
      const effectiveRuleDsl = nextRuleDsl ?? ruleDsl;
      const response = await fetch(
        "/api/universal-import/templates/test",
        {
          method: "POST",
          body: makeFormData(file, nextFileType, effectiveMapping, effectiveRuleDsl),
        },
      );
      const data = (await response.json()) as RuleTestResponse;

      if (!response.ok || !data.previewRows || !data.document || !data.fingerprint) {
        throw new Error(data.error ?? "解析失败，请稍后重试。");
      }

      applyRuleToState(
        data.previewRows,
        data.inferredMapping ?? effectiveMapping,
        effectiveRuleDsl,
        data.document.sheetName,
        data.fingerprint,
        data.document.headers,
      );
      setRuleTestSummary(
        `试解析完成：输出 ${data.rowCount ?? 0} 行，发现 ${data.issueCount ?? 0} 个校验问题。`,
      );
      setTemplateInfo(`当前规则模式：${effectiveRuleDsl.mode}`);
      setStatus("文件解析成功，可继续编辑、保存规则或提交。");
      setParseProgress({ active: true, value: 100, label: "完成", processed: data.rowCount ?? 0, total: data.rowCount ?? 0 });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "解析失败，请稍后重试。");
    } finally {
      window.setTimeout(() => {
        setParseProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
      }, 700);
    }
  }

  async function handleAiSuggest() {
    if (!selectedFile) {
      setAiSummary("请先上传样例文件后再生成 AI 规则建议。");
      return;
    }

    setAiSuggesting(true);
    setAiSummary("正在生成 AI 规则建议...");
    setAiRiskNotes([]);
    setAiConfidenceReport([]);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("fileType", fileType);
      const response = await fetch("/api/universal-import/templates/ai-suggest", {
        method: "POST",
        body: formData,
      });
      const data = (await response.json()) as AiSuggestResponse;
      if (!response.ok || !data.suggestedRule || !data.documentSummary) {
        throw new Error(data.error ?? "AI 规则建议生成失败，请稍后重试。");
      }

      const normalizedMapping = normalizeMapping(data.suggestedRule.mapping) ?? DEFAULT_MAPPING;
      setRuleDsl(data.suggestedRule);
      setTransformConfigDrafts({});
      setSelectedRuleId("");
      setDraftRows([]);
      setSelectedIds([]);
      setFingerprint("");
      setRuleTestSummary("");
      setMapping(normalizedMapping);
      setHeaders(data.documentSummary.headers);
      setSheetName(data.documentSummary.sheetName);
      setAiRiskNotes(data.riskNotes ?? []);
      setAiConfidenceReport(data.confidenceReport ?? []);
      setAiProviderLabel(
        data.provider === "deepseek"
          ? "DeepSeek 官网实时生成"
          : data.provider === "siliconflow"
            ? "SiliconFlow 实时生成"
            : "本地兜底规则",
      );
      setAiModelLabel(data.model ?? "");
      setAiSummary(
        data.aiSummary ||
          `AI 已生成建议规则：文件类型 ${data.documentSummary.fileType}，识别表头 ${data.documentSummary.headers.length} 列。`,
      );
      setTemplateInfo("AI 建议规则已就绪，可直接试解析或继续人工调整。");
    } catch (error) {
      setAiProviderLabel("");
      setAiModelLabel("");
      setAiSummary(error instanceof Error ? error.message : "AI 规则建议生成失败，请稍后重试。");
    } finally {
      setAiSuggesting(false);
    }
  }

  async function saveRule(method: "POST" | "PUT", ruleId?: string) {
    const editorRuleDsl = buildRuleDslFromEditor();
    setRuleDsl(editorRuleDsl);

    const payload = {
      ruleName: ruleNameInput.trim() || sheetName || "导入规则",
      sheetName,
      headers,
      mapping,
      fileType,
      status: "ACTIVE",
      ruleDsl: editorRuleDsl,
    };

    const endpoint = method === "POST" ? "/api/universal-import/templates" : `/api/universal-import/templates/${ruleId}`;
    const response = await fetch(endpoint, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as RuleUpsertResponse;
    if (!response.ok || !data.template) {
      throw new Error(data.error ?? "保存规则失败，请稍后重试。");
    }

    setSelectedRuleId(data.template.id);
    setRuleNameInput(data.template.ruleName);
    setLastSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    await loadRules();
    return data.template;
  }

  async function handleSaveCurrentRule() {
    if (!selectedFile || headers.length === 0) {
      setRuleStatus("请先上传样例文件，并通过 AI 生成规则或试解析后再保存规则。");
      return;
    }
    try {
      const template = await saveRule("POST");
      setRuleStatus(`规则“${template.ruleName}”已保存。`);
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "保存规则失败，请稍后重试。");
    }
  }

  async function handleConfirmAiSuggestionSave() {
    if (!selectedFile || headers.length === 0) {
      setRuleStatus("请先上传样例文件，并点击 AI 生成规则建议。");
      return;
    }
    try {
      const template = await saveRule("POST");
      setRuleStatus(`AI 建议已确认，并保存为规则“${template.ruleName}”。`);
      setStatus(`AI 建议已确认，并保存为规则“${template.ruleName}”。`);
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "确认 AI 建议失败，请稍后重试。");
    }
  }

  async function handleUpdateSelectedRule() {
    if (!selectedRuleId) {
      setRuleStatus("请先选择一条规则再更新。");
      return;
    }
    if (!selectedFile || headers.length === 0) {
      setRuleStatus("请先上传样例文件并完成试解析后再更新规则。");
      return;
    }
    try {
      const template = await saveRule("PUT", selectedRuleId);
      setRuleStatus(`规则“${template.ruleName}”已更新到版本 ${template.version}。`);
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "更新规则失败，请稍后重试。");
    }
  }

  function handleApplyRule(rule: RuleRecord) {
    const normalizedMapping = normalizeMapping(rule.mapping) ?? DEFAULT_MAPPING;
    const nextRuleDsl = rule.ruleDsl ?? buildDefaultRuleDsl(normalizedMapping, rule.fileType as SupportedImportFileType);
    const sampleHeaders = getSampleHeaders(rule.sampleMeta);
    const savedConfidenceReport = nextRuleDsl.aiConfidenceReport ?? [];
    setSelectedRuleId(rule.id);
    setRuleNameInput(rule.ruleName);
    setMapping(normalizedMapping);
    setRuleDsl(nextRuleDsl);
    setTransformConfigDrafts({});
    setAiConfidenceReport(savedConfidenceReport);
    setAiRiskNotes([]);
    setAiProviderLabel("");
    setAiModelLabel("");
    setHeaders(sampleHeaders);
    setFileType(rule.fileType as SupportedImportFileType);
    setDraftRows([]);
    setSelectedIds([]);
    setFingerprint("");
    setRuleTestSummary("");
    setTemplateInfo(`当前使用规则：${rule.ruleName}`);
    setStatus(`已加载规则：${rule.ruleName}。请上传样例文件或重新试解析。`);
  }

  async function handleDeleteRule(ruleId: string) {
    try {
      const response = await fetch(`/api/universal-import/templates/${ruleId}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "删除规则失败，请稍后重试。");
      }
      if (selectedRuleId === ruleId) {
        setSelectedRuleId("");
      }
      setRuleStatus("规则已删除。");
      await loadRules();
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "删除规则失败，请稍后重试。");
    }
  }

  async function handleCopyRule(rule: RuleRecord) {
    try {
      const response = await fetch(`/api/universal-import/templates/${rule.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ruleName: `${rule.ruleName} 副本`,
        }),
      });
      const data = (await response.json()) as RuleUpsertResponse;
      if (!response.ok || !data.template) {
        throw new Error(data.error ?? "复制规则失败，请稍后重试。");
      }

      setSelectedRuleId(data.template.id);
      setRuleNameInput(data.template.ruleName);
      setRuleStatus(`规则“${data.template.ruleName}”已复制，可继续调整后保存。`);
      await loadRules();
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "复制规则失败，请稍后重试。");
    }
  }

  async function handleTestCurrentRule() {
    if (!selectedFile) {
      setRuleTestSummary("请先上传样例文件。");
      return;
    }
    if (activeTab === "import" && !selectedRuleId) {
      setStatus("请先手动选择解析规则，再执行试解析。");
      setRuleTestSummary("考试要求：上传文件时由用户手动选择规则，系统不做自动匹配。");
      return;
    }
    await handleFileParse(selectedFile, fileType, mapping, ruleDsl);
  }

  async function handleTestDraftRule() {
    if (!selectedFile) {
      setStatus("请先上传样例文件。");
      return;
    }

    try {
      const editorRuleDsl = buildRuleDslFromEditor();
      setRuleDsl(editorRuleDsl);
      setStatus("正在使用当前 AI 建议和人工调整后的映射试解析。");
      await handleFileParse(selectedFile, fileType, mapping, editorRuleDsl);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "当前规则配置不正确，请检查字段映射和 Transform Config。");
    }
  }

  function handleCellChange(rowId: string, field: UniversalImportField, value: string) {
    setDraftRows((current) => current.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)));
  }

  function addEmptyRow() {
    const nextLength = draftRows.length + 1;
    setDraftRows((current) => {
      return [...current, createEmptyDraftRow(current.length + 1)];
    });
    setPreviewRenderLimit((currentLimit) => Math.max(currentLimit, Math.min(nextLength, currentLimit + 1)));
    setStatus("已新增空行。");
  }

  function deleteRows(ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    const idSet = new Set(ids);
    const nextLength = draftRows.filter((row) => !idSet.has(row.id)).length;
    setDraftRows((current) =>
      current
        .filter((row) => !idSet.has(row.id))
        .map((row, index) => ({ ...row, rowIndex: index + 1 })),
    );
    setPreviewRenderLimit((currentLimit) =>
      Math.max(PREVIEW_INITIAL_RENDER_COUNT, Math.min(currentLimit, nextLength)),
    );
    setSelectedIds((current) => current.filter((id) => !idSet.has(id)));
    setStatus("已删除所选行。");
  }

  function showMorePreviewRows() {
    setPreviewRenderLimit((current) => Math.min(current + PREVIEW_RENDER_BATCH_SIZE, draftRows.length));
  }

  function showAllPreviewRows() {
    setPreviewRenderLimit(draftRows.length);
  }

  function exportPreview() {
    if (draftRows.length === 0) {
      setStatus("当前没有可导出的数据。");
      return;
    }
    downloadWorkbook(draftRows, sheetName);
    setStatus("已导出预览文件。");
  }

  async function submitImport() {
    if (!selectedRuleId) {
      setStatus("请先手动选择解析规则，再提交下单。");
      return;
    }

    if (draftRows.length === 0) {
      setStatus("请先导入并试解析文件。");
      return;
    }
    const immediateValidation = validateImportRows(draftRows, existingExternalCodes);
    if (immediateValidation.issues.length > 0) {
      setStatus(`存在 ${immediateValidation.issues.length} 个未修正问题，请先处理后再提交。`);
      return;
    }
    setSubmitting(true);
    setSubmitProgress({
      active: true,
      value: 12,
      label: "正在提交...",
      processed: 0,
      total: draftRows.length,
    });

    const timer = window.setInterval(() => {
      setSubmitProgress((current) => ({
        ...current,
        value: Math.min(current.value + 8, 92),
      }));
    }, 180);

    try {
      const response = await fetch("/api/universal-import/shipments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batchName: fileName || `${sheetName} 批次`,
          originalFileName: fileName,
          fileType,
          sheetName,
          headers,
          mapping,
          fingerprint,
          ruleId: selectedRuleId,
          rows: draftRows,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        summary?: { successCount: number; failCount: number; shipmentCount: number };
      };
      if (!response.ok) {
        throw new Error(data.error ?? "提交导入失败，请稍后重试。");
      }
      setSubmitProgress({
        active: true,
        value: 100,
        label: "完成",
        processed: data.summary?.successCount ?? draftRows.length,
        total: draftRows.length,
      });
      setStatus(
        `提交成功 ${data.summary?.successCount ?? draftRows.length} 行，生成 ${
          data.summary?.shipmentCount ?? 0
        } 个运单。`,
      );
      pushToast(`成功提交 ${data.summary?.shipmentCount ?? 0} 个运单`, "success");
      void loadHistory({ ...historyFilters, page: 1 });
      void loadHistoryCodes();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "提交导入失败，请稍后重试。");
    } finally {
      window.clearInterval(timer);
      setSubmitting(false);
      window.setTimeout(() => {
        setSubmitProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
      }, 700);
    }
  }

  function toggleExpanded(path: string) {
    setExpandedMenuPaths((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  }

  function handleSidebarItemClick(item: SidebarMenuItem, path: string) {
    if (item.children?.length) {
      toggleExpanded(path);
      return;
    }
    setActiveMenuPath(path);
    if (item.href === "/universal-import") {
      setActiveTab("import");
      return;
    }
    if (item.href === "/universal-import?tab=history") {
      setActiveTab("history");
      return;
    }
    if (item.href === "/universal-import?tab=rules") {
      setActiveTab("rules");
      return;
    }
  }

  function renderSidebarMenus(items: SidebarMenuItem[], parentPath = "", depth = 0) {
    return (
      <div className={`sidebar-menu-level level-${depth}`}>
        {items.map((item) => {
          const path = parentPath ? `${parentPath}/${item.label}` : item.label;
          const expanded = expandedMenuPaths.includes(path);
          const active = activeMenuPath === path || activeMenuPath.startsWith(`${path}/`);

          return (
            <div className="sidebar-menu-group" key={path}>
              <button
                type="button"
                className={`sidebar-nav-item${active ? " active" : ""}`}
                onClick={() => handleSidebarItemClick(item, path)}
              >
                <span className="sidebar-nav-icon" aria-hidden="true" />
                <span className="sidebar-nav-label">{item.label}</span>
                {item.children?.length ? <span className={`sidebar-caret${expanded ? " expanded" : ""}`}>{expanded ? "▼" : "▶"}</span> : null}
              </button>
              {item.children?.length && expanded ? <div className="sidebar-subnav">{renderSidebarMenus(item.children, path, depth + 1)}</div> : null}
            </div>
          );
        })}
      </div>
    );
  }

  useEffect(() => {
    void loadHistory(DEFAULT_HISTORY_FILTERS);
    void loadHistoryCodes();
    void loadRules();
  }, []);

  useEffect(() => {
    if (activeTab === "history") {
      setActiveMenuPath("智能多格式批量下单系统/历史运单");
      return;
    }

    if (activeTab === "rules") {
      setActiveMenuPath("智能多格式批量下单系统/规则管理");
      return;
    }

    setActiveMenuPath("智能多格式批量下单系统/万能导入V2");
  }, [activeTab]);

  useEffect(() => {
    setRuleDsl((current) => ({
      ...current,
      fileType,
      mode: fileType === "excel" ? "mapping" : "text",
      mapping,
    }));
  }, [fileType, mapping]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="sidebar-brand">
          <div className="brand-logo">AI</div>
          <div className="brand-copy">
            <strong>智能多格式批量下单系统</strong>
            <span>SMART MULTI-FORMAT ORDERING</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="系统菜单">
          {renderSidebarMenus(UNIVERSAL_SIDEBAR_MENUS)}
        </nav>

        <div className="sidebar-env-card">
          <div>
            <strong>{operatorName}</strong>
            <span>考试演示模式，仅保留本次考试功能菜单。</span>
          </div>
          <span className="env-toggle active" />
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="global-topbar">
          <div className="global-topbar-nav">
            {TOP_NAV_ITEMS.map((item) => (
              <button
                type="button"
                className="global-nav-item active"
                key={item}
              >
                {item}
              </button>
            ))}
          </div>

          <div className="global-topbar-tools">
            <span className="global-pill">万能导入V2</span>
            <span className="global-pill alert">考试演示模式</span>
            <span className="user-chip">{operatorName}</span>
          </div>
        </header>

        <section className="workspace-shell">
          <div className="workspace-tabbar">
            <Link className="tabbar-back" href="/universal-import">
              返回
            </Link>
            <button type="button" className={`workspace-tab${activeTab === "import" ? " active" : ""}`} onClick={() => setActiveTab("import")}>
              万能导入V2
            </button>
            <button type="button" className={`workspace-tab${activeTab === "history" ? " active" : ""}`} onClick={() => setActiveTab("history")}>
              历史运单
            </button>
            <button type="button" className={`workspace-tab${activeTab === "rules" ? " active" : ""}`} onClick={() => setActiveTab("rules")}>
              规则管理
            </button>
          </div>

          <div className="workspace-stage">
            {activeTab === "import" ? (
              <>
                <section className="workspace-card">
                  <div className="workspace-header">
                    <div>
                      <p className="workspace-breadcrumb">智能多格式批量下单系统 / 万能导入V2</p>
                      <h1>智能多格式批量下单系统</h1>
                      <p>当前版本已支持 Excel / Word / PDF 样例试解析、AI 规则建议、规则 DSL 基础结构、在线编辑、历史入库与规则管理。</p>
                    </div>
                    <div className="import-stat-grid">
                      <article className="overview-card accent">
                        <p>预览行数</p>
                        <strong>{totalCount}</strong>
                        <span>当前解析出的 SKU 行</span>
                      </article>
                      <article className="overview-card warning">
                        <p>错误行数</p>
                        <strong>{errorRowCount}</strong>
                        <span>提交前必须修正</span>
                      </article>
                      <article className="overview-card success">
                        <p>预览运单</p>
                        <strong>{groupedPreviewCount || 0}</strong>
                        <span>按外部编码聚合后的运单数</span>
                      </article>
                      <article className="overview-card">
                        <p>规则模式</p>
                        <strong>{ruleDsl.mode}</strong>
                        <span>{templateInfo || "可在规则管理中保存和调试"}</span>
                      </article>
                    </div>
                  </div>
                </section>

                <section className="import-grid">
                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">导入区</p>
                        <h3>多格式上传、AI 建议与试解析</h3>
                      </div>
                      <div className="toolbar">
                        <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                          选择文件
                        </button>
                        <input
                          ref={fileInputRef}
                          hidden
                          type="file"
                          accept=".xlsx,.xls,.docx,.pdf"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              handleFileSelected(file, fileType);
                            }
                            event.target.value = "";
                          }}
                        />
                      </div>
                    </div>

                    <div className="history-filters">
                      <label className="search-field">
                        <span>文件类型</span>
                        <select value={fileType} onChange={(event) => handleFileTypeChange(event.target.value as SupportedImportFileType)}>
                          <option value="excel">Excel</option>
                          <option value="word">Word</option>
                          <option value="pdf">PDF</option>
                        </select>
                      </label>
                      <label className="search-field">
                        <span>选择解析规则</span>
                        <select value={selectedRuleId} onChange={(event) => handleRuleSelect(event.target.value)}>
                          <option value="">请选择已保存规则</option>
                          {ruleList.map((rule) => (
                            <option value={rule.id} key={rule.id}>
                              {rule.ruleName} / {rule.fileType} / v{rule.version}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="search-field">
                        <span>规则名称</span>
                        <input value={ruleNameInput} onChange={(event) => setRuleNameInput(event.target.value)} placeholder="例如：门店矩阵配送规则" />
                      </label>
                    </div>

                    <div className="upload-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                      event.preventDefault();
                      const file = event.dataTransfer.files?.[0];
                      if (file) {
                        handleFileSelected(file, fileType);
                      }
                    }}>
                      <strong>拖拽 Excel / Word / PDF 文件到这里，或点击右上角按钮上传</strong>
                      <span>上传后必须手动选择已保存规则，再执行试解析；系统不做自动匹配。</span>
                      {selectedFile ? (
                        <span>当前样例文件：{selectedFile.name}</span>
                      ) : (
                        <span>当前尚未上传样例文件。</span>
                      )}
                    </div>

                    <div className="toolbar" style={{ marginTop: 16 }}>
                      <button type="button" className="primary-button" onClick={() => void handleAiSuggest()} disabled={!selectedFile || aiSuggesting}>
                        {aiSuggesting ? "AI 生成中..." : "AI 生成规则建议"}
                      </button>
                      <button type="button" className="secondary-button" onClick={() => void handleTestCurrentRule()} disabled={!selectedFile || !selectedRuleId}>
                        试解析选中规则
                      </button>
                      <button type="button" className="tool-button" onClick={addEmptyRow}>
                        + 新增行
                      </button>
                      <button type="button" className="tool-button" onClick={exportPreview} disabled={draftRows.length === 0}>
                        导出 Excel
                      </button>
                    </div>

                    <div className="status-panel">
                      <p className={`status-text${status ? " visible" : ""}`}>{status || " "}</p>
                      <p className="footnote">{aiSummary || ruleTestSummary || rowErrorSummary[0] || "这里会显示 AI 建议、试解析和校验结果。"}</p>
                    </div>

                    {aiProviderLabel || aiModelLabel ? (
                      <div className="overview-grid" style={{ marginTop: 16 }}>
                        <article className="overview-card">
                          <p>AI 建议来源</p>
                          <strong>{aiProviderLabel || "-"}</strong>
                          <span>用于区分真实大模型输出还是本地兜底规则</span>
                        </article>
                        <article className="overview-card">
                          <p>当前模型</p>
                          <strong>{aiModelLabel || "-"}</strong>
                          <span>本次规则建议所使用的模型标识</span>
                        </article>
                      </div>
                    ) : null}

                    {aiRiskNotes.length > 0 ? (
                      <div className="error-list">
                        {aiRiskNotes.map((item) => (
                          <div className="error-item" key={item}>
                            {item}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {headers.length > 0 ? (
                      <div className="mapping-grid">
                        {UNIVERSAL_IMPORT_FIELDS.map((field) => {
                          const aiStatus = getAiMappingStatus(aiConfidenceByField.get(field.key));
                          const currentColumn = mapping[field.key];

                          return (
                            <label className="mapping-row" key={field.key}>
                              <span className="mapping-label">
                                <span>{field.label}{field.required ? "*" : ""}</span>
                                <em className={`ai-confidence-badge ${aiStatus.tone}`}>{aiStatus.label}</em>
                              </span>
                              <select
                                value={typeof currentColumn === "number" ? String(currentColumn) : ""}
                                onChange={(event) => handleMappingColumnChange(field.key, event.target.value)}
                              >
                                <option value="">未映射</option>
                                {headers.map((header, index) => (
                                  <option value={index} key={`${header}-${index}`}>
                                    {index + 1}. {header || "未命名列"}
                                  </option>
                                ))}
                              </select>
                              <small className="mapping-hint">{aiStatus.detail}</small>
                            </label>
                          );
                        })}
                        <div className="mapping-action-row">
                          <div>
                            <strong>下一步</strong>
                            <span>先把必填字段映射到正确列，再试解析；结果确认无误后保存为规则。</span>
                          </div>
                          <div className="toolbar">
                            <button type="button" className="secondary-button" onClick={() => void handleTestDraftRule()} disabled={!selectedFile}>
                              试解析当前 AI 建议
                            </button>
                            <button type="button" className="primary-button" onClick={() => void handleConfirmAiSuggestionSave()} disabled={!selectedFile || headers.length === 0}>
                              确认 AI 建议并保存为规则
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {aiConfidenceReport.length > 0 ? (
                      <div className="overview-grid" style={{ marginTop: 16 }}>
                        {aiConfidenceReport.map((item) => {
                          const aiStatus = getAiMappingStatus(item);

                          return (
                            <article className={`overview-card ${aiStatus.tone}`} key={item.field}>
                              <p>{UNIVERSAL_IMPORT_FIELD_LABELS[item.field]}</p>
                              <strong>{aiStatus.label}</strong>
                              <span>{aiStatus.detail}</span>
                            </article>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>

                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">预览区</p>
                        <h3>运单明细预览与在线编辑</h3>
                      </div>
                      <div className="pagination-summary">
                        <span>共 {draftRows.length} 行</span>
                        {hiddenPreviewRowCount > 0 ? <span>已渲染 {visibleDraftRows.length} 行</span> : null}
                        <span>已选 {selectedCount} 行</span>
                      </div>
                    </div>

                    <div className="table-shell import-table-shell">
                      <table className="data-table import-table">
                        <thead>
                          <tr>
                            <th className="checkbox-cell">
                              <input
                                type="checkbox"
                                checked={allRowsSelected}
                                onChange={(event) => setSelectedIds(event.target.checked ? draftRows.map((row) => row.id) : [])}
                              />
                            </th>
                            <th>行号</th>
                            {UNIVERSAL_IMPORT_FIELDS.map((field) => (
                              <th key={field.key}>
                                {field.label}
                                {field.required ? "*" : ""}
                              </th>
                            ))}
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {draftRows.length === 0 ? (
                            <tr>
                              <td colSpan={UNIVERSAL_IMPORT_FIELDS.length + 3} className="empty-row">
                                上传样例文件并完成试解析后，这里会显示可编辑预览表格。
                              </td>
                            </tr>
                          ) : (
                            visibleDraftRows.map((row, index) => {
                              const rowIssues = rowErrorsById.get(row.id) ?? [];
                              return (
                                <tr key={row.id} className={rowIssues.length > 0 ? "has-error" : ""}>
                                  <td className="checkbox-cell">
                                    <input
                                      type="checkbox"
                                      checked={selectedIds.includes(row.id)}
                                      onChange={() => {
                                        setSelectedIds((current) =>
                                          current.includes(row.id)
                                            ? current.filter((id) => id !== row.id)
                                            : [...current, row.id],
                                        );
                                      }}
                                    />
                                  </td>
                                  <td>{row.rowIndex || index + 1}</td>
                                  {UNIVERSAL_IMPORT_FIELDS.map((field) => {
                                    const issue = rowIssues.find((item) => item.field === field.key);
                                    return (
                                      <td key={field.key}>
                                        <input
                                          ref={(node) => registerCellRef(row.id, field.key, node)}
                                          className={`cell-input${issue ? " error" : ""}`}
                                          value={row[field.key]}
                                          onChange={(event) => handleCellChange(row.id, field.key, event.target.value)}
                                          onKeyDown={(event) => handleCellKeyDown(event, row.id, field.key)}
                                          placeholder={field.label}
                                        />
                                        {issue ? <span className="cell-error">{issue.message}</span> : null}
                                      </td>
                                    );
                                  })}
                                  <td>
                                    <button type="button" className="text-link-button" onClick={() => deleteRows([row.id])}>
                                      删除
                                    </button>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>

                    {hiddenPreviewRowCount > 0 ? (
                      <div className="preview-render-toolbar">
                        <span>
                          为保证 1000+ 行数据渲染流畅，当前先展示前 {visibleDraftRows.length} 行，剩余 {hiddenPreviewRowCount} 行仍会参与校验、导出和提交。
                        </span>
                        <div className="toolbar">
                          <button type="button" className="secondary-button" onClick={showMorePreviewRows}>
                            继续加载 {Math.min(PREVIEW_RENDER_BATCH_SIZE, hiddenPreviewRowCount)} 行
                          </button>
                          <button type="button" className="tool-button" onClick={showAllPreviewRows}>
                            显示全部
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {hasBlockingErrors ? (
                      <div className="validation-summary-card">
                        <div className="card-heading compact">
                          <div>
                            <p className="section-kicker">校验错误</p>
                            <h3>全部错误一次性展示</h3>
                          </div>
                          <span className="error-count-badge">{rowErrorSummary.length} 个问题</span>
                        </div>
                        <div className="validation-summary-list">
                          {visibleIssueSummary.map((item) => (
                            <div className="validation-summary-item" key={item}>
                              {item}
                            </div>
                          ))}
                          {hiddenIssueCount > 0 ? (
                            <div className="validation-summary-item muted">
                              还有 {hiddenIssueCount} 个问题未展开，请先处理上方错误或导出后筛查。
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </section>
                </section>

                <section className="import-grid bottom-grid">
                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">进度</p>
                        <h3>导入与提交进度</h3>
                      </div>
                    </div>
                    <div className="progress-stack">
                      <div className="progress-block">
                        <div className="progress-head">
                          <span>文件试解析</span>
                          <strong>{parseProgress.active ? `${parseProgress.value}% · ${parseProgress.processed}/${parseProgress.total}` : "待处理"}</strong>
                        </div>
                        <div className="progress-track">
                          <span className="progress-bar" style={{ width: `${parseProgress.value}%` }} />
                        </div>
                      </div>
                      <div className="progress-block">
                        <div className="progress-head">
                          <span>提交下单</span>
                          <strong>{submitProgress.active ? `${submitProgress.value}% · ${submitProgress.processed}/${submitProgress.total}` : "待处理"}</strong>
                        </div>
                        <div className="progress-track">
                          <span className="progress-bar" style={{ width: `${submitProgress.value}%` }} />
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">规则 DSL</p>
                        <h3>当前规则结构摘要</h3>
                      </div>
                    </div>
                    <div className="overview-grid">
                      <article className="overview-card">
                        <p>文件类型</p>
                        <strong>{ruleDsl.fileType}</strong>
                        <span>当前规则适用的原始文件类型</span>
                      </article>
                      <article className="overview-card">
                        <p>解析模式</p>
                        <strong>{ruleDsl.mode}</strong>
                        <span>Excel 走 mapping，Word/PDF 走 text</span>
                      </article>
                      <article className="overview-card">
                        <p>启用 Transform</p>
                        <strong>{ruleDsl.transforms.filter((item) => item.enabled).length}</strong>
                        <span>已启用的规则执行动作数</span>
                      </article>
                      <article className="overview-card">
                        <p>最近保存</p>
                        <strong>{lastSavedAt || "-"}</strong>
                        <span>可在规则管理页进一步保存和更新</span>
                      </article>
                    </div>
                  </section>
                </section>

                <div className="toolbar" style={{ marginTop: 16 }}>
                  <button type="button" className="primary-button" onClick={() => void submitImport()} disabled={submitting || draftRows.length === 0}>
                    {submitting ? "提交中..." : "提交下单"}
                  </button>
                </div>
              </>
            ) : activeTab === "history" ? (
              <section className="workspace-card">
                <div className="workspace-header" style={{ marginBottom: 16 }}>
                  <div>
                    <p className="workspace-breadcrumb">智能多格式批量下单系统 / 历史运单</p>
                    <h1>历史运单</h1>
                  </div>
                  <div className="workspace-header-meta">
                    <div className="meta-chip"><span>总运单</span><strong>{historyShipmentCount}</strong></div>
                    <div className="meta-chip"><span>当前页 SKU</span><strong>{historyItemCount}</strong></div>
                    <div className="meta-chip"><span>当前页</span><strong>{historyData.page ?? 1}</strong></div>
                    <div className="meta-chip"><span>每页</span><strong>{historyFilters.pageSize}</strong></div>
                  </div>
                </div>

                <div className="card-heading">
                  <div>
                    <p className="section-kicker">历史</p>
                    <h3>历史运单列表</h3>
                  </div>
                  <button type="button" className="secondary-button" onClick={() => void loadHistory({ ...historyFilters })}>
                    刷新
                  </button>
                </div>

                <div className="overview-grid history-overview-grid">
                  <article className="overview-card">
                    <p>历史运单总数</p>
                    <strong>{historyShipmentCount}</strong>
                    <span>当前筛选结果中共检索到的历史运单数量</span>
                  </article>
                  <article className="overview-card">
                    <p>SKU 明细量</p>
                    <strong>{historyItemCount}</strong>
                    <span>用于展示系统已成功沉淀的商品明细数据</span>
                  </article>
                  <article className="overview-card">
                    <p>最近导入</p>
                    <strong>{historyData.records?.[0] ? formatDateTime(historyData.records[0].batch.createdAt) : "-"}</strong>
                    <span>便于答辩时展示导入结果可追溯</span>
                  </article>
                  <article className="overview-card">
                    <p>当前讲解对象</p>
                    <strong>{selectedHistoryRecord?.externalCode ?? "-"}</strong>
                    <span>下方可查看运单明细、来源文件和收货信息</span>
                  </article>
                </div>

                <div className="history-filters">
                  <label className="search-field">
                    <span>关键字</span>
                    <input value={historyFilters.query} onChange={(event) => setHistoryFilters((current) => ({ ...current, query: event.target.value }))} placeholder="外部编码 / 收件人 / 门店 / 文件名" />
                  </label>
                  <label className="search-field">
                    <span>外部编码</span>
                    <input value={historyFilters.externalCode} onChange={(event) => setHistoryFilters((current) => ({ ...current, externalCode: event.target.value }))} placeholder="支持精确或模糊搜索" />
                  </label>
                  <label className="search-field">
                    <span>收件人姓名</span>
                    <input value={historyFilters.receiverName} onChange={(event) => setHistoryFilters((current) => ({ ...current, receiverName: event.target.value }))} placeholder="支持模糊搜索" />
                  </label>
                  <label className="search-field">
                    <span>提交日期</span>
                    <input type="date" value={historyFilters.submittedAt} onChange={(event) => setHistoryFilters((current) => ({ ...current, submittedAt: event.target.value }))} />
                  </label>
                  <div className="search-actions">
                    <button type="button" className="primary-button" onClick={() => void loadHistory({ ...historyFilters, page: 1 })}>查询</button>
                    <button type="button" className="secondary-button" onClick={() => {
                      setHistoryFilters(DEFAULT_HISTORY_FILTERS);
                      void loadHistory(DEFAULT_HISTORY_FILTERS);
                    }}>重置</button>
                  </div>
                </div>

                <div className="table-shell import-history-shell">
                  <table className="data-table history-table">
                    <thead>
                      <tr>
                        <th>外部编码</th>
                        <th>收货信息</th>
                        <th>SKU 数</th>
                        <th>来源文件</th>
                        <th>提交时间</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyLoading ? (
                        <tr><td colSpan={6} className="empty-row">正在加载历史数据...</td></tr>
                      ) : (historyData.records ?? []).length === 0 ? (
                        <tr><td colSpan={6} className="empty-row">暂无历史运单记录。</td></tr>
                      ) : (
                        historyData.records?.map((record) => (
                          <tr
                            key={record.id}
                            className={selectedHistoryRecord?.id === record.id ? "history-row-active" : ""}
                            onClick={() => setSelectedHistoryId(record.id)}
                          >
                            <td>{record.externalCode}</td>
                            <td>{formatReceiverSummary(record)}</td>
                            <td>{record.items.length}</td>
                            <td>{record.batch.originalFileName || "-"}</td>
                            <td>{formatDateTime(record.batch.createdAt)}</td>
                            <td>{record.batch.status}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="history-detail-card">
                  <div className="card-heading">
                    <div>
                      <p className="section-kicker">明细证据</p>
                      <h3>选中运单的导入结果详情</h3>
                    </div>
                  </div>
                  {selectedHistoryRecord ? (
                    <>
                      <div className="overview-grid history-detail-grid">
                        <article className="overview-card">
                          <p>运单号</p>
                          <strong>{selectedHistoryRecord.externalCode}</strong>
                          <span>用于展示系统对单据主键的归并能力</span>
                        </article>
                        <article className="overview-card">
                          <p>收货对象</p>
                          <strong>{selectedHistoryRecord.receiverStore || selectedHistoryRecord.receiverName || "-"}</strong>
                          <span>{selectedHistoryRecord.receiverPhone || selectedHistoryRecord.receiverAddress || "无补充信息"}</span>
                        </article>
                        <article className="overview-card">
                          <p>来源文件</p>
                          <strong>{selectedHistoryRecord.batch.originalFileName || "-"}</strong>
                          <span>{formatFileTypeLabel(selectedHistoryRecord.batch.fileType)} / {selectedHistoryRecord.batch.sourceSheetName || "-"}</span>
                        </article>
                        <article className="overview-card">
                          <p>导入结果</p>
                          <strong>{selectedHistoryRecord.items.length} 个 SKU</strong>
                          <span>导入状态：{selectedHistoryRecord.batch.status}</span>
                        </article>
                      </div>
                      <div className="table-shell history-detail-shell">
                        <table className="data-table history-detail-table">
                          <thead>
                            <tr>
                              <th>源行号</th>
                              <th>SKU 编码</th>
                              <th>SKU 名称</th>
                              <th>规格型号</th>
                              <th>数量</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedHistoryRecord.items.map((item) => (
                              <tr key={item.id}>
                                <td>{item.sourceRowIndex}</td>
                                <td>{item.skuCode}</td>
                                <td>{item.skuName}</td>
                                <td>{item.skuSpec || "-"}</td>
                                <td>{item.skuQuantity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div className="empty-row history-empty-card">请选择一条运单查看明细。</div>
                  )}
                </div>

                <div className="pagination-bar">
                  <div className="pagination-summary">
                    <span>共 {historyData.total ?? 0} 条</span>
                    <span>{historyStatus || " "}</span>
                  </div>
                  <div className="pagination-controls">
                    <button type="button" className="page-button" disabled={historyLoading || (historyData.page ?? 1) <= 1} onClick={() => void loadHistory({ ...historyFilters, page: Math.max((historyData.page ?? 1) - 1, 1) })}>上一页</button>
                    <span className="page-button active">{historyData.page ?? 1} / {historyData.totalPages ?? 1}</span>
                    <button type="button" className="page-button" disabled={historyLoading || (historyData.page ?? 1) >= (historyData.totalPages ?? 1)} onClick={() => void loadHistory({ ...historyFilters, page: (historyData.page ?? 1) + 1 })}>下一页</button>
                  </div>
                </div>
              </section>
            ) : (
              <section className="workspace-card">
                <div className="workspace-header" style={{ marginBottom: 16 }}>
                  <div>
                    <p className="workspace-breadcrumb">智能多格式批量下单系统 / 规则管理</p>
                    <h1>规则管理中心</h1>
                    <p>支持查看规则列表、保存当前规则、更新规则版本、应用规则、删除规则，以及结合样例文件执行试解析。</p>
                  </div>
                  <div className="workspace-header-meta">
                    <div className="meta-chip"><span>规则总数</span><strong>{ruleList.length}</strong></div>
                    <div className="meta-chip"><span>当前选中</span><strong>{selectedRuleId ? "1" : "0"}</strong></div>
                    <div className="meta-chip"><span>样例文件</span><strong>{selectedFile ? "已上传" : "未上传"}</strong></div>
                  </div>
                </div>

                <div className="import-grid">
                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">规则编辑</p>
                        <h3>保存和调试当前规则</h3>
                      </div>
                    </div>

                    <div className="history-filters">
                      <label className="search-field">
                        <span>规则名称</span>
                        <input value={ruleNameInput} onChange={(event) => setRuleNameInput(event.target.value)} placeholder="例如：门店矩阵配送规则" />
                      </label>
                      <label className="search-field">
                        <span>当前文件类型</span>
                        <input value={fileType} readOnly />
                      </label>
                      <label className="search-field">
                        <span>当前指纹</span>
                        <input value={fingerprint} readOnly placeholder="试解析后自动生成" />
                      </label>
                    </div>

                    <div className="toolbar" style={{ marginTop: 16 }}>
                      <button type="button" className="primary-button" onClick={() => void handleConfirmAiSuggestionSave()} disabled={!selectedFile || headers.length === 0}>
                        确认 AI 建议并保存为规则
                      </button>
                      <button type="button" className="primary-button" onClick={() => void handleSaveCurrentRule()}>新建规则</button>
                      <button type="button" className="secondary-button" onClick={() => void handleUpdateSelectedRule()} disabled={!selectedRuleId}>更新选中规则</button>
                      <button type="button" className="secondary-button" onClick={() => void handleTestCurrentRule()} disabled={!selectedFile}>试解析当前规则</button>
                    </div>

                    <div className="status-panel">
                      <p className={`status-text${ruleStatus ? " visible" : ""}`}>{ruleStatus || " "}</p>
                      <p className="footnote">{ruleTestSummary || "这里会显示规则保存、更新、应用和试解析结果。"}</p>
                    </div>

                    <div className="rule-editor-section">
                      <div className="card-heading compact">
                        <div>
                          <p className="section-kicker">字段映射</p>
                          <h3>人工确认 AI 映射列</h3>
                        </div>
                      </div>
                      {headers.length > 0 ? (
                        <div className="mapping-grid rule-mapping-grid">
                          {UNIVERSAL_IMPORT_FIELDS.map((field) => {
                            const aiStatus = getAiMappingStatus(aiConfidenceByField.get(field.key));
                            const currentColumn = mapping[field.key];

                            return (
                              <label className="mapping-row" key={field.key}>
                                <span className="mapping-label">
                                  <span>{field.label}{field.required ? "*" : ""}</span>
                                  <em className={`ai-confidence-badge ${aiStatus.tone}`}>{aiStatus.label}</em>
                                </span>
                                <select
                                  value={typeof currentColumn === "number" ? String(currentColumn) : ""}
                                  onChange={(event) => handleMappingColumnChange(field.key, event.target.value)}
                                >
                                  <option value="">未映射</option>
                                  {headers.map((header, index) => (
                                    <option value={index} key={`${header}-${index}`}>
                                      {index + 1}. {header || "未命名列"}
                                    </option>
                                  ))}
                                </select>
                                <small className="mapping-hint">{aiStatus.detail}</small>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="empty-row rule-editor-empty">请先上传样例文件并生成 AI 建议，或应用一条带样例表头的已保存规则。</div>
                      )}
                    </div>

                    <div className="rule-editor-section">
                      <div className="card-heading compact">
                        <div>
                          <p className="section-kicker">Transform Config</p>
                          <h3>规则 DSL JSON / 表单编辑</h3>
                        </div>
                      </div>
                      {ruleDsl.transforms.map((transform) => (
                        <article className="transform-editor-card" key={transform.type}>
                          <div className="transform-editor-header">
                            <div>
                              <p>{transform.type}</p>
                              <strong>{transform.enabled ? "启用" : "关闭"}</strong>
                            </div>
                            <button type="button" className="text-link-button" onClick={() => handleTransformConfigCommit(transform.type)}>
                              应用 JSON
                            </button>
                          </div>
                          <label className="inline-checkbox">
                            <input
                              type="checkbox"
                              checked={transform.enabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setRuleDsl((current) => ({
                                  ...current,
                                  transforms: current.transforms.map((item) =>
                                    item.type === transform.type ? { ...item, enabled } : item,
                                  ),
                                }));
                              }}
                            />
                            <span>参与试解析</span>
                          </label>
                          <label className="search-field">
                            <span>config JSON</span>
                            <textarea
                              className="json-editor"
                              value={transformConfigDrafts[transform.type] ?? formatTransformConfig(transform.config)}
                              onChange={(event) => handleTransformConfigDraftChange(transform.type, event.target.value)}
                              onBlur={() => handleTransformConfigCommit(transform.type)}
                              rows={8}
                              spellCheck={false}
                            />
                          </label>
                        </article>
                      ))}
                    </div>
                  </section>

                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">规则列表</p>
                        <h3>已保存的导入规则</h3>
                      </div>
                      <button type="button" className="secondary-button" onClick={() => void loadRules()} disabled={ruleLoading}>
                        {ruleLoading ? "加载中..." : "刷新规则"}
                      </button>
                    </div>

                    <div className="table-shell import-history-shell">
                      <table className="data-table history-table">
                        <thead>
                          <tr>
                            <th>规则名称</th>
                            <th>文件类型</th>
                            <th>版本</th>
                            <th>批次引用</th>
                            <th>更新时间</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ruleLoading ? (
                            <tr><td colSpan={6} className="empty-row">正在加载规则列表...</td></tr>
                          ) : ruleList.length === 0 ? (
                            <tr><td colSpan={6} className="empty-row">暂无已保存规则。</td></tr>
                          ) : (
                            ruleList.map((rule) => (
                              <tr key={rule.id} className={selectedRuleId === rule.id ? "has-error" : ""}>
                                <td>{rule.ruleName}</td>
                                <td>{rule.fileType}</td>
                                <td>v{rule.version}</td>
                                <td>{rule._count?.batches ?? 0}</td>
                                <td>{new Date(rule.updatedAt).toLocaleString("zh-CN", { hour12: false })}</td>
                                <td>
                                  <div className="toolbar">
                                    <button type="button" className="text-link-button" onClick={() => handleApplyRule(rule)}>应用</button>
                                    <button type="button" className="text-link-button" onClick={() => void handleCopyRule(rule)}>复制</button>
                                    <button type="button" className="text-link-button" onClick={() => {
                                      handleApplyRule(rule);
                                    }}>选中</button>
                                    <button type="button" className="text-link-button" onClick={() => void handleDeleteRule(rule.id)}>删除</button>
                                  </div>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              </section>
            )}
          </div>
        </section>
      </div>

      <div className="toast-stack" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item ${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </main>
  );
}
