import type { Metadata } from "next";
import { getOperatorNameFromSession, isAuthenticated } from "@/lib/operator-session";
import { redirect } from "next/navigation";
import { UniversalImportClient } from "./universal-import-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "万能导入",
  description: "万能导入下单系统",
};

export default async function UniversalImportPage() {
  const authenticated = await isAuthenticated();

  if (!authenticated) {
    redirect("/");
  }

  const operatorName = await getOperatorNameFromSession();

  return <UniversalImportClient operatorName={operatorName} />;
}
