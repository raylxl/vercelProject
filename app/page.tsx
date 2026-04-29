import { prisma } from "@/lib/prisma";
import { FeeTypeManager } from "./fee-type-manager";

export const dynamic = "force-dynamic";

async function getFeeTypes() {
  try {
    return await prisma.feeType.findMany({
      orderBy: {
        feeCode: "asc",
      },
    });
  } catch (error) {
    console.error("Failed to load fee types", error);
    return null;
  }
}

export default async function HomePage() {
  const feeTypes = await getFeeTypes();

  return <FeeTypeManager initialRows={feeTypes ?? []} databaseReady={feeTypes !== null} />;
}
