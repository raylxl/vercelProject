import {
  DEFAULT_PAGE_SIZE,
  OPERATION_LOG_TAKE,
} from "@/lib/fee-type-config";
import { getOperatorNameFromSession } from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { FeeTypeManager } from "./fee-type-manager";

export const dynamic = "force-dynamic";

async function getFeeTypePage() {
  try {
    const [feeTypes, total, operationLogs, operatorName] = await Promise.all([
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
      getOperatorNameFromSession(),
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
  const pageData = await getFeeTypePage();

  return (
    <FeeTypeManager
      initialRows={pageData?.feeTypes ?? []}
      initialOperationLogs={pageData?.operationLogs ?? []}
      initialOperatorName={pageData?.operatorName ?? "系统用户"}
      initialPagination={
        pageData?.pagination ?? {
          total: 0,
          page: 1,
          pageSize: DEFAULT_PAGE_SIZE,
          totalPages: 1,
        }
      }
      databaseReady={pageData !== null}
    />
  );
}
