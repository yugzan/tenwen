import Papa from "papaparse";

export type QAItem = {
  id: string;
  question: string;
  answer: string;
  tag: string;
};

export type CsvColumnMap = {
  questionKey: string;
  answerKey: string;
  tagKey?: string | null;
};

export type ImportResult = {
  rows: QAItem[];
  total: number;
  skipped: number;
};

export type RawCsvRow = Record<string, string | undefined>;

const QUESTION_ALIASES = [
  "question",
  "questions",
  "title",
  "prompt",
  "q",
  "題目",
  "題幹",
  "問題"
];

const ANSWER_ALIASES = [
  "answer",
  "answers",
  "solution",
  "response",
  "a",
  "答案",
  "解答"
];

const TAG_ALIASES = [
  "tag",
  "tags",
  "label",
  "labels",
  "category",
  "categories",
  "type",
  "分類",
  "標籤",
  "標記",
  "類型"
];

const TAG_SPLIT_REGEX = /[|,、，;；/]+/;

const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "");

const isAliasMatch = (header: string, alias: string) => {
  if (alias.length <= 1) {
    return header === alias;
  }

  return header === alias || header.includes(alias);
};

const buildId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const escapeCsv = (value: string) => `"${value.replaceAll('"', '""')}"`;

const normalizeTag = (raw: string): string => {
  const dedupe = new Set<string>();
  raw
    .split(TAG_SPLIT_REGEX)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => dedupe.add(part));
  return Array.from(dedupe).join("|");
};

export function parseCsv(file: File): Promise<{ rawRows: RawCsvRow[]; headers: string[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse<RawCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const rawRows = result.data.filter((row) =>
          Object.values(row).some((cell) => String(cell ?? "").trim())
        );
        const headers = result.meta.fields ?? [];

        resolve({ rawRows, headers });
      },
      error: (error) => reject(error)
    });
  });
}

export function detectColumnMap(headers: string[]): CsvColumnMap | null {
  if (!headers.length) {
    return null;
  }

  let questionKey: string | null = null;
  let answerKey: string | null = null;
  let tagKey: string | null = null;

  for (const header of headers) {
    const normalized = normalizeHeader(header);

    if (!questionKey && QUESTION_ALIASES.some((alias) => isAliasMatch(normalized, alias))) {
      questionKey = header;
    }

    if (!answerKey && ANSWER_ALIASES.some((alias) => isAliasMatch(normalized, alias))) {
      answerKey = header;
    }

    if (!tagKey && TAG_ALIASES.some((alias) => isAliasMatch(normalized, alias))) {
      tagKey = header;
    }
  }

  if (!questionKey || !answerKey) {
    return null;
  }

  return { questionKey, answerKey, tagKey };
}

export function isColumnMapHighConfidence(map: CsvColumnMap): boolean {
  const questionNormalized = normalizeHeader(map.questionKey);
  const answerNormalized = normalizeHeader(map.answerKey);

  return (
    QUESTION_ALIASES.includes(questionNormalized) && ANSWER_ALIASES.includes(answerNormalized)
  );
}

export function normalizeRows(rawRows: RawCsvRow[], map: CsvColumnMap): ImportResult {
  const rows: QAItem[] = [];
  let skipped = 0;

  for (const row of rawRows) {
    const question = String(row[map.questionKey] ?? "").trim();
    const answer = String(row[map.answerKey] ?? "").trim();
    const tag = map.tagKey ? normalizeTag(String(row[map.tagKey] ?? "")) : "";

    if (!question && !answer) {
      skipped += 1;
      continue;
    }

    rows.push({
      id: buildId(),
      question,
      answer,
      tag
    });
  }

  return {
    rows,
    total: rawRows.length,
    skipped
  };
}

export function exportCsv(rows: QAItem[]): void {
  const header = "question,answer,tag";
  const body = rows
    .map((row) => `${escapeCsv(row.question)},${escapeCsv(row.answer)},${escapeCsv(row.tag)}`)
    .join("\n");

  const csvContent = `\uFEFF${header}\n${body}`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });

  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace("T", "_")
    .slice(0, 19);

  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.href = url;
  link.download = `qa-dataset-${timestamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
