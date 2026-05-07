export const UNIVERSAL_IMPORT_FIELDS = [
  { key: "externalCode", label: "外部编码", required: false, aliases: ["外部编码", "订单号", "单号", "externalcode", "code"] },
  { key: "senderName", label: "寄件人姓名", required: true, aliases: ["寄件人姓名", "发件人姓名", "寄件人", "发件人", "sender", "shipper"] },
  { key: "senderPhone", label: "寄件人电话", required: true, aliases: ["寄件人电话", "发件人电话", "寄件人手机", "发件人手机", "senderphone", "shipperphone", "手机号"] },
  { key: "senderAddress", label: "寄件人地址", required: true, aliases: ["寄件人地址", "发件人地址", "发件地", "senderaddress", "shipperaddress", "地址"] },
  { key: "receiverName", label: "收件人姓名", required: true, aliases: ["收件人姓名", "收货人姓名", "收方姓名", "收件人", "收货人", "收方", "receiver", "recipient"] },
  { key: "receiverPhone", label: "收件人电话", required: true, aliases: ["收件人电话", "收货人电话", "收方电话", "receiverphone", "recipientphone"] },
  { key: "receiverAddress", label: "收件人地址", required: true, aliases: ["收件人地址", "收货人地址", "收方地址", "receiveraddress", "recipientaddress"] },
  { key: "weight", label: "重量 (kg)", required: true, aliases: ["重量", "重量kg", "weight", "kg"] },
  { key: "pieces", label: "件数", required: true, aliases: ["件数", "包装数", "数量", "pcs", "pieces"] },
  { key: "temperature", label: "温层", required: true, aliases: ["温层", "温度层", "常温", "冷藏", "冷冻", "temperature"] },
  { key: "note", label: "备注", required: false, aliases: ["备注", "说明", "附加说明", "note"] },
] as const;

export type UniversalImportField = (typeof UNIVERSAL_IMPORT_FIELDS)[number]["key"];

export const UNIVERSAL_IMPORT_TEMPERATURES = ["常温", "冷藏", "冷冻"] as const;

export type UniversalImportRow = Record<UniversalImportField, string> & {
  rowIndex: number;
};

export type UniversalImportIssue = {
  rowIndex: number;
  field: UniversalImportField;
  message: string;
};

export type UniversalImportMapping = Record<UniversalImportField, number | null>;

export type ExistingExternalCodeEntry = {
  externalCode: string;
  rowIndex?: number;
  batchName?: string;
  batchCreatedAt?: string;
};

export const UNIVERSAL_IMPORT_FIELD_LABELS = Object.fromEntries(
  UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, field.label]),
) as Record<UniversalImportField, string>;

const REQUIRED_FIELDS = new Set<UniversalImportField>(
  UNIVERSAL_IMPORT_FIELDS.filter((field) => field.required).map((field) => field.key),
);

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[()（）【】\[\]{}<>《》,，.。!?！？:：;；·、/\\|]/g, "");
}

function normalizeDisplayValue(value: unknown) {
  return String(value ?? "").trim();
}

export function buildTemplateFingerprint(sheetName: string, headerRow: unknown[]) {
  const headers = headerRow.map((value) => normalizeText(value));
  return `${normalizeText(sheetName)}::${headers.join("|")}`;
}

export function detectHeaderRow(rows: unknown[][]) {
  const sampleRows = rows.slice(0, 12);

  let best = {
    rowIndex: 0,
    headers: sampleRows[0]?.map((value) => normalizeDisplayValue(value)) ?? [],
    mapping: {} as UniversalImportMapping,
    score: -1,
  };

  sampleRows.forEach((row, index) => {
    const headers = row.map((value) => normalizeDisplayValue(value));
    const mapping = inferMappingFromHeaders(headers);
    const score = Object.values(mapping).filter((value) => typeof value === "number").length;

    if (score > best.score) {
      best = {
        rowIndex: index,
        headers,
        mapping,
        score,
      };
    }
  });

  return {
    rowIndex: best.rowIndex,
    headers: best.headers,
    mapping: best.mapping,
  };
}

export function inferMappingFromHeaders(headers: unknown[]): UniversalImportMapping {
  const normalizedHeaders = headers.map((header) => normalizeText(header));
  const mapping = Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, null]),
  ) as UniversalImportMapping;
  const usedColumns = new Set<number>();

  const fieldScores = UNIVERSAL_IMPORT_FIELDS.map((field) => {
    const candidateScores = normalizedHeaders.map((header, columnIndex) => {
      if (!header) {
        return { columnIndex, score: 0 };
      }

      const aliases = field.aliases.map((alias) => normalizeText(alias));
      const score = aliases.reduce((currentScore, alias) => {
        if (!alias) {
          return currentScore;
        }

        if (header === alias) {
          return Math.max(currentScore, 100);
        }

        if (header.includes(alias) || alias.includes(header)) {
          return Math.max(currentScore, 80 - Math.abs(header.length - alias.length));
        }

        return currentScore;
      }, 0);

      return { columnIndex, score };
    });

    const bestScore = candidateScores.reduce(
      (currentBest, candidate) => (candidate.score > currentBest.score ? candidate : currentBest),
      { columnIndex: -1, score: 0 },
    );

    return {
      field: field.key,
      bestScore,
      candidateScores,
    };
  });

  fieldScores
    .sort((left, right) => right.bestScore.score - left.bestScore.score)
    .forEach(({ field, candidateScores, bestScore }) => {
      if (bestScore.score <= 0) {
        return;
      }

      const chosen = candidateScores
        .filter((candidate) => !usedColumns.has(candidate.columnIndex))
        .sort((left, right) => right.score - left.score)[0];

      if (!chosen || chosen.score <= 0) {
        return;
      }

      mapping[field] = chosen.columnIndex;
      usedColumns.add(chosen.columnIndex);
    });

  return mapping;
}

export function remapRows(
  sourceRows: unknown[][],
  headers: unknown[],
  mapping: UniversalImportMapping,
): UniversalImportRow[] {
  return sourceRows.map((row, index) => {
    const record = Object.fromEntries(
      UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, ""]),
    ) as Record<UniversalImportField, string>;

    UNIVERSAL_IMPORT_FIELDS.forEach((field) => {
      const columnIndex = mapping[field.key];

      if (typeof columnIndex === "number") {
        record[field.key] = normalizeDisplayValue(row[columnIndex]);
      }
    });

    return {
      ...record,
      rowIndex: index + 1,
    };
  });
}

export function createEmptyRow(rowIndex: number): UniversalImportRow {
  return {
    externalCode: "",
    senderName: "",
    senderPhone: "",
    senderAddress: "",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
    weight: "",
    pieces: "",
    temperature: "",
    note: "",
    rowIndex,
  };
}

function isPhoneLike(value: string) {
  const normalized = value.replace(/\s+/g, "");
  return /^(?:1\d{10}|(?:0\d{2,3}-?)?\d{7,8})$/.test(normalized);
}

function isPositiveNumber(value: string) {
  return /^(\d+)(\.\d+)?$/.test(value) && Number(value) > 0;
}

function isPositiveInteger(value: string) {
  return /^[1-9]\d*$/.test(value);
}

function normalizeExternalCode(value: string) {
  return value.trim().toLowerCase();
}

function getDuplicateSourceLabel(entry: ExistingExternalCodeEntry) {
  if (entry.rowIndex) {
    return entry.batchName ? `历史批次“${entry.batchName}”第 ${entry.rowIndex} 行` : `历史第 ${entry.rowIndex} 行`;
  }

  if (entry.batchName) {
    return `历史批次“${entry.batchName}”`;
  }

  return "历史数据";
}

function normalizeExistingExternalCodes(
  existingExternalCodes:
    | Set<string>
    | Map<string, ExistingExternalCodeEntry>
    | ExistingExternalCodeEntry[],
) {
  if (existingExternalCodes instanceof Set) {
    return new Map(
      Array.from(existingExternalCodes, (value) => [normalizeExternalCode(value), { externalCode: value }]),
    );
  }

  if (existingExternalCodes instanceof Map) {
    return new Map(
      Array.from(existingExternalCodes.entries(), ([key, value]) => [normalizeExternalCode(key), value]),
    );
  }

  return new Map(
    existingExternalCodes.map((entry) => [normalizeExternalCode(entry.externalCode), entry]),
  );
}

export function validateImportRows(
  rows: UniversalImportRow[],
  existingExternalCodes: Set<string> | Map<string, ExistingExternalCodeEntry> | ExistingExternalCodeEntry[] = new Set(),
) {
  const issues: UniversalImportIssue[] = [];
  const firstExternalCodeRow = new Map<string, number>();
  const existingLookup = normalizeExistingExternalCodes(existingExternalCodes);

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const externalCode = row.externalCode.trim();

    if (externalCode) {
      const normalized = normalizeExternalCode(externalCode);
      const existingRow = firstExternalCodeRow.get(normalized);

      if (existingRow) {
        issues.push({
          rowIndex: rowNumber,
          field: "externalCode",
          message: `与第 ${existingRow} 行重复`,
        });
      } else {
        const existing = existingLookup.get(normalized);

        if (existing) {
          issues.push({
            rowIndex: rowNumber,
            field: "externalCode",
            message: `与${getDuplicateSourceLabel(existing)}重复`,
          });
        } else {
          firstExternalCodeRow.set(normalized, rowNumber);
        }
      }
    }

    if (!row.senderName.trim()) {
      issues.push({ rowIndex: rowNumber, field: "senderName", message: "必填项缺失" });
    }

    if (!row.senderPhone.trim()) {
      issues.push({ rowIndex: rowNumber, field: "senderPhone", message: "必填项缺失" });
    } else if (!isPhoneLike(row.senderPhone.trim())) {
      issues.push({ rowIndex: rowNumber, field: "senderPhone", message: "格式错误" });
    }

    if (!row.senderAddress.trim()) {
      issues.push({ rowIndex: rowNumber, field: "senderAddress", message: "必填项缺失" });
    }

    if (!row.receiverName.trim()) {
      issues.push({ rowIndex: rowNumber, field: "receiverName", message: "必填项缺失" });
    }

    if (!row.receiverPhone.trim()) {
      issues.push({ rowIndex: rowNumber, field: "receiverPhone", message: "必填项缺失" });
    } else if (!isPhoneLike(row.receiverPhone.trim())) {
      issues.push({ rowIndex: rowNumber, field: "receiverPhone", message: "格式错误" });
    }

    if (!row.receiverAddress.trim()) {
      issues.push({ rowIndex: rowNumber, field: "receiverAddress", message: "必填项缺失" });
    }

    if (!row.weight.trim()) {
      issues.push({ rowIndex: rowNumber, field: "weight", message: "必填项缺失" });
    } else if (!isPositiveNumber(row.weight.trim())) {
      issues.push({ rowIndex: rowNumber, field: "weight", message: "必须为正数" });
    }

    if (!row.pieces.trim()) {
      issues.push({ rowIndex: rowNumber, field: "pieces", message: "必填项缺失" });
    } else if (!isPositiveInteger(row.pieces.trim())) {
      issues.push({ rowIndex: rowNumber, field: "pieces", message: "必须为正整数" });
    }

    if (!row.temperature.trim()) {
      issues.push({ rowIndex: rowNumber, field: "temperature", message: "必填项缺失" });
    } else if (
      !UNIVERSAL_IMPORT_TEMPERATURES.includes(
        row.temperature.trim() as (typeof UNIVERSAL_IMPORT_TEMPERATURES)[number],
      )
    ) {
      issues.push({ rowIndex: rowNumber, field: "temperature", message: "值不在范围内" });
    }
  });

  const issuesByRow = new Map<number, UniversalImportIssue[]>();

  issues.forEach((issue) => {
    const list = issuesByRow.get(issue.rowIndex) ?? [];
    list.push(issue);
    issuesByRow.set(issue.rowIndex, list);
  });

  return {
    issues,
    issuesByRow,
  };
}

export function formatIssueLabel(issue: UniversalImportIssue) {
  return `第${issue.rowIndex}行，${UNIVERSAL_IMPORT_FIELD_LABELS[issue.field]}：${issue.message}`;
}

export function toSafeSheetName(name: string) {
  return normalizeDisplayValue(name).slice(0, 30) || "Sheet1";
}
