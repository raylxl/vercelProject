"use client";

import * as XLSX from "xlsx";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  UNIVERSAL_IMPORT_FIELDS,
  UNIVERSAL_IMPORT_FIELD_LABELS,
  UNIVERSAL_IMPORT_TEMPERATURES,
  buildTemplateFingerprint,
  createEmptyRow,
  detectHeaderRow,
  formatIssueLabel,
  inferMappingFromHeaders,
  remapRows,
  toSafeSheetName,
  type ExistingExternalCodeEntry,
  type UniversalImportField,
  type UniversalImportIssue,
  type UniversalImportMapping,
  type UniversalImportRow,
  validateImportRows,
} from "@/lib/universal-import";

type DraftRow = UniversalImportRow & {
  id: string;
};

type ShipmentHistoryRecord = {
  id: string;
  externalCode: string | null;
  receiverName: string;
  rowIndex: number;
  createdAt: string;
  batch: {
    batchName: string;
    originalFileName: string;
    sheetName: string;
    status: string;
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

type TemplateResponse = {
  template?: {
    fingerprint: string;
    templateName: string;
    mapping: UniversalImportMapping;
  } | null;
  error?: string;
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

const TOP_NAV_ITEMS = ["AI考试", "20260507", "万能导入"] as const;

const UNIVERSAL_SIDEBAR_MENUS: SidebarMenuItem[] = [
  {
    label: "AI考试",
    children: [
      {
        label: "20260507",
        children: [{ label: "万能导入", href: "/universal-import" }],
      },
    ],
  },
];

function createRowId() {
  return globalThis.crypto.randomUUID();
}

function isNonEmptyRow(row: unknown[]) {
  return row.some((cell) => String(cell ?? "").trim() !== "");
}

function storageKey(fingerprint: string) {
  return `universal-import-template:${fingerprint}`;
}

function normalizeMapping(raw: unknown): UniversalImportMapping | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  return Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => {
      const value = candidate[field.key];
      return [field.key, typeof value === "number" ? value : null];
    }),
  ) as UniversalImportMapping;
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

export function UniversalImportClient({ operatorName }: { operatorName: string }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [sheetName, setSheetName] = useState("Sheet1");
  const [fingerprint, setFingerprint] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<unknown[][]>([]);
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [mapping, setMapping] = useState<UniversalImportMapping>(DEFAULT_MAPPING);
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
  const [activeTab, setActiveTab] = useState<"import" | "history">("import");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [expandedMenuPaths, setExpandedMenuPaths] = useState<string[]>([
    "AI考试",
    "AI考试/20260507",
  ]);
  const [activeMenuPath, setActiveMenuPath] = useState("AI考试/20260507/万能导入");

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
    () => validateImportRows(draftRows, existingExternalCodes),
    [draftRows, existingExternalCodes],
  );

  const errorRowCount = useMemo(
    () => new Set(validation.issues.map((issue) => issue.rowIndex)).size,
    [validation.issues],
  );

  const rowErrorsById = useMemo(() => {
    const map = new Map<string, UniversalImportIssue[]>();

    validation.issues.forEach((issue) => {
      const row = draftRows[issue.rowIndex - 1];
      if (!row) {
        return;
      }

      const current = map.get(row.id) ?? [];
      current.push(issue);
      map.set(row.id, current);
    });

    return map;
  }, [draftRows, validation.issues]);

  const rowErrorSummary = useMemo(
    () => validation.issues.map((issue) => formatIssueLabel(issue)),
    [validation.issues],
  );

  const columnOptions = useMemo(
    () =>
      headers.map((header, index) => ({
        value: String(index),
        label: `${index + 1}. ${header || "未命名列"}`,
      })),
    [headers],
  );

  const hasBlockingErrors = validation.issues.length > 0;
  const allRowsSelected = draftRows.length > 0 && selectedIds.length === draftRows.length;
  const selectedCount = selectedIds.length;
  const totalCount = draftRows.length;

  async function loadHistory(nextFilters: HistoryFilters) {
    setHistoryLoading(true);
    setHistoryStatus("");

    try {
      const params = new URLSearchParams();

      if (nextFilters.query.trim()) {
        params.set("query", nextFilters.query.trim());
      }

      if (nextFilters.externalCode.trim()) {
        params.set("externalCode", nextFilters.externalCode.trim());
      }

      if (nextFilters.receiverName.trim()) {
        params.set("receiverName", nextFilters.receiverName.trim());
      }

      if (nextFilters.submittedAt.trim()) {
        params.set("submittedAt", nextFilters.submittedAt.trim());
      }

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
              externalCode: record.externalCode ?? "",
              rowIndex: record.rowIndex,
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

  async function handleLogout() {
    setAuthSubmitting(true);

    try {
      const response = await fetch("/api/session", { method: "DELETE" });

      if (!response.ok) {
        throw new Error("退出登录失败，请稍后重试。");
      }

      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "退出登录失败，请稍后重试。");
      setAuthSubmitting(false);
    }
  }

  async function persistTemplate(nextMapping: UniversalImportMapping, nextHeaders: string[]) {
    if (!fingerprint) {
      return;
    }

    const payload = {
      sheetName,
      headers: nextHeaders,
      mapping: nextMapping,
    };

    try {
      localStorage.setItem(
        storageKey(fingerprint),
        JSON.stringify({
          ...payload,
          savedAt: new Date().toISOString(),
        }),
      );
    } catch {
      // ignore local cache errors
    }

    try {
      await fetch("/api/universal-import/templates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      setLastSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } catch {
      // ignore background save errors
    }
  }

  function rebuildRows(nextMapping: UniversalImportMapping, nextRawRows = rawRows) {
    const mapped = remapRows(nextRawRows, headers, nextMapping).map((row, index) => ({
      ...row,
      id: draftRows[index]?.id ?? createRowId(),
      rowIndex: index + 1,
    }));

    setDraftRows(mapped);
    setSelectedIds([]);
  }

  async function applyMapping(
    nextMapping: UniversalImportMapping,
    shouldPersist = true,
    nextRawRows = rawRows,
    nextHeaders = headers,
  ) {
    setMapping(nextMapping);
    rebuildRows(nextMapping, nextRawRows);
    setStatus("映射已应用。");

    if (shouldPersist) {
      void persistTemplate(nextMapping, nextHeaders);
    }
  }

  async function restoreTemplateFromCache(
    nextFingerprint: string,
    nextHeaders: string[],
    nextRawRows: unknown[][],
  ) {
    try {
      const cached = localStorage.getItem(storageKey(nextFingerprint));
      if (cached) {
        const parsed = JSON.parse(cached) as { mapping?: unknown };
        const cachedMapping = normalizeMapping(parsed.mapping);

        if (cachedMapping) {
          await applyMapping(cachedMapping, false, nextRawRows, nextHeaders);
          setTemplateInfo("已应用本地缓存模板");
          return true;
        }
      }
    } catch {
      // ignore local cache errors
    }

    try {
      const response = await fetch(
        `/api/universal-import/templates?fingerprint=${encodeURIComponent(nextFingerprint)}`,
      );
      const data = (await response.json()) as TemplateResponse;

      if (response.ok && data.template?.mapping) {
        const serverMapping = normalizeMapping(data.template.mapping);

        if (serverMapping) {
          await applyMapping(serverMapping, false, nextRawRows, nextHeaders);
          setTemplateInfo(`已应用服务端记忆模板：${data.template.templateName}`);
          return true;
        }
      }
    } catch {
      // ignore template load errors
    }

    const inferred = inferMappingFromHeaders(nextHeaders);
    await applyMapping(inferred, false, nextRawRows, nextHeaders);
    setTemplateInfo("已启用自动识别模板");
    return false;
  }

  async function handleFile(file: File) {
    setSubmitting(false);
    setStatus("");
    setTemplateInfo("");

    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["xls", "xlsx"].includes(extension)) {
      setStatus("仅支持 .xlsx / .xls 文件。");
      return;
    }

    setParseProgress({ active: true, value: 8, label: "正在读取文件...", processed: 0, total: 0 });

    try {
      const buffer = await file.arrayBuffer();
      setParseProgress({ active: true, value: 22, label: "正在解析工作表...", processed: 0, total: 0 });

      let workbook: XLSX.WorkBook;
      try {
        workbook = XLSX.read(buffer, { type: "array" });
      } catch {
        throw new Error("无法解析 Excel 文件。");
      }

      if (!workbook.SheetNames.length) {
        throw new Error("工作表不存在。");
      }

      const nextSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[nextSheetName];

      if (!sheet) {
        throw new Error("指定 Sheet 不存在。");
      }

      const matrix = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
      }) as unknown[][];

      const meaningfulRows = matrix.filter(isNonEmptyRow);

      if (meaningfulRows.length === 0) {
        throw new Error("文件为空。");
      }

      setParseProgress({
        active: true,
        value: 40,
        label: "正在识别表头...",
        processed: 0,
        total: meaningfulRows.length,
      });

      const headerInfo = detectHeaderRow(meaningfulRows);
      const nextHeaders = headerInfo.headers.map((header) => String(header ?? "").trim());
      const nextRawRows = meaningfulRows.slice(headerInfo.rowIndex + 1).filter(isNonEmptyRow);

      if (nextRawRows.length === 0) {
        throw new Error("未找到有效数据行。");
      }

      const nextFingerprint = buildTemplateFingerprint(nextSheetName, nextHeaders);

      setFileName(file.name);
      setSheetName(nextSheetName);
      setHeaders(nextHeaders);
      setRawRows(nextRawRows);
      setFingerprint(nextFingerprint);

      setParseProgress({
        active: true,
        value: 68,
        label: "正在应用模板映射...",
        processed: Math.min(headerInfo.rowIndex + 1, meaningfulRows.length),
        total: meaningfulRows.length,
      });
      await restoreTemplateFromCache(nextFingerprint, nextHeaders, nextRawRows);

      setParseProgress({
        active: true,
        value: 86,
        label: "正在生成预览数据...",
        processed: nextRawRows.length,
        total: nextRawRows.length,
      });
      setStatus("已完成解析，您可以检查映射并继续编辑。");
      setParseProgress({
        active: true,
        value: 100,
        label: "完成",
        processed: nextRawRows.length,
        total: nextRawRows.length,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "解析失败，请检查文件格式。");
    } finally {
      window.setTimeout(() => {
        setParseProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
      }, 700);
    }
  }

  function handleMappingChange(field: UniversalImportField, value: string) {
    const nextMapping = {
      ...mapping,
      [field]: value === "" ? null : Number(value),
    } as UniversalImportMapping;

    setMapping(nextMapping);
    rebuildRows(nextMapping);
    setStatus("映射已更新，模板规则已同步。");
    void persistTemplate(nextMapping, headers);
  }

  function handleCellChange(rowId: string, field: UniversalImportField, value: string) {
    setDraftRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)),
    );
  }

  function addEmptyRow() {
    setDraftRows((current) => [
      ...current,
      {
        ...createEmptyRow(current.length + 1),
        id: createRowId(),
      },
    ]);
    setStatus("已新增空行。");
  }

  function deleteRows(ids: string[]) {
    if (ids.length === 0) {
      return;
    }

    setDraftRows((current) =>
      current
        .filter((row) => !ids.includes(row.id))
        .map((row, index) => ({
          ...row,
          rowIndex: index + 1,
        })),
    );
    setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
    setStatus("已删除所选行。");
  }

  function exportPreview() {
    if (draftRows.length === 0) {
      setStatus("当前没有可导出的数据。");
      return;
    }

    downloadWorkbook(draftRows, sheetName);
    setStatus("已导出预览文件。");
  }

  function toggleExpanded(path: string) {
    setExpandedMenuPaths((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  }

  function handleSidebarItemClick(item: SidebarMenuItem, path: string) {
    if (item.children && item.children.length > 0) {
      toggleExpanded(path);
      return;
    }

    setActiveMenuPath(path);

    if (item.href === "/universal-import") {
      setActiveTab("import");
      return;
    }

    if (item.href) {
      window.location.assign(item.href);
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
                {item.children?.length ? (
                  <span className={`sidebar-caret${expanded ? " expanded" : ""}`}>
                    {expanded ? "▾" : "▸"}
                  </span>
                ) : null}
              </button>

              {item.children?.length && expanded ? (
                <div className="sidebar-subnav">{renderSidebarMenus(item.children, path, depth + 1)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  async function submitImport() {
    if (draftRows.length === 0) {
      setStatus("请先上传 Excel 文件。");
      return;
    }

    if (hasBlockingErrors) {
      setStatus("存在未修正的错误行，请先处理后再提交。");
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
          sheetName,
          headers,
          mapping,
          fingerprint,
          rows: draftRows,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        issues?: string[];
        summary?: { successCount: number; failCount: number };
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
        `提交成功 ${data.summary?.successCount ?? draftRows.length} 条，失败 ${
          data.summary?.failCount ?? 0
        } 条`,
      );
      void loadHistory({ ...historyFilters, page: 1 });
      void loadHistoryCodes();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "提交导入失败，请稍后重试。");
      setSubmitProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
    } finally {
      window.clearInterval(timer);
      setSubmitting(false);
      window.setTimeout(() => {
        setSubmitProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
      }, 700);
    }
  }

  useEffect(() => {
    void loadHistory(DEFAULT_HISTORY_FILTERS);
    void loadHistoryCodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="sidebar-brand">
          <div className="brand-logo">AI</div>
          <div className="brand-copy">
            <strong>AI考试</strong>
            <span>UNIVERSAL IMPORT</span>
          </div>
        </div>

        <div className="sidebar-org-switch">
          <span>20260507</span>
          <button type="button" className="sidebar-org-button">
            切换
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="系统菜单">
          {renderSidebarMenus(UNIVERSAL_SIDEBAR_MENUS)}
        </nav>

        <div className="sidebar-env-card">
          <div>
            <strong>{operatorName}</strong>
            <span>已登录，可在“万能导入”和“已导入运单”之间切换。</span>
          </div>
          <span className="env-toggle active" />
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="global-topbar">
          <div className="global-topbar-nav">
            {TOP_NAV_ITEMS.map((item, index) => (
              <button
                type="button"
                className={`global-nav-item${index === 2 ? " active" : ""}`}
                key={item}
              >
                {item}
              </button>
            ))}
          </div>

          <div className="global-topbar-tools">
            <span className="global-pill">万能导入</span>
            <span className="global-pill alert">已登录</span>
            <button
              type="button"
              className="user-chip"
              disabled={authSubmitting}
              onClick={() => void handleLogout()}
            >
              {authSubmitting ? "退出中..." : operatorName}
            </button>
          </div>
        </header>

        <section className="workspace-shell">
          <div className="workspace-tabbar">
            <Link className="tabbar-back" href="/universal-import">
              返回
            </Link>
            <button
              type="button"
              className={`workspace-tab${activeTab === "import" ? " active" : ""}`}
              onClick={() => setActiveTab("import")}
            >
              万能导入
            </button>
            <button
              type="button"
              className={`workspace-tab${activeTab === "history" ? " active" : ""}`}
              onClick={() => setActiveTab("history")}
            >
              已导入运单
            </button>
          </div>

          <div className="workspace-stage">
            {activeTab === "import" ? (
              <>
                <div className="workspace-header">
                  <div>
                    <p className="workspace-breadcrumb">AI考试 / 20260507 / 万能导入</p>
                    <h1>万能导入</h1>
                  </div>
                  <div className="workspace-header-meta">
                    <div className="meta-chip">
                      <span>当前文件</span>
                      <strong>{fileName || "未选择"}</strong>
                    </div>
                    <div className="meta-chip">
                      <span>预览行数</span>
                      <strong>{totalCount}</strong>
                    </div>
                    <div className="meta-chip">
                      <span>错误行数</span>
                      <strong>{errorRowCount}</strong>
                    </div>
                  </div>
                </div>

                <section className="hero-panel">
                  <div className="hero-copy">
                    <p className="section-kicker">Excel 解析</p>
                    <h2>多模板自动识别，映射确认后即可批量导入</h2>
                    <p>
                      先上传模板，系统会自动识别表头；如果识别不准，可以直接手动调整列映射。修改后会记住这套结构，下次上传相似模板时会自动应用。
                    </p>
                  </div>

                  <div className="import-stat-grid">
                    <article className="overview-card accent">
                      <p>预览行数</p>
                      <strong>{totalCount}</strong>
                      <span>当前 Excel 解析结果</span>
                    </article>
                    <article className="overview-card warning">
                      <p>错误行数</p>
                      <strong>{errorRowCount}</strong>
                      <span>提交前需要全部修正</span>
                    </article>
                    <article className="overview-card success">
                      <p>历史运单</p>
                      <strong>{historyData.total ?? 0}</strong>
                      <span>数据库中已保存记录</span>
                    </article>
                    <article className="overview-card">
                      <p>模板状态</p>
                      <strong>{templateInfo ? "已记忆" : "待识别"}</strong>
                      <span>{templateInfo || lastSavedAt || "上传后自动学习模板"}</span>
                    </article>
                  </div>
                </section>

                <section className="import-grid">
                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">导入区</p>
                        <h3>模板管理与文件导入</h3>
                      </div>
                      <div className="toolbar">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          选择 Excel
                        </button>
                        <input
                          ref={fileInputRef}
                          hidden
                          type="file"
                          accept=".xlsx,.xls"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              void handleFile(file);
                            }
                            event.target.value = "";
                          }}
                        />
                      </div>
                    </div>

                    <div
                      className="upload-dropzone"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const file = event.dataTransfer.files?.[0];
                        if (file) {
                          void handleFile(file);
                        }
                      }}
                    >
                      <strong>拖拽 Excel 文件到这里，或点击右上角按钮上传</strong>
                      <span>支持 .xlsx / .xls，系统会先自动识别，再允许手动调整映射。</span>
                    </div>

                    <div className="mapping-toolbar">
                      <div>
                        <p className="section-kicker">映射学习</p>
                        <h3>{fileName || "尚未导入文件"}</h3>
                        <p className="muted-text">
                          {sheetName}
                          {fingerprint ? ` · ${fingerprint}` : ""}
                          {lastSavedAt ? ` · 已保存 ${lastSavedAt}` : ""}
                        </p>
                      </div>
                      <div className="toolbar">
                        <button type="button" className="tool-button" onClick={addEmptyRow}>
                          + 新增行
                        </button>
                        <button
                          type="button"
                          className="tool-button danger"
                          onClick={() => deleteRows(selectedIds)}
                          disabled={selectedIds.length === 0}
                        >
                          删除选中
                        </button>
                        <button type="button" className="tool-button" onClick={exportPreview}>
                          导出 Excel
                        </button>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => void submitImport()}
                          disabled={submitting || draftRows.length === 0}
                        >
                          {submitting ? "提交中..." : "提交导入"}
                        </button>
                      </div>
                    </div>

                    {headers.length > 0 ? (
                      <div className="mapping-grid">
                        {UNIVERSAL_IMPORT_FIELDS.map((field) => (
                          <label className="mapping-row" key={field.key}>
                            <span>
                              {field.label}
                              {field.required ? <em>必填</em> : <em>选填</em>}
                            </span>
                            <select
                              value={mapping[field.key] ?? ""}
                              onChange={(event) => handleMappingChange(field.key, event.target.value)}
                            >
                              <option value="">自动识别 / 手动映射</option>
                              {columnOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-row">请先上传 Excel 文件。</div>
                    )}

                    <div className="status-panel">
                      <p className={`status-text${status ? " visible" : ""}`}>{status || " "}</p>
                      <p className="footnote">
                        {rowErrorSummary[0] || "自动校验会在这里提示最先出现的问题。"}
                      </p>
                    </div>

                    {rowErrorSummary.length > 0 ? (
                      <div className="error-list">
                        {rowErrorSummary.map((item) => (
                          <div className="error-item" key={item}>
                            {item}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </section>

                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">预览区</p>
                        <h3>数据预览与在线编辑</h3>
                      </div>
                      <div className="pagination-summary">
                        <span>共 {draftRows.length} 行</span>
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
                                onChange={(event) =>
                                  setSelectedIds(
                                    event.target.checked ? draftRows.map((row) => row.id) : [],
                                  )
                                }
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
                                上传文件后，这里会显示可编辑的预览表格。
                              </td>
                            </tr>
                          ) : (
                            draftRows.map((row, index) => {
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
                                  <td>{index + 1}</td>
                                  {UNIVERSAL_IMPORT_FIELDS.map((field) => {
                                    const issue = rowIssues.find((item) => item.field === field.key);
                                    const isTemperature = field.key === "temperature";

                                    return (
                                      <td key={field.key}>
                                        {isTemperature ? (
                                          <select
                                            className={`cell-input${issue ? " error" : ""}`}
                                            value={row[field.key]}
                                            onChange={(event) =>
                                              handleCellChange(row.id, field.key, event.target.value)
                                            }
                                          >
                                            <option value="">请选择</option>
                                            {UNIVERSAL_IMPORT_TEMPERATURES.map((item) => (
                                              <option key={item} value={item}>
                                                {item}
                                              </option>
                                            ))}
                                          </select>
                                        ) : (
                                          <input
                                            className={`cell-input${issue ? " error" : ""}`}
                                            value={row[field.key]}
                                            onChange={(event) =>
                                              handleCellChange(row.id, field.key, event.target.value)
                                            }
                                            placeholder={field.label}
                                          />
                                        )}
                                        {issue ? <span className="cell-error">{issue.message}</span> : null}
                                      </td>
                                    );
                                  })}
                                  <td>
                                    <button
                                      type="button"
                                      className="text-link-button"
                                      onClick={() => deleteRows([row.id])}
                                    >
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
                          <span>文件导入</span>
                          <strong>
                            {parseProgress.active
                              ? `${parseProgress.value}% · ${parseProgress.processed}/${parseProgress.total}`
                              : "待处理"}
                          </strong>
                        </div>
                        <div className="progress-track">
                          <span className="progress-bar" style={{ width: `${parseProgress.value}%` }} />
                        </div>
                      </div>
                      <div className="progress-block">
                        <div className="progress-head">
                          <span>提交下单</span>
                          <strong>
                            {submitProgress.active
                              ? `${submitProgress.value}% · ${submitProgress.processed}/${submitProgress.total}`
                              : "待处理"}
                          </strong>
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
                        <p className="section-kicker">模板</p>
                        <h3>缓存状态与最近保存</h3>
                      </div>
                    </div>

                    <div className="overview-grid">
                      <article className="overview-card">
                        <p>模板缓存</p>
                        <strong>{templateInfo ? "已保存" : "未保存"}</strong>
                        <span>{templateInfo || "导入后会自动学习这份模板。"}</span>
                      </article>
                      <article className="overview-card">
                        <p>最近保存</p>
                        <strong>{lastSavedAt || "-"}</strong>
                        <span>本地与服务端都会同步模板规则。</span>
                      </article>
                      <article className="overview-card">
                        <p>当前选中</p>
                        <strong>{selectedCount}</strong>
                        <span>可批量删除或重新导出。</span>
                      </article>
                      <article className="overview-card">
                        <p>校验提示</p>
                        <strong>{validation.issues.length}</strong>
                        <span>{rowErrorSummary[0] || "暂无阻塞性问题。"}</span>
                      </article>
                    </div>
                  </section>
                </section>
              </>
            ) : (
              <section className="workspace-card">
                <div className="workspace-header" style={{ marginBottom: 16 }}>
                  <div>
                    <p className="workspace-breadcrumb">AI考试 / 20260507 / 万能导入</p>
                    <h1>已导入运单</h1>
                  </div>
                  <div className="workspace-header-meta">
                    <div className="meta-chip">
                      <span>总记录</span>
                      <strong>{historyData.total ?? 0}</strong>
                    </div>
                    <div className="meta-chip">
                      <span>当前页</span>
                      <strong>{historyData.page ?? 1}</strong>
                    </div>
                    <div className="meta-chip">
                      <span>每页</span>
                      <strong>{historyFilters.pageSize}</strong>
                    </div>
                  </div>
                </div>

                <div className="card-heading">
                  <div>
                    <p className="section-kicker">历史</p>
                    <h3>已导入运单列表</h3>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void loadHistory({ ...historyFilters })}
                  >
                    刷新
                  </button>
                </div>

                <div className="history-filters">
                  <label className="search-field">
                    <span>关键字</span>
                    <input
                      value={historyFilters.query}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({ ...current, query: event.target.value }))
                      }
                      placeholder="外部编码 / 收件人 / 文件名"
                    />
                  </label>
                  <label className="search-field">
                    <span>外部编码</span>
                    <input
                      value={historyFilters.externalCode}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({
                          ...current,
                          externalCode: event.target.value,
                        }))
                      }
                      placeholder="精确或模糊搜索"
                    />
                  </label>
                  <label className="search-field">
                    <span>收件人姓名</span>
                    <input
                      value={historyFilters.receiverName}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({
                          ...current,
                          receiverName: event.target.value,
                        }))
                      }
                      placeholder="支持模糊搜索"
                    />
                  </label>
                  <label className="search-field">
                    <span>提交日期</span>
                    <input
                      type="date"
                      value={historyFilters.submittedAt}
                      onChange={(event) =>
                        setHistoryFilters((current) => ({
                          ...current,
                          submittedAt: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="search-actions">
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void loadHistory({ ...historyFilters, page: 1 })}
                    >
                      查询
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setHistoryFilters(DEFAULT_HISTORY_FILTERS);
                        void loadHistory(DEFAULT_HISTORY_FILTERS);
                      }}
                    >
                      重置
                    </button>
                  </div>
                </div>

                <div className="table-shell import-history-shell">
                  <table className="data-table history-table">
                    <thead>
                      <tr>
                        <th>批次</th>
                        <th>外部编码</th>
                        <th>收件人</th>
                        <th>行号</th>
                        <th>文件</th>
                        <th>提交时间</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyLoading ? (
                        <tr>
                          <td colSpan={7} className="empty-row">
                            正在加载历史数据...
                          </td>
                        </tr>
                      ) : (historyData.records ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={7} className="empty-row">
                            暂无已导入运单记录。
                          </td>
                        </tr>
                      ) : (
                        historyData.records?.map((record) => (
                          <tr key={record.id}>
                            <td>{record.batch.batchName}</td>
                            <td>{record.externalCode || "-"}</td>
                            <td>{record.receiverName}</td>
                            <td>{record.rowIndex}</td>
                            <td>{record.batch.originalFileName || "-"}</td>
                            <td>
                              {new Date(record.batch.createdAt).toLocaleString("zh-CN", {
                                hour12: false,
                              })}
                            </td>
                            <td>{record.batch.status}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="pagination-bar">
                  <div className="pagination-summary">
                    <span>共 {historyData.total ?? 0} 条</span>
                    <span>{historyStatus || " "}</span>
                  </div>
                  <div className="pagination-controls">
                    <button
                      type="button"
                      className="page-button"
                      disabled={historyLoading || (historyData.page ?? 1) <= 1}
                      onClick={() =>
                        void loadHistory({
                          ...historyFilters,
                          page: Math.max((historyData.page ?? 1) - 1, 1),
                        })
                      }
                    >
                      上一页
                    </button>
                    <span className="page-button active">
                      {historyData.page ?? 1} / {historyData.totalPages ?? 1}
                    </span>
                    <button
                      type="button"
                      className="page-button"
                      disabled={
                        historyLoading ||
                        (historyData.page ?? 1) >= (historyData.totalPages ?? 1)
                      }
                      onClick={() =>
                        void loadHistory({
                          ...historyFilters,
                          page: (historyData.page ?? 1) + 1,
                        })
                      }
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
