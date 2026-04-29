"use client";

import {
  BUSINESS_DOMAIN_OPTIONS,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  QUOTE_TYPE_OPTIONS,
} from "@/lib/fee-type-config";
import { type FeeTypePayload } from "@/lib/fee-type-validation";
import { startTransition, useMemo, useState } from "react";

type FeeTypeRecord = {
  id: string;
  feeCode: string;
  feeName: string;
  businessDomain: string;
  quoteTypes: string[];
  note: string | null;
  createdBy: string;
  createdAt: string | Date;
  updatedBy: string;
  updatedAt: string | Date;
};

type FilterState = {
  feeCode: string;
  feeName: string;
  businessDomain: string;
  quoteTypes: string[];
};

type PaginationState = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type FormState = FeeTypePayload;

type FeeTypeListResponse = {
  feeTypes?: FeeTypeRecord[];
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  error?: string;
};

const DEFAULT_FILTERS: FilterState = {
  feeCode: "",
  feeName: "",
  businessDomain: "",
  quoteTypes: [],
};

const DEFAULT_FORM: FormState = {
  feeCode: "",
  feeName: "",
  businessDomain: "",
  quoteTypes: [],
  note: "",
};

type FeeTypeManagerProps = {
  initialRows: FeeTypeRecord[];
  initialPagination: PaginationState;
  databaseReady: boolean;
};

function formatDateTime(value: string | Date) {
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
  });
}

function buildQuery(filters: FilterState, page: number, pageSize: number) {
  const params = new URLSearchParams();

  if (filters.feeCode.trim()) {
    params.set("feeCode", filters.feeCode.trim());
  }

  if (filters.feeName.trim()) {
    params.set("feeName", filters.feeName.trim());
  }

  if (filters.businessDomain) {
    params.set("businessDomain", filters.businessDomain);
  }

  filters.quoteTypes.forEach((item) => {
    params.append("quoteType", item);
  });

  params.set("page", String(page));
  params.set("pageSize", String(pageSize));

  return `?${params.toString()}`;
}

function QuoteTypeDropdown({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (nextValue: string[]) => void;
}) {
  const summaryLabel = value.length > 0 ? value.join("、") : "全部";

  return (
    <details className="multi-select">
      <summary>
        <span>{label}</span>
        <strong>{summaryLabel}</strong>
      </summary>
      <div className="multi-select-panel">
        {QUOTE_TYPE_OPTIONS.map((item) => {
          const checked = value.includes(item.value);

          return (
            <label className="checkbox-option" key={item.value}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => {
                  const nextValue = checked
                    ? value.filter((entry) => entry !== item.value)
                    : [...value, item.value];

                  onChange(nextValue);
                }}
              />
              <span>{item.label}</span>
            </label>
          );
        })}
      </div>
    </details>
  );
}

function getVisiblePages(totalPages: number, currentPage: number) {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, start + 4);
  const normalizedStart = Math.max(1, end - 4);

  return Array.from({ length: end - normalizedStart + 1 }, (_, index) => normalizedStart + index);
}

export function FeeTypeManager({
  initialRows,
  initialPagination,
  databaseReady,
}: FeeTypeManagerProps) {
  const [rows, setRows] = useState(initialRows);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [pagination, setPagination] = useState<PaginationState>(initialPagination);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit" | "detail" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<FeeTypeRecord | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.includes(row.id)),
    [rows, selectedIds],
  );
  const allVisibleSelected = rows.length > 0 && rows.every((row) => selectedIds.includes(row.id));
  const visiblePages = getVisiblePages(pagination.totalPages, pagination.page);

  async function loadRows(
    nextFilters: FilterState,
    nextPage: number,
    nextPageSize: number,
    successMessage?: string,
  ) {
    setLoading(true);

    try {
      const response = await fetch(`/api/fee-types${buildQuery(nextFilters, nextPage, nextPageSize)}`, {
        method: "GET",
      });
      const data = (await response.json()) as FeeTypeListResponse;

      if (
        !response.ok ||
        !data.feeTypes ||
        typeof data.total !== "number" ||
        typeof data.page !== "number" ||
        typeof data.pageSize !== "number" ||
        typeof data.totalPages !== "number"
      ) {
        throw new Error(data.error ?? "查询失败，请稍后重试。");
      }

      const nextRows = data.feeTypes;
      const nextTotal = data.total;
      const resolvedPage = data.page;
      const resolvedPageSize = data.pageSize;
      const resolvedTotalPages = data.totalPages;

      startTransition(() => {
        setRows(nextRows);
        setSelectedIds([]);
        setPagination({
          total: nextTotal,
          page: resolvedPage,
          pageSize: resolvedPageSize,
          totalPages: resolvedTotalPages,
        });
        setStatus(successMessage ?? "");
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "查询失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  function resetModal() {
    setModalMode(null);
    setEditingId(null);
    setDetailRow(null);
    setForm(DEFAULT_FORM);
    setSubmitting(false);
  }

  function openCreateModal() {
    setForm(DEFAULT_FORM);
    setEditingId(null);
    setModalMode("create");
    setStatus("");
  }

  function openEditModal() {
    if (selectedRows.length !== 1) {
      setStatus("编辑前请先且仅选择一条费用类型数据。");
      return;
    }

    const target = selectedRows[0];
    setEditingId(target.id);
    setForm({
      feeCode: target.feeCode,
      feeName: target.feeName,
      businessDomain: target.businessDomain,
      quoteTypes: target.quoteTypes,
      note: target.note ?? "",
    });
    setModalMode("edit");
    setStatus("");
  }

  function openDetailModal(targetRow?: FeeTypeRecord) {
    const target = targetRow ?? selectedRows[0];

    if (!target) {
      setStatus("查看前请先且仅选择一条费用类型数据。");
      return;
    }

    if (!targetRow && selectedRows.length !== 1) {
      setStatus("查看前请先且仅选择一条费用类型数据。");
      return;
    }

    setDetailRow(target);
    setModalMode("detail");
    setStatus("");
  }

  async function handleSubmit() {
    if (!modalMode) {
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch(
        modalMode === "create" ? "/api/fee-types" : `/api/fee-types/${editingId}`,
        {
          method: modalMode === "create" ? "POST" : "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(form),
        },
      );

      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "提交失败，请稍后重试。");
      }

      resetModal();
      await loadRows(
        filters,
        modalMode === "create" ? 1 : pagination.page,
        pagination.pageSize,
        modalMode === "create" ? "费用类型新增成功。" : "费用类型编辑成功。",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "提交失败，请稍后重试。");
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (selectedIds.length === 0) {
      setStatus("删除前请至少选择一条费用类型数据。");
      return;
    }

    if (!window.confirm(`确定删除已选中的 ${selectedIds.length} 条费用类型数据吗？`)) {
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/fee-types", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: selectedIds }),
      });

      const data = (await response.json()) as { deletedCount?: number; error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "删除失败，请稍后重试。");
      }

      await loadRows(
        filters,
        pagination.page,
        pagination.pageSize,
        `已删除 ${data.deletedCount ?? selectedIds.length} 条费用类型数据。`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "删除失败，请稍后重试。");
      setLoading(false);
    }
  }

  return (
    <main className="admin-shell">
      <section className="admin-heading">
        <p className="page-index">1、新增费用类型维护页面</p>
        <div>
          <h1>费用类型维护</h1>
          <p>支持查询、新增、编辑、批量删除，以及分页和每页条数切换。</p>
        </div>
      </section>

      <section className="workspace-card">
        <div className="search-grid">
          <label className="search-field">
            <span>费用编号</span>
            <input
              value={filters.feeCode}
              onChange={(event) =>
                setFilters((current) => ({ ...current, feeCode: event.target.value }))
              }
              placeholder="请输入费用编号"
            />
          </label>

          <label className="search-field">
            <span>费用名称</span>
            <input
              value={filters.feeName}
              onChange={(event) =>
                setFilters((current) => ({ ...current, feeName: event.target.value }))
              }
              placeholder="请输入费用名称"
            />
          </label>

          <label className="search-field">
            <span>所属业务域</span>
            <select
              value={filters.businessDomain}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  businessDomain: event.target.value,
                }))
              }
            >
              <option value="">全部</option>
              {BUSINESS_DOMAIN_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <QuoteTypeDropdown
            label="所属报价"
            value={filters.quoteTypes}
            onChange={(nextValue) =>
              setFilters((current) => ({
                ...current,
                quoteTypes: nextValue,
              }))
            }
          />

          <div className="search-actions">
            <button
              type="button"
              className="primary-button"
              disabled={loading}
              onClick={() => void loadRows(filters, 1, pagination.pageSize, "查询完成。")}
            >
              {loading ? "查询中..." : "查询"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
                void loadRows(DEFAULT_FILTERS, 1, DEFAULT_PAGE_SIZE, "已重置查询条件。");
              }}
            >
              重置
            </button>
          </div>
        </div>

        <div className="toolbar">
          <button type="button" className="tool-button" onClick={openCreateModal}>
            <span className="tool-icon">⊕</span>
            新增
          </button>
          <button type="button" className="tool-button" onClick={() => openDetailModal()}>
            <span className="tool-icon">◉</span>
            查看
          </button>
          <button type="button" className="tool-button" onClick={openEditModal}>
            <span className="tool-icon">✎</span>
            编辑
          </button>
          <button type="button" className="tool-button danger" onClick={() => void handleDelete()}>
            <span className="tool-icon">🗑</span>
            删除
          </button>
        </div>

        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>序号</th>
                <th className="checkbox-cell">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) => {
                      setSelectedIds(event.target.checked ? rows.map((row) => row.id) : []);
                    }}
                  />
                </th>
                <th>费用编号</th>
                <th>费用名称</th>
                <th>所属业务域</th>
                <th>所属报价</th>
                <th>备注</th>
                <th>创建人</th>
                <th>创建时间</th>
                <th>修改人</th>
                <th>修改时间</th>
              </tr>
            </thead>
            <tbody>
              {!databaseReady ? (
                <tr>
                  <td colSpan={11} className="empty-row">
                    数据库尚未就绪，请先完成最新版本部署或等待 migration 执行完成。
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="empty-row">
                    暂无符合条件的数据。
                  </td>
                </tr>
              ) : (
                rows.map((row, index) => {
                  const checked = selectedIds.includes(row.id);
                  const sequence = (pagination.page - 1) * pagination.pageSize + index + 1;

                  return (
                    <tr key={row.id}>
                      <td>{sequence}</td>
                      <td className="checkbox-cell">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSelectedIds((current) =>
                              checked
                                ? current.filter((item) => item !== row.id)
                                : [...current, row.id],
                            );
                          }}
                        />
                      </td>
                      <td>{row.feeCode}</td>
                      <td>
                        <button
                          type="button"
                          className="text-link-button"
                          onClick={() => openDetailModal(row)}
                        >
                          {row.feeName}
                        </button>
                      </td>
                      <td>{row.businessDomain}</td>
                      <td>{row.quoteTypes.join("，") || "-"}</td>
                      <td>{row.note || "-"}</td>
                      <td>{row.createdBy}</td>
                      <td>{formatDateTime(row.createdAt)}</td>
                      <td>{row.updatedBy}</td>
                      <td>{formatDateTime(row.updatedAt)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="pagination-bar">
          <div className="pagination-summary">
            <span>共 {pagination.total} 条</span>
            <label className="page-size-switcher">
              <span>每页</span>
              <select
                value={pagination.pageSize}
                onChange={(event) => {
                  const nextPageSize = Number(event.target.value);
                  void loadRows(filters, 1, nextPageSize, `已切换为每页 ${nextPageSize} 条。`);
                }}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size} 条
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="pagination-controls">
            <button
              type="button"
              className="page-button"
              disabled={loading || pagination.page <= 1}
              onClick={() => void loadRows(filters, pagination.page - 1, pagination.pageSize)}
            >
              上一页
            </button>

            <div className="page-number-list">
              {visiblePages.map((pageNumber) => (
                <button
                  type="button"
                  key={pageNumber}
                  className={`page-button${pageNumber === pagination.page ? " active" : ""}`}
                  disabled={loading}
                  onClick={() => void loadRows(filters, pageNumber, pagination.pageSize)}
                >
                  {pageNumber}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="page-button"
              disabled={loading || pagination.page >= pagination.totalPages}
              onClick={() => void loadRows(filters, pagination.page + 1, pagination.pageSize)}
            >
              下一页
            </button>
          </div>
        </div>

        <div className="workspace-footer">
          <p className={`status-text${status ? " visible" : ""}`}>{status || " "}</p>
          <p className="footnote">
            当前第 {pagination.page} / {pagination.totalPages} 页。新增后默认回到第一页，删除后会自动修正页码。
          </p>
        </div>
      </section>

      {modalMode ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="fee-type-title">
            <div className="modal-header">
              <div>
                <p className="modal-kicker">
                  {modalMode === "create" ? "新增" : modalMode === "edit" ? "编辑" : "详情"}
                </p>
                <h2 id="fee-type-title">
                  {modalMode === "create"
                    ? "新增费用类型"
                    : modalMode === "edit"
                      ? "编辑费用类型"
                      : "费用类型详情"}
                </h2>
              </div>
              <button type="button" className="close-button" onClick={resetModal}>
                ×
              </button>
            </div>

            {modalMode === "detail" && detailRow ? (
              <>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span>费用编号</span>
                    <strong>{detailRow.feeCode}</strong>
                  </div>
                  <div className="detail-item">
                    <span>费用名称</span>
                    <strong>{detailRow.feeName}</strong>
                  </div>
                  <div className="detail-item">
                    <span>所属业务域</span>
                    <strong>{detailRow.businessDomain}</strong>
                  </div>
                  <div className="detail-item">
                    <span>所属报价</span>
                    <strong>{detailRow.quoteTypes.join("，") || "-"}</strong>
                  </div>
                  <div className="detail-item full-span">
                    <span>备注</span>
                    <strong>{detailRow.note || "-"}</strong>
                  </div>
                  <div className="detail-item">
                    <span>创建人</span>
                    <strong>{detailRow.createdBy}</strong>
                  </div>
                  <div className="detail-item">
                    <span>创建时间</span>
                    <strong>{formatDateTime(detailRow.createdAt)}</strong>
                  </div>
                  <div className="detail-item">
                    <span>修改人</span>
                    <strong>{detailRow.updatedBy}</strong>
                  </div>
                  <div className="detail-item">
                    <span>修改时间</span>
                    <strong>{formatDateTime(detailRow.updatedAt)}</strong>
                  </div>
                </div>

                <div className="modal-actions">
                  <button type="button" className="secondary-button" onClick={resetModal}>
                    关闭
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-form">
                  <label className="form-field">
                    <span>费用编号</span>
                    <input
                      value={form.feeCode}
                      disabled={modalMode === "edit"}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, feeCode: event.target.value }))
                      }
                      placeholder="只能输入数字，最多 8 位"
                    />
                  </label>

                  <label className="form-field">
                    <span>费用名称</span>
                    <input
                      value={form.feeName}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, feeName: event.target.value }))
                      }
                      placeholder="最多 32 个字符"
                    />
                  </label>

                  <label className="form-field">
                    <span>所属业务域</span>
                    <select
                      value={form.businessDomain}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          businessDomain: event.target.value,
                        }))
                      }
                    >
                      <option value="">请选择所属业务域</option>
                      {BUSINESS_DOMAIN_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="form-field full-span">
                    <span>所属报价</span>
                    <div className="quote-grid">
                      {QUOTE_TYPE_OPTIONS.map((item) => {
                        const checked = form.quoteTypes.includes(item.value);

                        return (
                          <label className="checkbox-option" key={item.value}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setForm((current) => ({
                                  ...current,
                                  quoteTypes: checked
                                    ? current.quoteTypes.filter((entry) => entry !== item.value)
                                    : [...current.quoteTypes, item.value],
                                }));
                              }}
                            />
                            <span>{item.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <label className="form-field full-span">
                    <span>备注</span>
                    <textarea
                      value={form.note}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, note: event.target.value }))
                      }
                      placeholder="最多 256 个字符"
                      rows={4}
                    />
                  </label>
                </div>

                <div className="modal-actions">
                  <button type="button" className="secondary-button" onClick={resetModal}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={submitting}
                    onClick={() => void handleSubmit()}
                  >
                    {submitting ? "提交中..." : "保存"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}
