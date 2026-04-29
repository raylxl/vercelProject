import { DEFAULT_PAGE_SIZE, OPERATION_LOG_TAKE } from "@/lib/fee-type-config";
import {
  getOperatorNameFromSession,
  isAuthenticated,
} from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { FeeTypeManager } from "./fee-type-manager";

export const dynamic = "force-dynamic";

async function getFeeTypePage(operatorName: string) {
  try {
    const [feeTypes, total, operationLogs] = await Promise.all([
      prisma.feeType.findMany({
        orderBy: {
          feeCode: "asc",
        },
        take: DEFAULT_PAGE_SIZE,
      }),
      prisma.feeType.count(),
      prisma.feeTypeOperationLog.findMany({
        orderBy: {
          createdAt: "desc",
        },
        take: OPERATION_LOG_TAKE,
      }),
    ]);

    return {
      feeTypes,
      operationLogs,
      operatorName,
      pagination: {
        total,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        totalPages: Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE)),
      },
    };
  } catch (error) {
    console.error("Failed to load fee types", error);
    return null;
  }
}

export default async function HomePage() {
  const authenticated = await isAuthenticated();
  const operatorName = authenticated ? await getOperatorNameFromSession() : "";
  const pageData = authenticated ? await getFeeTypePage(operatorName) : null;

  return (
    <FeeTypeManager
      isAuthenticated={authenticated}
      initialRows={pageData?.feeTypes ?? []}
      initialOperationLogs={pageData?.operationLogs ?? []}
      initialOperatorName={pageData?.operatorName ?? operatorName}
      initialPagination={
        pageData?.pagination ?? {
          total: 0,
          page: 1,
          pageSize: DEFAULT_PAGE_SIZE,
          totalPages: 1,
        }
      }
      databaseReady={authenticated ? pageData !== null : true}
    />
  );
}
