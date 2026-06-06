import * as XLSX from "xlsx";
import mammoth from "mammoth";
import * as pdfParseModule from "pdf-parse";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createEmptyRow,
  formatIssueLabel,
  type UniversalImportMapping,
  type UniversalImportRow,
  validateImportRows,
} from "@/lib/universal-import";

export type SupportedImportFileType = "excel" | "word" | "pdf";

export type ParsedDocument = {
  fileType: SupportedImportFileType;
  sheetName: string;
  headers: string[];
  rawRows: string[][];
  textContent: string;
  sections: Array<{
    title: string;
    rows: string[][];
    text: string;
  }>;
};

export type RuleTransformType =
  | "header_mapping"
  | "multisheet_merge"
  | "group_by_external_code"
  | "matrix_pivot"
  | "split_multiline_cell"
  | "tail_text_extract"
  | "card_split"
  | "text_record_split";

export type UniversalImportRuleDsl = {
  fileType: SupportedImportFileType;
  mode: "mapping" | "text" | "structured";
  transforms: Array<{
    type: RuleTransformType;
    enabled: boolean;
    config?: Record<string, string | number | boolean | string[]>;
  }>;
  mapping: UniversalImportMapping;
};

export type RuleExecutionResult = {
  document: ParsedDocument;
  previewRows: UniversalImportRow[];
  issues: string[];
  issueCount: number;
  rowCount: number;
  summary: string[];
};

type DetectedScenario =
  | "haikou_delivery"
  | "hunan_summary"
  | "multi_sheet_store"
  | "store_matrix"
  | "card_transfer"
  | "pdf_delivery"
  | "generic_table"
  | "generic_text";

type PdfParseTextResult = {
  text?: string;
};

type PdfParseClass = new (options: { data: Buffer }) => {
  getText: () => Promise<PdfParseTextResult>;
  destroy?: () => Promise<void> | void;
};

const HEADER_KEYWORDS = [
  "序号",
  "物品编码",
  "物品名称",
  "规格型号",
  "发货数量",
  "出库数量",
  "收货机构",
  "配送汇总单号",
  "配送单号",
  "SKU名称",
  "SKU条码",
  "外部商品编码",
  "仓库名称",
];

function normalizeCell(value: unknown) {
  return String(value ?? "").trim();
}

function isNonEmptyRow(row: unknown[]) {
  return row.some((cell) => normalizeCell(cell) !== "");
}

function splitLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeRows(rows: unknown[][]) {
  return rows.filter(isNonEmptyRow).map((row) => row.map((cell) => normalizeCell(cell)));
}

function ensureUniqueExternalCode(prefix: string, index: number) {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBestHeaderRow(rows: string[][]) {
  let bestIndex = -1;
  let bestScore = -1;

  rows.forEach((row, index) => {
    const score = row.reduce((total, cell) => {
      if (!cell) {
        return total;
      }

      return total + (HEADER_KEYWORDS.some((keyword) => cell.includes(keyword)) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  if (bestScore > 0 && bestIndex >= 0) {
    return bestIndex;
  }

  return rows.findIndex((row) => row.length >= 3);
}

function findHeaderIndex(rows: string[][], matcher: (row: string[]) => boolean) {
  return rows.findIndex((row) => matcher(row));
}

function findColumnIndex(header: string[], patterns: RegExp[]) {
  return header.findIndex((cell) => patterns.some((pattern) => pattern.test(cell)));
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.find((value) => normalizeCell(value)) ?? "";
}

function findValueAfterLabel(rows: string[][], label: string) {
  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      if (normalizeCell(row[index]) === label) {
        const nextValue = normalizeCell(row[index + 1]);
        if (nextValue) {
          return nextValue;
        }
      }
    }
  }

  return "";
}

function extractValueFromText(text: string, label: string, stopLabels: string[] = []) {
  const escapedLabel = escapeRegExp(label);
  const stopPattern = stopLabels.length
    ? `(?=\\s*(?:${stopLabels.map((item) => escapeRegExp(item)).join("|")})\\s*[：:])`
    : "(?=$)";
  const pattern = new RegExp(`${escapedLabel}\\s*[：:]?\\s*([\\s\\S]*?)${stopPattern}`, "m");
  const match = text.match(pattern);
  return match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

function extractCodeByTitle(title: string, keyword: string) {
  const match = title.match(new RegExp(`${escapeRegExp(keyword)}([A-Z0-9-]+)`));
  return match?.[1]?.trim() ?? "";
}

function cleanStoreName(value: string) {
  return value.replace(/出库单$/, "").trim();
}

function isPositiveQuantity(value: string) {
  return /^\d+$/.test(value.trim()) && Number(value) > 0;
}

function toCompactCodePart(value: string) {
  return value.replace(/[^\dA-Za-z]+/g, "").slice(0, 20) || "AUTO";
}

function toExternalCodePart(value: string) {
  return value.replace(/\s+/g, "").replace(/[\\/:*?"<>|]+/g, "").slice(0, 40) || "AUTO";
}

async function parseExcelDocument(fileBuffer: Buffer, originalFileName: string): Promise<ParsedDocument> {
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  const sections: ParsedDocument["sections"] = [];

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return;
    }

    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    }) as unknown[][];
    const rows = normalizeRows(matrix);

    sections.push({
      title: sheetName,
      rows,
      text: rows.map((row) => row.join(" | ")).join("\n"),
    });
  });

  const firstSection = sections[0];
  const headerIndex = firstSection ? findBestHeaderRow(firstSection.rows) : -1;
  const headers = headerIndex >= 0 ? firstSection?.rows[headerIndex] ?? [] : [];

  return {
    fileType: "excel",
    sheetName: workbook.SheetNames[0] ?? originalFileName ?? "Sheet1",
    headers,
    rawRows: headerIndex >= 0 ? firstSection?.rows.slice(headerIndex + 1) ?? [] : firstSection?.rows ?? [],
    textContent: sections.map((section) => section.text).join("\n\n"),
    sections,
  };
}

async function parseWordDocument(fileBuffer: Buffer, originalFileName: string): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ buffer: fileBuffer });
  const text = result.value ?? "";
  const rows = splitLines(text).map((line) => line.split(/[|\t]/).map((cell) => cell.trim()).filter(Boolean));
  const headers = rows[0] ?? [];

  return {
    fileType: "word",
    sheetName: originalFileName || "Word Document",
    headers,
    rawRows: rows.slice(1),
    textContent: text,
    sections: [
      {
        title: "document",
        rows,
        text,
      },
    ],
  };
}

async function parsePdfDocument(fileBuffer: Buffer, originalFileName: string): Promise<ParsedDocument> {
  const moduleWithCtor = pdfParseModule as unknown as { PDFParse?: PdfParseClass };
  const moduleWithDefault = pdfParseModule as unknown as {
    default?: (buffer: Buffer) => Promise<PdfParseTextResult>;
  };

  let text = "";

  if (moduleWithCtor.PDFParse) {
    if (typeof (moduleWithCtor.PDFParse as PdfParseClass & { setWorker?: (value: string) => void }).setWorker === "function") {
      const workerPath = path.resolve(process.cwd(), "node_modules", "pdf-parse", "dist", "pdf-parse", "cjs", "pdf.worker.mjs");
      (moduleWithCtor.PDFParse as PdfParseClass & { setWorker?: (value: string) => void }).setWorker?.(
        pathToFileURL(workerPath).href,
      );
    }

    const parser = new moduleWithCtor.PDFParse({ data: fileBuffer });

    try {
      const result = await parser.getText();
      text = result.text ?? "";
    } finally {
      await parser.destroy?.();
    }
  } else if (typeof moduleWithDefault.default === "function") {
    const result = await moduleWithDefault.default(fileBuffer);
    text = result.text ?? "";
  } else {
    throw new Error("Unsupported pdf-parse module shape");
  }

  const lines = splitLines(text);
  const rows = lines.map((line) => line.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean));

  return {
    fileType: "pdf",
    sheetName: originalFileName || "PDF Document",
    headers: [],
    rawRows: [],
    textContent: text,
    sections: [
      {
        title: "pdf",
        rows,
        text,
      },
    ],
  };
}

export async function parseImportDocument(options: {
  fileBuffer: Buffer;
  fileType: SupportedImportFileType;
  originalFileName: string;
}) {
  if (options.fileType === "word") {
    return parseWordDocument(options.fileBuffer, options.originalFileName);
  }

  if (options.fileType === "pdf") {
    return parsePdfDocument(options.fileBuffer, options.originalFileName);
  }

  return parseExcelDocument(options.fileBuffer, options.originalFileName);
}

function detectScenario(document: ParsedDocument): DetectedScenario {
  const fullText = document.textContent;
  const firstSection = document.sections[0];
  const firstRow = firstSection?.rows[0]?.join(" ") ?? "";
  const secondRow = firstSection?.rows[1]?.join(" ") ?? "";
  const sheetCount = document.sections.length;

  if (document.fileType === "pdf") {
    return "pdf_delivery";
  }

  if (document.fileType === "word") {
    return "generic_text";
  }

  if (
    sheetCount > 1 &&
    document.sections.every((section) =>
      section.rows.some((row) => row.includes("物品编码") && row.includes("物品名称") && row.includes("出库数量")),
    )
  ) {
    return "multi_sheet_store";
  }

  if (/门店调拨单/.test(firstRow) || fullText.includes("调拨记录 #")) {
    return "card_transfer";
  }

  if (
    firstSection?.rows.some(
      (row) => row.includes("仓库名称") && row.includes("SKU名称") && row.includes("外部商品编码"),
    )
  ) {
    return "store_matrix";
  }

  if (firstSection?.rows.some((row) => row.includes("配送汇总单号*") && row.includes("收货机构"))) {
    return "hunan_summary";
  }

  if (/配送发货单/.test(firstRow) && /收货机构/.test(secondRow)) {
    return "haikou_delivery";
  }

  if (
    document.sections.some((section) =>
      section.rows.some((row) => row.includes("物品编码") || row.includes("外部商品编码") || row.includes("SKU条码")),
    )
  ) {
    return "generic_table";
  }

  return "generic_text";
}

function rowFromValues(values: Partial<UniversalImportRow>, rowIndex: number): UniversalImportRow {
  return {
    ...createEmptyRow(rowIndex),
    ...values,
    rowIndex,
  };
}

function parseHaikouDelivery(document: ParsedDocument) {
  const rows = document.sections[0]?.rows ?? [];
  const headerIndex = findHeaderIndex(rows, (row) => row.includes("物品编码") && row.includes("物品名称") && row.includes("发货数量"));
  if (headerIndex < 0) {
    return [];
  }

  const header = rows[headerIndex];
  const codeIndex = findColumnIndex(header, [/物品编码/]);
  const nameIndex = findColumnIndex(header, [/物品名称/]);
  const specIndex = findColumnIndex(header, [/规格型号/]);
  const quantityIndex = findColumnIndex(header, [/发货数量/]);
  const dataRows = rows
    .slice(headerIndex + 1)
    .filter((row) => /^\d+$/.test(row[0] ?? "") && isPositiveQuantity(row[quantityIndex] ?? ""));

  const title = rows[0]?.[0] ?? "";
  const externalCode =
    firstNonEmpty(
      findValueAfterLabel(rows, "单据号"),
      extractCodeByTitle(title, "配送发货单"),
      ensureUniqueExternalCode("HK", 0),
    );
  const receiverStore = findValueAfterLabel(rows, "收货机构");
  const receiverName = findValueAfterLabel(rows, "收货人");
  const receiverPhone = findValueAfterLabel(rows, "收货电话");
  const receiverAddress = findValueAfterLabel(rows, "收货地址");

  return dataRows.map((row, index) =>
    rowFromValues(
      {
        externalCode,
        receiverStore,
        receiverName,
        receiverPhone,
        receiverAddress,
        skuCode: row[codeIndex] ?? "",
        skuName: row[nameIndex] ?? "",
        skuSpec: specIndex >= 0 ? row[specIndex] ?? "" : "",
        skuQuantity: quantityIndex >= 0 ? row[quantityIndex] ?? "" : "",
      },
      index + 1,
    ),
  );
}

function parseHunanSummary(document: ParsedDocument) {
  const rows = document.sections[0]?.rows ?? [];
  const headerIndex = findHeaderIndex(rows, (row) => row.includes("配送汇总单号*") && row.includes("物品编码*"));
  if (headerIndex < 0) {
    return [];
  }

  const header = rows[headerIndex];
  const storeIndex = findColumnIndex(header, [/收货机构/]);
  const summaryCodeIndex = findColumnIndex(header, [/配送汇总单号/]);
  const deliveryCodeIndex = findColumnIndex(header, [/配送单号/]);
  const codeIndex = findColumnIndex(header, [/物品编码/]);
  const nameIndex = findColumnIndex(header, [/物品名称/]);
  const specIndex = findColumnIndex(header, [/规格型号/]);
  const quantityIndex = findColumnIndex(header, [/发货数量/]);
  const receiverNameIndex = findColumnIndex(header, [/收货人/]);
  const receiverPhoneIndex = findColumnIndex(header, [/收货电话/]);
  const receiverAddressIndex = findColumnIndex(header, [/收货地址/]);

  return rows
    .slice(headerIndex + 1)
    .filter((row) => {
      const skuCode = row[codeIndex] ?? "";
      const skuName = row[nameIndex] ?? "";
      const quantity = row[quantityIndex] ?? "";
      return Boolean(skuCode && skuName && isPositiveQuantity(quantity));
    })
    .map((row, index) =>
      rowFromValues(
        {
          externalCode:
            firstNonEmpty(row[summaryCodeIndex], row[deliveryCodeIndex], ensureUniqueExternalCode("HN", index)),
          receiverStore: row[storeIndex] ?? "",
          receiverName: receiverNameIndex >= 0 ? row[receiverNameIndex] ?? "" : "",
          receiverPhone: receiverPhoneIndex >= 0 ? row[receiverPhoneIndex] ?? "" : "",
          receiverAddress: receiverAddressIndex >= 0 ? row[receiverAddressIndex] ?? "" : "",
          skuCode: row[codeIndex] ?? "",
          skuName: row[nameIndex] ?? "",
          skuSpec: specIndex >= 0 ? row[specIndex] ?? "" : "",
          skuQuantity: row[quantityIndex] ?? "",
          note: deliveryCodeIndex >= 0 ? row[deliveryCodeIndex] ?? "" : "",
        },
        index + 1,
      ),
    );
}

function parseMultiSheetStore(document: ParsedDocument) {
  const output: UniversalImportRow[] = [];

  document.sections.forEach((section, sectionIndex) => {
    const title = section.rows[0]?.[0] ?? section.title;
    const metadata = section.rows[1]?.join(" ") ?? "";
    const storeName = cleanStoreName(title);
    const dateMatch = metadata.match(/出库日期[:：]\s*([\d/-]+)/);
    const externalCode = `MS-${dateMatch?.[1]?.replace(/[^\d]/g, "") || sectionIndex + 1}-${toExternalCodePart(storeName)}`;
    const headerIndex = findHeaderIndex(
      section.rows,
      (row) => row.includes("物品编码") && row.includes("物品名称") && row.includes("出库数量"),
    );

    if (headerIndex < 0) {
      return;
    }

    const header = section.rows[headerIndex];
    const codeIndex = findColumnIndex(header, [/物品编码/]);
    const nameIndex = findColumnIndex(header, [/物品名称/]);
    const specIndex = findColumnIndex(header, [/规格型号/]);
    const quantityIndex = findColumnIndex(header, [/出库数量|发货数量/]);
    const noteIndex = findColumnIndex(header, [/备注/]);

    section.rows
      .slice(headerIndex + 1)
      .filter((row) => /^\d+$/.test(row[0] ?? "") && row[codeIndex] && row[nameIndex] && isPositiveQuantity(row[quantityIndex] ?? ""))
      .forEach((row) => {
        output.push(
          rowFromValues(
            {
              externalCode,
              receiverStore: storeName,
              skuCode: row[codeIndex] ?? "",
              skuName: row[nameIndex] ?? "",
              skuSpec: specIndex >= 0 ? row[specIndex] ?? "" : "",
              skuQuantity: row[quantityIndex] ?? "",
              note: noteIndex >= 0 ? row[noteIndex] ?? "" : "",
            },
            output.length + 1,
          ),
        );
      });
  });

  return output;
}

function parseStoreMatrix(document: ParsedDocument) {
  const rows = document.sections[0]?.rows ?? [];
  const headerRow = rows.find((row) => row.includes("仓库名称") && row.includes("SKU名称") && row.includes("外部商品编码")) ?? [];
  if (headerRow.length === 0) {
    return [];
  }

  const storeColumns = headerRow
    .map((cell, index) => ({ cell, index }))
    .filter(
      ({ cell, index }) =>
        index >= 13 &&
        Boolean(cell) &&
        !/总和|结余|库存|冻结|分配|待移入/.test(String(cell)),
    );
  const dataRows = rows.slice(rows.indexOf(headerRow) + 1).filter((row) => row[4] && row[2]);
  const output: UniversalImportRow[] = [];

  dataRows.forEach((row) => {
    storeColumns.forEach(({ cell, index }) => {
      const quantity = normalizeCell(row[index]);
      if (!isPositiveQuantity(quantity)) {
        return;
      }

      output.push(
        rowFromValues(
          {
            externalCode: `MATRIX-${toExternalCodePart(String(cell))}`,
            receiverStore: String(cell),
            skuCode: row[4] ?? "",
            skuName: row[2] ?? "",
            skuSpec: row[7] ?? "",
            skuQuantity: quantity,
          },
          output.length + 1,
        ),
      );
    });
  });

  return output;
}

function parseCardTransfer(document: ParsedDocument) {
  const rows = document.sections[0]?.rows ?? [];
  const output: UniversalImportRow[] = [];
  let currentExternalCode = "";
  let receiverStore = "";
  let receiverName = "";
  let receiverPhone = "";
  let receiverAddress = "";
  let cardIndex = 0;
  let inItems = false;

  rows.forEach((row) => {
    const firstCell = row[0] ?? "";

    if (/调拨记录\s*#\d+/.test(firstCell)) {
      cardIndex += 1;
      currentExternalCode = ensureUniqueExternalCode("DB", cardIndex - 1);
      inItems = false;
      return;
    }

    if (firstCell === "调入门店") {
      receiverStore = row[1] ?? "";
      receiverName = row[3] ?? "";
      receiverPhone = row[5] ?? "";
      return;
    }

    if (firstCell === "收货地址") {
      receiverAddress = row[1] ?? "";
      return;
    }

    if (firstCell === "物品编码") {
      inItems = true;
      return;
    }

    if (inItems && row[0] && row[1] && isPositiveQuantity(row[3] ?? "")) {
      output.push(
        rowFromValues(
          {
            externalCode: currentExternalCode,
            receiverStore,
            receiverName,
            receiverPhone,
            receiverAddress,
            skuCode: row[0] ?? "",
            skuName: row[1] ?? "",
            skuSpec: row[2] ?? "",
            skuQuantity: row[3] ?? "",
          },
          output.length + 1,
        ),
      );
    }
  });

  return output;
}

function parsePdfItems(text: string) {
  const output: Array<{ skuCode: string; skuName: string; skuSpec: string; skuQuantity: string }> = [];
  const lines = splitLines(text);
  const itemBlocks: string[] = [];
  let currentBlock = "";

  const flushBlock = () => {
    if (currentBlock) {
      itemBlocks.push(currentBlock.replace(/\s+/g, " ").trim());
      currentBlock = "";
    }
  };

  lines.forEach((line) => {
    if (/^第\d+页/.test(line) || /^--\s*\d+\s+of\s+\d+\s*--$/.test(line)) {
      return;
    }

    if (/^物品类别\s+物品编码\s+物品名称/.test(line)) {
      return;
    }

    if (/^\d+\s+/.test(line) && /ZBWP[\w-]+/.test(line)) {
      flushBlock();
      currentBlock = line;
      return;
    }

    if (currentBlock) {
      currentBlock += ` ${line}`;
    }
  });

  flushBlock();

  itemBlocks.forEach((block) => {
    const normalized = block.replace(/\s+/g, " ").trim();
    const baseMatch = normalized.match(/^\d+\s+\S+\s+(ZBWP[\w-]+)\s+(.+)\s+(\d+)$/);
    if (!baseMatch) {
      return;
    }

    const skuCode = baseMatch[1] ?? "";
    const quantity = baseMatch[3] ?? "";
    const middle = (baseMatch[2] ?? "").trim();
    const tokens = middle.split(/\s+/).filter(Boolean);

    if (tokens.length === 0) {
      return;
    }

    let unit = "";
    let spec = "";
    const possibleUnit = tokens[tokens.length - 1] ?? "";

    if (/^(件|包|瓶|桶|盒|袋|箱|个|份|条|支|套|罐|L|KG|kg|码|XL|2XL|3XL|4XL)$/i.test(possibleUnit)) {
      unit = tokens.pop() ?? "";
    }

    const possibleSpec = tokens[tokens.length - 1] ?? "";
    if (/[0-9*×xX/.]|kg|KG|ml|ML|L|码|斤|包|盒|桶|袋|件/.test(possibleSpec)) {
      spec = tokens.pop() ?? "";
    }

    const skuName = tokens.join(" ").trim();
    if (!skuName) {
      return;
    }

    output.push({
      skuCode,
      skuName,
      skuSpec: spec || unit,
      skuQuantity: quantity,
    });
  });

  return output;
}

function parsePdfDelivery(document: ParsedDocument) {
  const text = document.textContent;
  const compactText = text.replace(/[ \t]+/g, " ");
  const externalCode =
    firstNonEmpty(
      extractValueFromText(compactText, "单据编号", ["单据状态"]),
      ensureUniqueExternalCode("PDF", 0),
    );
  const receiverStore = extractValueFromText(compactText, "收货机构", ["订货机构"]);
  const receiverName =
    text.match(/收货人[:：]\s*([^\t\n\r]+)/)?.[1]?.trim() ??
    extractValueFromText(compactText, "收货人", ["收货电话", "联系电话"]);
  const receiverPhone =
    text.match(/收货电话[:：]\s*(1\d{10}|0\d{2,3}-?\d{7,8})/)?.[1]?.trim() ??
    extractValueFromText(compactText, "收货电话", ["收货地址", "地址"]);
  const receiverAddress =
    text.match(/收货地址[:：]\s*([^\n\r]+)/)?.[1]?.trim() ??
    extractValueFromText(compactText, "收货地址", ["备用联系人", "物品类别", "第1页", "第2页", "打印次数"]);
  const items = parsePdfItems(text);

  return items.map((item, index) =>
    rowFromValues(
      {
        externalCode,
        receiverStore,
        receiverName,
        receiverPhone,
        receiverAddress,
        skuCode: item.skuCode,
        skuName: item.skuName,
        skuSpec: item.skuSpec,
        skuQuantity: item.skuQuantity,
      },
      index + 1,
    ),
  );
}

function parseGenericTable(document: ParsedDocument) {
  const rows = document.sections[0]?.rows ?? [];
  const headerIndex = rows.findIndex((row) => row.includes("物品编码") || row.includes("外部商品编码") || row.includes("SKU条码"));
  if (headerIndex < 0) {
    return [];
  }

  const header = rows[headerIndex];
  const codeIndex = findColumnIndex(header, [/物品编码|外部商品编码|SKU条码|SKU编码/i]);
  const nameIndex = findColumnIndex(header, [/物品名称|SKU名称/]);
  const specIndex = findColumnIndex(header, [/规格/]);
  const quantityIndex = findColumnIndex(header, [/发货数量|出库数量|数量/]);
  const storeIndex = findColumnIndex(header, [/收货机构|门店/]);

  return rows
    .slice(headerIndex + 1)
    .filter((row) => row[codeIndex] && row[nameIndex] && isPositiveQuantity(row[quantityIndex] ?? "1"))
    .map((row, index) =>
      rowFromValues(
        {
          externalCode: ensureUniqueExternalCode("GEN", index),
          receiverStore: storeIndex >= 0 ? row[storeIndex] ?? "" : "",
          skuCode: row[codeIndex] ?? "",
          skuName: row[nameIndex] ?? "",
          skuSpec: specIndex >= 0 ? row[specIndex] ?? "" : "",
          skuQuantity: quantityIndex >= 0 ? row[quantityIndex] ?? "1" : "1",
        },
        index + 1,
      ),
    );
}

function parseGenericText(document: ParsedDocument) {
  return splitLines(document.textContent)
    .filter((line) => /\d/.test(line))
    .map((line, index) =>
      rowFromValues(
        {
          externalCode: ensureUniqueExternalCode("TXT", index),
          note: line,
        },
        index + 1,
      ),
    );
}

function executeScenarioParser(document: ParsedDocument, scenario: DetectedScenario) {
  if (scenario === "haikou_delivery") {
    return {
      rows: parseHaikouDelivery(document),
      summary: ["已识别头部表格和尾部收货信息组合场景"],
    };
  }

  if (scenario === "hunan_summary") {
    return {
      rows: parseHunanSummary(document),
      summary: ["已识别湖南仓配送汇总单明细场景"],
    };
  }

  if (scenario === "multi_sheet_store") {
    return {
      rows: parseMultiSheetStore(document),
      summary: ["已识别多 Sheet 门店出库场景"],
    };
  }

  if (scenario === "store_matrix") {
    return {
      rows: parseStoreMatrix(document),
      summary: ["已识别横向门店矩阵转置场景"],
    };
  }

  if (scenario === "card_transfer") {
    return {
      rows: parseCardTransfer(document),
      summary: ["已识别卡片式调拨单场景"],
    };
  }

  if (scenario === "pdf_delivery") {
    return {
      rows: parsePdfDelivery(document),
      summary: ["已识别 PDF 配送单场景"],
    };
  }

  if (scenario === "generic_table") {
    return {
      rows: parseGenericTable(document),
      summary: ["已按通用表格场景解析"],
    };
  }

  return {
    rows: parseGenericText(document),
    summary: ["已按纯文本兜底场景解析"],
  };
}

export function createDefaultRuleDsl(mapping: UniversalImportMapping, fileType: SupportedImportFileType): UniversalImportRuleDsl {
  return {
    fileType,
    mode: fileType === "excel" ? "structured" : "text",
    mapping,
    transforms: [
      { type: "multisheet_merge", enabled: true },
      { type: "group_by_external_code", enabled: true },
      { type: "matrix_pivot", enabled: true },
      { type: "split_multiline_cell", enabled: true },
      { type: "tail_text_extract", enabled: true },
      { type: "card_split", enabled: true },
      { type: "text_record_split", enabled: true },
    ],
  };
}

export async function executeUniversalImportRule(options: {
  fileBuffer: Buffer;
  fileType: SupportedImportFileType;
  originalFileName: string;
  rule: UniversalImportRuleDsl;
}) {
  const document = await parseImportDocument({
    fileBuffer: options.fileBuffer,
    fileType: options.fileType,
    originalFileName: options.originalFileName,
  });

  const scenario = detectScenario(document);
  const { rows, summary } = executeScenarioParser(document, scenario);
  const validation = validateImportRows(rows);

  return {
    document,
    previewRows: rows,
    issues: validation.issues.map(formatIssueLabel),
    issueCount: validation.issues.length,
    rowCount: rows.length,
    summary: [`scenario:${scenario}`, ...summary],
  } satisfies RuleExecutionResult;
}
