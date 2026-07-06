import { redirect } from "next/navigation";
import { isAuthenticated, isExamModeEnabled } from "@/lib/operator-session";
import { FormalLoginClient } from "./formal-login-client";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (isExamModeEnabled()) {
    // 考试模式保留直达万能导入，避免登录流程影响阅卷。
    redirect("/universal-import");
  }

  if (await isAuthenticated()) {
    redirect("/universal-import");
  }

  return <FormalLoginClient />;
}
