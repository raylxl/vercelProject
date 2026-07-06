"use client";

import { useState } from "react";

type SessionResponse = {
  authenticated?: boolean;
  username?: string | null;
  error?: string;
};

export function FormalLoginClient() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("正式模式已开启，请登录后进入万能导入。");
  const [submitting, setSubmitting] = useState(false);

  async function submitSession(method: "POST" | "PUT") {
    setSubmitting(true);
    setStatus(method === "POST" ? "正在登录..." : "正在注册...");

    try {
      const response = await fetch("/api/session", {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });
      const data = (await response.json()) as SessionResponse;

      if (!response.ok || !data.authenticated) {
        throw new Error(data.error ?? "操作失败，请稍后重试。");
      }

      setStatus("登录成功，正在进入万能导入...");
      window.location.href = "/universal-import";
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "操作失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="formal-login-page">
      <section className="formal-login-card">
        <p className="section-kicker">正式模式</p>
        <h1>万能导入访问登录</h1>
        <p className="formal-login-copy">
          考试模式可直接访问；正式上线模式会保护万能导入页面和写接口，避免匿名修改规则或运单数据。
        </p>
        <label>
          账户名
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="admin" />
        </label>
        <label>
          密码
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="默认管理员密码 1234"
            type="password"
          />
        </label>
        <div className="toolbar">
          <button type="button" className="primary-button" disabled={submitting} onClick={() => submitSession("POST")}>
            登录
          </button>
          <button type="button" className="secondary-button" disabled={submitting} onClick={() => submitSession("PUT")}>
            注册普通账号
          </button>
        </div>
        <p className="status-line">{status}</p>
      </section>
    </main>
  );
}
