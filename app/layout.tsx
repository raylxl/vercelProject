import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "费用类型维护",
  description: "费用类型维护页面，支持查询、新增、编辑和批量删除。",
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
