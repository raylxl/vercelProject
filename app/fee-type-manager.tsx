"use client";

import {
  ACCOUNT_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
} from "@/lib/account-rules";
import { type ReactNode, useMemo, useState } from "react";

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

type FeeTypeOperationLogRecord = {
  id: string;
  feeTypeId: string | null;
  feeCode: string;
  feeName: string;
  operationType: string;
  operatorName: string;
  summary: string;
  createdAt: string | Date;
};

type PaginationState = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type SidebarMenuItem = {
  label: string;
  page?: "fee-type-manager" | "universal-import";
  children?: SidebarMenuItem[];
};

const TOP_NAV_ITEMS = ["AI考试", "20260507", "万能导入"] as const;

const SIDEBAR_MENUS: SidebarMenuItem[] = [
  {
    label: "AI考试",
    children: [
      {
        label: "20260507",
        children: [{ label: "万能导入", page: "universal-import" }],
      },
    ],
  },
];

type FeeTypeManagerProps = {
  isAuthenticated: boolean;
  initialRows: FeeTypeRecord[];
  initialOperationLogs: FeeTypeOperationLogRecord[];
  initialOperatorName: string;
  initialPagination: PaginationState;
  databaseReady: boolean;
};

function filterSidebarMenus(items: SidebarMenuItem[], keyword: string): SidebarMenuItem[] {
  if (!keyword.trim()) {
    return items;
  }

  const normalizedKeyword = keyword.trim();

  return items.reduce<SidebarMenuItem[]>((result, item) => {
    const filteredChildren = item.children
      ? filterSidebarMenus(item.children, normalizedKeyword)
      : undefined;

    if (item.label.includes(normalizedKeyword)) {
      result.push({
        ...item,
        children: item.children,
      });
      return result;
    }

    if (filteredChildren && filteredChildren.length > 0) {
      result.push({
        ...item,
        children: filteredChildren,
      });
    }

    return result;
  }, []);
}

function hasPageInTree(item: SidebarMenuItem, page: "fee-type-manager" | "universal-import"): boolean {
  if (item.page === page) {
    return true;
  }

  return item.children?.some((child) => hasPageInTree(child, page)) ?? false;
}

export function FeeTypeManager({
  isAuthenticated,
  initialOperatorName,
}: FeeTypeManagerProps) {
  const [sidebarKeyword, setSidebarKeyword] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [expandedMenuPaths, setExpandedMenuPaths] = useState<string[]>([
    "AI考试",
    "AI考试/20260507",
  ]);
  const [activeMenuPath, setActiveMenuPath] = useState("AI考试/20260507/万能导入");
  const [loginForm, setLoginForm] = useState({
    username: "",
    password: "",
  });
  const [loginStatus, setLoginStatus] = useState("");

  const filteredMenus = useMemo(
    () => filterSidebarMenus(SIDEBAR_MENUS, sidebarKeyword),
    [sidebarKeyword],
  );

  async function handleLogin() {
    setAuthSubmitting(true);
    setLoginStatus("");

    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(loginForm),
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "登录失败，请稍后重试。");
      }

      window.location.reload();
    } catch (error) {
      setLoginStatus(error instanceof Error ? error.message : "登录失败，请稍后重试。");
      setAuthSubmitting(false);
    }
  }

  async function handleRegister() {
    setAuthSubmitting(true);
    setLoginStatus("");

    try {
      const response = await fetch("/api/session", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(loginForm),
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "注册失败，请稍后重试。");
      }

      window.location.reload();
    } catch (error) {
      setLoginStatus(error instanceof Error ? error.message : "注册失败，请稍后重试。");
      setAuthSubmitting(false);
    }
  }

  async function handleLogout() {
    setAuthSubmitting(true);

    try {
      const response = await fetch("/api/session", {
        method: "DELETE",
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "退出登录失败，请稍后重试。");
      }

      window.location.reload();
    } catch (error) {
      setLoginStatus(error instanceof Error ? error.message : "退出登录失败，请稍后重试。");
      setAuthSubmitting(false);
    }
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

    if (item.page === "universal-import") {
      window.location.assign("/universal-import");
      return;
    }

    if (!hasPageInTree(item, "universal-import")) {
      return;
    }
  }

  function renderSidebarMenus(items: SidebarMenuItem[], parentPath = "", depth = 0): ReactNode {
    if (items.length === 0) {
      return null;
    }

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
                <div className="sidebar-subnav">
                  {renderSidebarMenus(item.children, path, depth + 1)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="login-brand">
            <div className="brand-logo">AI</div>
            <div className="brand-copy">
              <strong>万能导入系统</strong>
              <span>登录后进入万能导入页面</span>
            </div>
          </div>

          <div className="login-copy">
            <p className="section-kicker">Account Access</p>
            <h1>登录或注册账号</h1>
            <p>
              支持登录后进入万能导入模块。账号最长 {ACCOUNT_NAME_MAX_LENGTH} 位，密码为数字且最长
              {PASSWORD_MAX_LENGTH} 位。
            </p>
          </div>

          <div className="login-form">
            <label className="form-field">
              <span>账号</span>
              <input
                value={loginForm.username}
                onChange={(event) =>
                  setLoginForm((current) => ({
                    ...current,
                    username: Array.from(event.target.value).slice(0, ACCOUNT_NAME_MAX_LENGTH).join(""),
                  }))
                }
                maxLength={ACCOUNT_NAME_MAX_LENGTH}
                placeholder="请输入账号"
              />
            </label>

            <label className="form-field">
              <span>密码</span>
              <input
                type="password"
                value={loginForm.password}
                onChange={(event) =>
                  setLoginForm((current) => ({
                    ...current,
                    password: event.target.value.replace(/\D/g, "").slice(0, PASSWORD_MAX_LENGTH),
                  }))
                }
                inputMode="numeric"
                maxLength={PASSWORD_MAX_LENGTH}
                placeholder="请输入数字密码"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleLogin();
                  }
                }}
              />
            </label>

            <div className="login-actions">
              <button
                type="button"
                className="primary-button login-button"
                disabled={authSubmitting}
                onClick={() => void handleLogin()}
              >
                {authSubmitting ? "提交中..." : "登录"}
              </button>
              <button
                type="button"
                className="secondary-button login-button"
                disabled={authSubmitting}
                onClick={() => void handleRegister()}
              >
                {authSubmitting ? "提交中..." : "注册并登录"}
              </button>
            </div>

            <p className={`login-status${loginStatus ? " visible" : ""}`}>{loginStatus || " "}</p>
          </div>
        </section>
      </main>
    );
  }

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

        <label className="sidebar-search">
          <span>输入菜单名称</span>
          <input
            value={sidebarKeyword}
            onChange={(event) => setSidebarKeyword(event.target.value)}
            placeholder="搜索菜单"
          />
        </label>

        <nav className="sidebar-nav" aria-label="系统菜单">
          {renderSidebarMenus(filteredMenus)}
        </nav>

        <div className="sidebar-env-card">
          <div>
            <strong>{initialOperatorName}</strong>
            <span>当前系统仅保留万能导入菜单，点击即可进入。</span>
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
              {authSubmitting ? "退出中..." : initialOperatorName}
            </button>
          </div>
        </header>

        <section className="workspace-shell">
          <div className="workspace-tabbar">
            <button
              type="button"
              className="workspace-tab active"
              onClick={() => window.location.assign("/universal-import")}
            >
              万能导入
            </button>
          </div>

          <div className="workspace-stage">
            <section className="workspace-card">
              <div className="workspace-header" style={{ marginBottom: 16 }}>
                <div>
                  <p className="workspace-breadcrumb">AI考试 / 20260507 / 万能导入</p>
                  <h1>系统已切换到万能导入入口</h1>
                </div>
              </div>

              <div className="status-panel">
                <p className="status-text visible">
                  当前首页仅作为登录入口和跳转页，登录后会自动进入万能导入。
                </p>
                <p className="footnote">如果没有自动跳转，可以点击下方按钮进入。</p>
              </div>

              <div className="toolbar" style={{ marginTop: 24 }}>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => window.location.assign("/universal-import")}
                >
                  进入万能导入
                </button>
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
