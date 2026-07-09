import type { UniversalImportMapping, UniversalImportRow } from "@/lib/universal-import";
import type { UniversalImportRuleDsl } from "@/lib/universal-import-engine";

const SYNTHETIC_EXTERNAL_CODE_PREFIXES = ["SHEET-", "MATRIX-", "CARD-", "TXT-", "PLAN-"] as const;

export function isSyntheticExternalCode(value: string) {
  const normalized = value.trim().toUpperCase();
  return SYNTHETIC_EXTERNAL_CODE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function mergeRiskNotes(...groups: Array<string[] | undefined>) {
  return Array.from(
    new Set(
      groups
        .flatMap((group) => group ?? [])
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function collectUniversalImportRiskNotes(rows: UniversalImportRow[]) {
  if (rows.length === 0) {
    return [];
  }

  const notes: string[] = [];
  const syntheticRows = rows.filter((row) => isSyntheticExternalCode(row.externalCode));
  const syntheticCodes = Array.from(new Set(syntheticRows.map((row) => row.externalCode.trim()).filter(Boolean)));

  if (syntheticCodes.length > 0) {
    const examples = syntheticCodes.slice(0, 3).join("、");
    notes.push(
      `检测到 ${syntheticRows.length} 行使用系统兜底生成的外部编码（如 ${examples}），说明源文件中可能未提供真实外部编码/订单号/配送单号。考试要求里该字段可不填，但如需按真实单号去重聚合，建议补充源字段。`,
    );
  }

  const missingSkuSpecRows = rows.filter((row) => !row.skuSpec.trim());
  if (missingSkuSpecRows.length > 0) {
    const examples = missingSkuSpecRows
      .slice(0, 3)
      .map((row) => `${row.skuCode.trim() || "未识别编码"}/${row.skuName.trim() || "未识别名称"}`)
      .join("、");
    notes.push(
      `检测到 ${missingSkuSpecRows.length} 行未解析出 SKU规格型号，通常是源文件未提供规格列，或商品名称中也无法可靠推断。示例：${examples}。`,
    );
  }

  return notes;
}

export function collectRuleDesignRiskNotes(
  mapping: UniversalImportMapping,
  rule: UniversalImportRuleDsl,
) {
  const notes: string[] = [];
  const hasSyntheticExternalCodeTemplate = rule.transforms.some((transform) => {
    if (!transform.enabled) {
      return false;
    }

    const template = String(transform.config?.externalCodeTemplate ?? "").trim().toUpperCase();
    return SYNTHETIC_EXTERNAL_CODE_PREFIXES.some((prefix) => template.startsWith(prefix));
  });

  if (mapping.externalCode === null && hasSyntheticExternalCodeTemplate) {
    notes.push("当前规则未直接映射外部编码，试解析后很可能使用系统兜底生成的外部编码；如果源文件存在真实单号，建议补映射或补充尾部提取规则。");
  }

  if (mapping.skuSpec === null) {
    notes.push("当前规则未直接映射 SKU规格型号，后续可能依赖商品名称推断；若源文件本身没有规格列，部分行仍可能为空。");
  }

  return notes;
}
