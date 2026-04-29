import { DEFAULT_PAGE_SIZE } from "@/lib/fee-type-config";
import { prisma } from "@/lib/prisma";
import { FeeTypeManager } from "./fee-type-manager";

export const dynamic = "force-dynamic";

async function getFeeTypePage() {
  try {
    const [feeTypes, total] = await Promise.all([
      prisma.feeType.findMany({
        orderBy: {
          feeCode: "asc",
        },
        take: DEFAULT_PAGE_SIZE,
      }),
      prisma.feeType.count(),
    ]);

    return {
      feeTypes,
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
