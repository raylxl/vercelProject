import type { Metadata } from "next";
import { getOperatorNameFromSession } from "@/lib/operator-session";
import { UniversalImportClient } from "./universal-import-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "智能多格式批量下单系统",
  description: "智能多格式批量下单系统，支持万能导入V2、规则管理与历史运单查询。",
};

type UniversalImportPageProps = {
  searchParams?: Promise<{
    tab?: string;
  }>;
};

export default async function UniversalImportPage({ searchParams }: UniversalImportPageProps) {
  // 考试专用模式：本次考核不包含登录模块，访问系统即进入万能导入 V2。
  const operatorName = await getOperatorNameFromSession();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const initialTab =
    resolvedSearchParams?.tab === "history" || resolvedSearchParams?.tab === "rules"
      ? resolvedSearchParams.tab
      : "import";

  return <UniversalImportClient operatorName={operatorName} initialTab={initialTab} />;
}
