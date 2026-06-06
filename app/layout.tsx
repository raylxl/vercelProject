import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "智能多格式批量下单系统",
  description: "智能多格式批量下单系统，支持万能导入V2、规则管理与历史运单查询。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
