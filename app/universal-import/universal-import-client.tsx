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

type ParseProgress = {
  active: boolean;
  value: number;
  label: string;
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
  const mapping = Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => {
      const value = candidate[field.key];
      return [field.key, typeof value === "number" ? value : null];
    }),
  ) as UniversalImportMapping;

  return mapping;
}

function downloadWorkbook(rows: DraftRow[], sheetName: string) {
  const workbook = XLSX.utils.book_new();
  const exportRows = rows.map((row) =>
    Object.fromEntries(
      UNIVERSAL_IMPORT_FIELDS.map((field) => [UNIVERSAL_IMPORT_FIELD_LABELS[field.key], row[field.key]]),
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
  const [parseProgress, setParseProgress] = useState<ParseProgress>({
    active: false,
    value: 0,
    label: "",
  });
  const [submitProgress, setSubmitProgress] = useState<ParseProgress>({
    active: false,
    value: 0,
    label: "",
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyData, setHistoryData] = useState<ShipmentHistoryResponse>({});
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const [templateInfo, setTemplateInfo] = useState<string>("");
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [existingCodeRows, setExistingCodeRows] = useState<{ externalCode: string | null }[]>([]);

  const existingExternalCodes = useMemo(() => {
    return new Set(
      existingCodeRows
        .map((record) => record.externalCode?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value)),
    );
  }, [existingCodeRows]);

  const validation = useMemo(
    () => validateImportRows(draftRows, existingExternalCodes),
    [draftRows, existingExternalCodes],
  );

  const errorRowCount = useMemo(() => {
    return new Set(validation.issues.map((issue) => issue.rowIndex)).size;
  }, [validation.issues]);

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
        throw new Error(data.error ?? "查询历史失败，请稍后重试。");
      }

      setHistoryData(data);
    } catch (error) {
      setHistoryStatus(error instanceof Error ? error.message : "查询历史失败，请稍后重试。");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadHistoryCodes() {
    try {
      const response = await fetch("/api/universal-import/shipments?page=1&pageSize=1000");
      const data = (await response.json()) as ShipmentHistoryResponse;

      if (!response.ok || !data.records) {
        return;
      }

      setExistingCodeRows(
        data.records.map((record) => ({
          externalCode: record.externalCode,
        })),
      );
    } catch {
      // ignore code warmup errors
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
      // ignore localStorage errors
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
    setStatus("已更新模板映射。");

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
          setTemplateInfo("已使用本地记忆模板。");
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
    setTemplateInfo("已自动识别模板字段。");
    return false;
  }

  async function handleFile(file: File) {
    setSubmitting(false);
    setStatus("");
    setTemplateInfo("");
    setParseProgress({ active: true, value: 8, label: "正在读取文件..." });

    try {
      const buffer = await file.arrayBuffer();
      setParseProgress({ active: true, value: 22, label: "正在解析工作簿..." });
      const workbook = XLSX.read(buffer, { type: "array" });

      if (!workbook.SheetNames.length) {
        throw new Error("文件中没有可用的 Sheet。");
      }

      const nextSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[nextSheetName];
      const matrix = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
      }) as unknown[][];

      const meaningfulRows = matrix.filter(isNonEmptyRow);

      if (meaningfulRows.length === 0) {
        throw new Error("文件为空或没有有效数据。");
      }

      setParseProgress({ active: true, value: 46, label: "正在识别表头..." });
      const headerInfo = detectHeaderRow(meaningfulRows);
      const nextHeaders = headerInfo.headers.map((header) => String(header ?? "").trim());
      const nextRawRows = meaningfulRows.slice(headerInfo.rowIndex + 1).filter(isNonEmptyRow);

      if (nextRawRows.length === 0) {
        throw new Error("未找到可导入的数据行。");
      }

      const nextFingerprint = buildTemplateFingerprint(nextSheetName, nextHeaders);

      setFileName(file.name);
      setSheetName(nextSheetName);
      setHeaders(nextHeaders);
      setRawRows(nextRawRows);
      setFingerprint(nextFingerprint);

      setParseProgress({ active: true, value: 68, label: "正在应用模板映射..." });
      await restoreTemplateFromCache(nextFingerprint, nextHeaders, nextRawRows);

      setParseProgress({ active: true, value: 86, label: "正在校验导入数据..." });
      setStatus("文件已导入，可继续调整映射与内容。");
      setParseProgress({ active: true, value: 100, label: "导入完成" });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "解析失败，请稍后重试。");
    } finally {
      window.setTimeout(() => {
        setParseProgress({ active: false, value: 0, label: "" });
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
    setStatus("已更新映射并重新生成预览。");
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

    setDraftRows((current) => current.filter((row) => !ids.includes(row.id)).map((row, index) => ({
      ...row,
      rowIndex: index + 1,
    })));
    setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
    setStatus("已删除所选行。");
  }

  function exportPreview() {
    if (draftRows.length === 0) {
      setStatus("没有可导出的预览数据。");
      return;
    }

    downloadWorkbook(draftRows, sheetName);
    setStatus("已导出当前预览内容。");
  }

  async function submitImport() {
    if (draftRows.length === 0) {
      setStatus("请先导入 Excel 文件。");
      return;
    }

    if (hasBlockingErrors) {
      setStatus("存在错误行，请先修正后再提交。");
      return;
    }

    setSubmitting(true);
    setSubmitProgress({ active: true, value: 12, label: "正在提交下单..." });

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
        throw new Error(data.error ?? "提交失败，请稍后重试。");
      }

      setSubmitProgress({ active: true, value: 100, label: "提交完成" });
      setStatus(
        `提交成功：成功 ${data.summary?.successCount ?? draftRows.length} 条，失败 ${data.summary?.failCount ?? 0} 条。`,
      );
      void loadHistory({ ...historyFilters, page: 1 });
      void loadHistoryCodes();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "提交失败，请稍后重试。");
      setSubmitProgress({ active: false, value: 0, label: "" });
    } finally {
      window.clearInterval(timer);
      setSubmitting(false);
      window.setTimeout(() => {
        setSubmitProgress({ active: false, value: 0, label: "" });
      }, 700);
    }
  }

  useEffect(() => {
    void loadHistory(DEFAULT_HISTORY_FILTERS);
    void loadHistoryCodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const rowErrorSummary = useMemo(() => {
    return validation.issues.map((issue) => formatIssueLabel(issue));
  }, [validation.issues]);

  const columnOptions = useMemo(
    () => headers.map((header, index) => ({ value: String(index), label: `${index + 1}. ${header || "空列"}` })),
    [headers],
  );

  return (
    <main className="import-shell">
      <div className="import-topbar">
        <div>
          <p className="workspace-breadcrumb">万能导入 / 多模板自动导入下单系统</p>
          <h1>万能导入</h1>
          <p className="import-subtitle">
            当前登录：{operatorName}。支持 Excel 模板自动识别、手动映射、实时校验与批量提交。
          </p>
        </div>
        <div className="import-topbar-actions">
          <Link className="secondary-button" href="/">
            返回费用类型
          </Link>
          <button
            type="button"
            className="primary-button"
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

      <section className="import-hero">
        <div className="hero-copy">
          <p className="section-kicker">Excel 解析</p>
          <h2>多模板自动识别，手动映射后自动记忆</h2>
          <p>
            先上传模板，系统会自动识别表头；如果识别不准，可直接手动调整列映射。修改后会记住这套结构，下次同类模板会自动套用。
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
            <span>提交前必须清空</span>
          </article>
          <article className="overview-card success">
            <p>历史运单</p>
            <strong>{historyData.total ?? 0}</strong>
            <span>数据库已保存记录</span>
          </article>
          <article className="overview-card">
            <p>模板状态</p>
            <strong>{templateInfo ? "已记忆" : "待识别"}</strong>
            <span>{templateInfo || lastSavedAt || "上传后自动学习"}</span>
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
            <div className="header-pills">
              {parseProgress.active ? (
                <span className="pill loading">
                  {parseProgress.label} {parseProgress.value}%
                </span>
              ) : null}
              {submitProgress.active ? (
                <span className="pill loading">
                  {submitProgress.label} {submitProgress.value}%
                </span>
              ) : null}
            </div>
          </div>

          <div
            className="upload-dropzone"
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files?.[0];
              if (file) {
                void handleFile(file);
              }
            }}
          >
            <strong>拖拽 Excel 文件到这里，或者点击右上角按钮选择文件</strong>
            <span>支持 .xlsx / .xls，先自动识别，再可手动修正映射。</span>
          </div>

          <div className="mapping-toolbar">
            <div>
              <p className="section-kicker">映射学习</p>
              <h3>{fileName || "尚未导入文件"}</h3>
              <p className="muted-text">
                {sheetName} {fingerprint ? `· ${fingerprint}` : ""} {lastSavedAt ? `· 保存于 ${lastSavedAt}` : ""}
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
                删除所选
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
                {submitting ? "提交中..." : "提交下单"}
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
                    <option value="">自动识别 / 不映射</option>
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
            <p className="footnote">{rowErrorSummary[0] || "自动校验会在这里提示最先出现的问题。"}</p>
          </div>

          {rowErrorSummary.length > 0 ? (
            <div className="error-list">
              {rowErrorSummary.slice(0, 12).map((item) => (
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
                      onChange={(event) => {
                        setSelectedIds(event.target.checked ? draftRows.map((row) => row.id) : []);
                      }}
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
                      上传文件后，这里会展示可编辑的预览表格。
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
                                  onChange={(event) => handleCellChange(row.id, field.key, event.target.value)}
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
                                  onChange={(event) => handleCellChange(row.id, field.key, event.target.value)}
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
                <strong>{parseProgress.active ? `${parseProgress.value}%` : "待命"}</strong>
              </div>
              <div className="progress-track">
                <span className="progress-bar" style={{ width: `${parseProgress.value}%` }} />
              </div>
            </div>
            <div className="progress-block">
              <div className="progress-head">
                <span>提交下单</span>
                <strong>{submitProgress.active ? `${submitProgress.value}%` : "待命"}</strong>
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
              <span>关键词</span>
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
                      <td>{new Date(record.batch.createdAt).toLocaleString("zh-CN", { hour12: false })}</td>
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
                disabled={historyLoading || (historyData.page ?? 1) >= (historyData.totalPages ?? 1)}
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
      </section>
    </main>
  );
}
