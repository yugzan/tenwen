import { type ButtonHTMLAttributes, type HTMLAttributes, useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { useCSVReader } from "react-papaparse";
import {
  CsvColumnMap,
  QAItem,
  RawCsvRow,
  detectColumnMap,
  exportCsv,
  isColumnMapHighConfidence,
  normalizeRows,
  parseCsv,
  parseCsvText
} from "../lib/csv";

const STORAGE_KEY = "qa-workbench-data-v1";
const VIEW_MODE_KEY = "qa-view-mode-v1";
const RIGHT_PANEL_WIDTH_KEY = "qa-right-panel-width-v1";
const DEFAULT_RIGHT_PANEL_WIDTH = 360;
const MIN_RIGHT_PANEL_WIDTH = 300;
const MAX_RIGHT_PANEL_WIDTH = 520;
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";

type StatusTone = "success" | "warning" | "info";

type ImportPreview = {
  rawRows: RawCsvRow[];
  headers: string[];
};

type SaveMode = "auto" | "manual";

type CsvReaderRenderProps = {
  acceptedFile?: { name?: string };
  getRemoveFileProps: () => ButtonHTMLAttributes<HTMLButtonElement>;
  getRootProps: () => HTMLAttributes<HTMLDivElement>;
};

type QuickKeyword = {
  value: string;
  count: number;
};

type QuickKeywordGroup = {
  title: string;
  values: string[];
};

type BatchField = "all" | "question" | "answer" | "tag";

type BigramStat = {
  token: string;
  count: number;
};

type ViewMode = "query" | "edit";
type ReportStatus = "pending" | "accepted" | "rejected" | "merged";

type ReportPayload = {
  itemId: string;
  currentQuestion: string;
  currentAnswer: string;
  suggestedQuestion: string;
  suggestedAnswer: string;
  note: string;
  turnstileToken: string;
};

type ReportRecord = {
  id: number;
  item_id: string | null;
  current_question: string;
  current_answer: string;
  suggested_question: string | null;
  suggested_answer: string | null;
  note: string | null;
  status: ReportStatus;
  created_at: string;
  updated_at: string;
};

type DraftRecord = {
  id: number;
  item_id: string | null;
  action: string;
  source: string | null;
  source_ref: string | null;
  created_at: string;
};

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: { sitekey: string; callback: (token: string) => void }) => unknown;
      reset: (widget?: unknown) => void;
    };
  }
}

const statusToneStyles: Record<StatusTone, string> = {
  success: "border-emerald-300/30 bg-emerald-400/10 text-emerald-200",
  warning: "border-amber-300/30 bg-amber-400/10 text-amber-100",
  info: "border-sky-300/30 bg-sky-400/10 text-sky-100"
};

const buttonBase =
  "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";

const QUICK_KEYWORD_GROUPS: QuickKeywordGroup[] = [
  { title: "三界", values: ["遮天", "逍遙", "舊夢", "傳說"] },
  { title: "系統", values: ["仙靈", "神通", "法寶", "古寶", "仙友", "宗門"] },
  { title: "機制", values: ["修練", "境界", "靈獸", "絕技", "護盾"] },
  { title: "技能效果", values: ["會心", "定身"] },
  { title: "詩詞", values: ["五言", "七言", "對聯"] }
];

const TAG_SPLIT_REGEX = /[|,、，;；/]+/;
const POETRY_HINT_REGEX = /(上句|下句|對句|對聯|上聯|下聯)/;
const CJK_REGEX = /[\u3400-\u9fff]/;

const defaultColumnMap = (headers: string[]): CsvColumnMap | null => {
  if (!headers.length) {
    return null;
  }

  return {
    questionKey: headers[0],
    answerKey: headers[Math.min(1, headers.length - 1)],
    tagKey: headers.length >= 3 ? headers[2] : null
  };
};

const parseTags = (raw: string): string[] => {
  const dedupe = new Set<string>();
  raw
    .split(TAG_SPLIT_REGEX)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => dedupe.add(part));
  return Array.from(dedupe);
};

const joinTags = (tags: string[]): string => parseTags(tags.join("|")).join("|");

const normalizeTag = (raw: string): string => joinTags(parseTags(raw));

const appendTag = (raw: string, incoming: string): string => {
  const base = parseTags(raw);
  const add = parseTags(incoming);
  return joinTags([...base, ...add]);
};

const removeTag = (raw: string, target: string): string => joinTags(parseTags(raw).filter((tag) => tag !== target));

const sortRowsForDisplay = (rows: QAItem[]): QAItem[] =>
  [...rows].sort(
    (a, b) =>
      a.question.localeCompare(b.question, "zh-Hant") ||
      a.answer.localeCompare(b.answer, "zh-Hant") ||
      a.id.localeCompare(b.id)
  );

const countKeywordMatches = (rows: QAItem[], keyword: string): number => {
  const normalized = keyword.toLowerCase();
  return rows.filter((row) => {
    const question = row.question.toLowerCase();
    const answer = row.answer.toLowerCase();
    const tag = row.tag.toLowerCase();
    return question.includes(normalized) || answer.includes(normalized) || tag.includes(normalized);
  }).length;
};

const isPoetryMatch = (row: QAItem, tag: "五言" | "七言" | "對聯"): boolean => {
  const tokens = parseTags(row.tag);
  return tokens.some((token) => token === tag || token.includes(tag));
};

const isPoetryRow = (row: QAItem): boolean => POETRY_HINT_REGEX.test(row.question);

const cleanPoetryQuestion = (question: string): string =>
  question
    .replace(/[，,]?(上句|下句|對句|對聯|上聯|下聯)/g, "")
    .replace(/[\s，,。！？、.!?;；:：]/g, "")
    .trim();

const extractPoetryBigrams = (question: string): string[] => {
  const source = cleanPoetryQuestion(question);
  if (source.length < 2) {
    return [];
  }

  const tokenSet = new Set<string>();
  for (let i = 0; i < source.length - 1; i += 1) {
    const token = source.slice(i, i + 2);
    if (!CJK_REGEX.test(token[0]) || !CJK_REGEX.test(token[1])) {
      continue;
    }
    tokenSet.add(token);
  }

  return Array.from(tokenSet);
};

const buildLocalId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const buildBigramStats = (rows: QAItem[]): { stats: BigramStat[]; tokenToIds: Map<string, Set<string>> } => {
  const tokenToIds = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!isPoetryRow(row)) {
      continue;
    }

    const tokens = extractPoetryBigrams(row.question);
    for (const token of tokens) {
      if (!tokenToIds.has(token)) {
        tokenToIds.set(token, new Set<string>());
      }
      tokenToIds.get(token)?.add(row.id);
    }
  }

  const stats = Array.from(tokenToIds.entries())
    .map(([token, ids]) => ({ token, count: ids.size }))
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token, "zh-Hant"));

  return { stats, tokenToIds };
};

export function QAWorkbench() {
  const { CSVReader } = useCSVReader();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetRef = useRef<unknown>(null);

  const [qaData, setQaData] = useState<QAItem[]>([]);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [draftAnswer, setDraftAnswer] = useState("");
  const [draftTag, setDraftTag] = useState("");
  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [newTag, setNewTag] = useState("");
  const [columnMap, setColumnMap] = useState<CsvColumnMap | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [statusText, setStatusText] = useState("請先匯入 CSV 題庫。");
  const [statusTone, setStatusTone] = useState<StatusTone>("info");
  const [storageReady, setStorageReady] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("query");
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [batchTagPreset, setBatchTagPreset] = useState("");
  const [batchCustomTag, setBatchCustomTag] = useState("");
  const [advancedField, setAdvancedField] = useState<BatchField>("all");
  const [advancedKeyword, setAdvancedKeyword] = useState("");
  const [selectedBigram, setSelectedBigram] = useState("");
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<QAItem | null>(null);
  const [reportCurrentQuestion, setReportCurrentQuestion] = useState("");
  const [reportCurrentAnswer, setReportCurrentAnswer] = useState("");
  const [reportSuggestedQuestion, setReportSuggestedQuestion] = useState("");
  const [reportSuggestedAnswer, setReportSuggestedAnswer] = useState("");
  const [reportNote, setReportNote] = useState("");
  const [reportTurnstileToken, setReportTurnstileToken] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [adminApiKey, setAdminApiKey] = useState("");
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const [adminReports, setAdminReports] = useState<ReportRecord[]>([]);
  const [adminReportsLoading, setAdminReportsLoading] = useState(false);
  const [deletedDraftIds, setDeletedDraftIds] = useState<Set<string>>(new Set());
  const [adminDrafts, setAdminDrafts] = useState<DraftRecord[]>([]);
  const [adminDraftsLoading, setAdminDraftsLoading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const loadSeedData = async () => {
      try {
        const response = await fetch("/qa_seed.csv", { cache: "no-store" });
        if (!response.ok) {
          return false;
        }

        const text = await response.text();
        const { rawRows, headers } = await parseCsvText(text);
        if (!headers.length || !rawRows.length) {
          return false;
        }

        const map = detectColumnMap(headers) ?? defaultColumnMap(headers);
        if (!map) {
          return false;
        }

        const { rows } = normalizeRows(rawRows, map);
        if (!rows.length) {
          return false;
        }

        setQaData(rows);
        setStatusText(`已自動載入公開題庫 ${rows.length} 筆資料。`);
        setStatusTone("info");
        return true;
      } catch {
        return false;
      }
    };

    const rawViewMode = window.localStorage.getItem(VIEW_MODE_KEY);
    if (rawViewMode === "query") {
      setViewMode("query");
    }

    const rawPanelWidth = window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
    if (rawPanelWidth) {
      const parsed = Number(rawPanelWidth);
      if (!Number.isNaN(parsed)) {
        setRightPanelWidth(Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, parsed)));
      }
    }

    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      void loadSeedData().finally(() => setStorageReady(true));
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Array<Partial<QAItem>>;
      if (!Array.isArray(parsed)) {
        window.localStorage.removeItem(STORAGE_KEY);
        setStorageReady(true);
        return;
      }

      const normalized = parsed
        .map((item) => ({
          id: String(item.id ?? buildLocalId()),
          question: String(item.question ?? "").trim(),
          answer: String(item.answer ?? "").trim(),
          tag: normalizeTag(String(item.tag ?? ""))
        }))
        .filter((item) => item.question || item.answer || item.tag);

      if (normalized.length > 0) {
        setQaData(normalized);
        setStatusText(`已從瀏覽器載入 ${normalized.length} 筆題庫資料。`);
        setStatusTone("info");
      } else {
        void loadSeedData();
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
      setStatusText("偵測到舊資料格式錯誤，已清空本機資料，請重新匯入 CSV。");
      setStatusTone("warning");
      void loadSeedData();
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !storageReady) {
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(qaData));
  }, [qaData, storageReady]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    if (!isResizingPanel || typeof window === "undefined") {
      return;
    }

    const onMouseMove = (event: MouseEvent) => {
      if (window.innerWidth < 1024) {
        return;
      }
      const nextWidth = window.innerWidth - event.clientX;
      setRightPanelWidth(Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, nextWidth)));
    };

    const onMouseUp = () => {
      setIsResizingPanel(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizingPanel]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const updateDesktop = () => {
      setIsDesktop(window.innerWidth >= 1024);
    };
    updateDesktop();
    window.addEventListener("resize", updateDesktop);
    return () => window.removeEventListener("resize", updateDesktop);
  }, []);

  useEffect(() => {
    if (viewMode === "query") {
      setEditingRowId(null);
      setDraftQuestion("");
      setDraftAnswer("");
      setDraftTag("");
    }
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === "edit" && !isAdminUnlocked) {
      setViewMode("query");
    }
  }, [isAdminUnlocked, viewMode]);

  useEffect(() => {
    if (!reportModalOpen || !TURNSTILE_SITE_KEY || typeof window === "undefined") {
      return;
    }

    const mountWidget = () => {
      if (!window.turnstile || !turnstileContainerRef.current) {
        return;
      }
      turnstileContainerRef.current.innerHTML = "";
      turnstileWidgetRef.current = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => setReportTurnstileToken(token)
      });
    };

    if (window.turnstile) {
      mountWidget();
      return;
    }

    let script = document.getElementById("cf-turnstile-script") as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = "cf-turnstile-script";
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", mountWidget);
    return () => script?.removeEventListener("load", mountWidget);
  }, [reportModalOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase() ?? "";
      const isTypingContext = tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable;

      if (event.key === "/" && !isTypingContext) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (event.key === "Escape" && !isTypingContext && searchKeyword) {
        setSearchKeyword("");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchKeyword]);

  const fuse = useMemo(
    () =>
      new Fuse(qaData, {
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true,
        minMatchCharLength: 2,
        keys: [
          { name: "question", weight: 0.7 },
          { name: "answer", weight: 0.25 },
          { name: "tag", weight: 0.05 }
        ]
      }),
    [qaData]
  );

  const filteredQA = useMemo(() => {
    const keyword = searchKeyword.trim();
    if (!keyword) {
      return qaData;
    }

    if (keyword === "五言" || keyword === "七言" || keyword === "對聯") {
      return sortRowsForDisplay(qaData.filter((row) => isPoetryMatch(row, keyword)));
    }

    const exactMatches = qaData.filter((row) => {
      const question = row.question.toLowerCase();
      const answer = row.answer.toLowerCase();
      const tag = row.tag.toLowerCase();
      const normalized = keyword.toLowerCase();
      return question.includes(normalized) || answer.includes(normalized) || tag.includes(normalized);
    });

    if (exactMatches.length >= 8 || keyword.length < 2) {
      return sortRowsForDisplay(exactMatches);
    }

    const fuzzyMatches = fuse
      .search(keyword, { limit: 16 })
      .filter((result) => typeof result.score === "number" && result.score <= 0.3)
      .map((result) => result.item);

    const merged = new Map<string, QAItem>();
    for (const row of exactMatches) {
      merged.set(row.id, row);
    }
    for (const row of fuzzyMatches) {
      merged.set(row.id, row);
    }

    return sortRowsForDisplay(Array.from(merged.values()));
  }, [fuse, qaData, searchKeyword]);

  const displayRows = useMemo(
    () => (viewMode === "edit" ? filteredQA.filter((row) => !deletedDraftIds.has(row.id)) : filteredQA),
    [deletedDraftIds, filteredQA, viewMode]
  );

  const quickKeywordGroups = useMemo<Array<{ title: string; items: QuickKeyword[] }>>(() => {
    if (qaData.length === 0) {
      return [];
    }

    return QUICK_KEYWORD_GROUPS.map((group) => {
      const items = group.values
        .map((value) => {
          if (value === "五言" || value === "七言" || value === "對聯") {
            return {
              value,
              count: qaData.filter((row) => isPoetryMatch(row, value)).length
            };
          }

          return {
            value,
            count: countKeywordMatches(qaData, value)
          };
        })
        .filter((item) => (group.title === "技能效果" ? item.count >= 1 : item.count >= 2))
        .sort((a, b) => b.count - a.count);

      return {
        title: group.title,
        items
      };
    }).filter((group) => group.items.length > 0);
  }, [qaData]);

  const middleQuickGroups = useMemo(
    () => quickKeywordGroups.filter((group) => group.title === "系統" || group.title === "機制" || group.title === "技能效果"),
    [quickKeywordGroups]
  );

  const sideQuickGroups = useMemo(
    () => quickKeywordGroups.filter((group) => group.title !== "系統" && group.title !== "機制" && group.title !== "技能效果"),
    [quickKeywordGroups]
  );

  const existingTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of qaData) {
      for (const tag of parseTags(row.tag)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"))
      .map(([tag, count]) => ({ tag, count }));
  }, [qaData]);

  const { stats: poetryBigramStats, tokenToIds: bigramToIds } = useMemo(() => buildBigramStats(qaData), [qaData]);

  const advancedMatchedRows = useMemo(() => {
    const keyword = advancedKeyword.trim().toLowerCase();
    if (!keyword) {
      return filteredQA;
    }

    return filteredQA.filter((row) => {
      const question = row.question.toLowerCase();
      const answer = row.answer.toLowerCase();
      const tag = row.tag.toLowerCase();

      if (advancedField === "question") {
        return question.includes(keyword);
      }
      if (advancedField === "answer") {
        return answer.includes(keyword);
      }
      if (advancedField === "tag") {
        return tag.includes(keyword);
      }

      return question.includes(keyword) || answer.includes(keyword) || tag.includes(keyword);
    });
  }, [advancedField, advancedKeyword, filteredQA]);

  const applyImportData = (rows: QAItem[], skipped: number, mode: SaveMode) => {
    if (qaData.length > 0) {
      const shouldOverwrite = window.confirm("目前已有題庫資料，是否覆蓋為新的 CSV 內容？");
      if (!shouldOverwrite) {
        return;
      }
    }

    setQaData(rows.map((row) => ({ ...row, tag: normalizeTag(row.tag) })));
    setEditingRowId(null);
    setDraftQuestion("");
    setDraftAnswer("");
    setDraftTag("");
    setNewTag("");
    setImportPreview(null);
    setColumnMap(null);
    setSelectedBigram("");
    setStatusText(
      mode === "auto"
        ? `已自動辨識欄位並匯入完成：${rows.length} 筆資料，略過 ${skipped} 筆空白列。`
        : `欄位映射已套用，匯入完成：${rows.length} 筆資料，略過 ${skipped} 筆空白列。`
    );
    setStatusTone("success");
  };

  const handleAcceptedFile = async (_results: unknown, file?: File) => {
    if (!file) {
      setStatusText("讀取 CSV 失敗，請重新上傳檔案。");
      setStatusTone("warning");
      return;
    }

    try {
      const { rawRows, headers } = await parseCsv(file);
      if (!headers.length || !rawRows.length) {
        setStatusText("CSV 沒有可用內容，請確認檔案格式。");
        setStatusTone("warning");
        return;
      }

      const autoMap = detectColumnMap(headers);
      const fallbackMap = defaultColumnMap(headers);

      setImportPreview({ rawRows, headers });
      setColumnMap(autoMap ?? fallbackMap);

      if (!autoMap) {
        setStatusText("已讀取 CSV，請先手動指定題目與答案欄位後再套用。");
        setStatusTone("info");
        return;
      }

      if (!isColumnMapHighConfidence(autoMap)) {
        setStatusText("已猜測欄位映射，請確認無誤後按「套用欄位並匯入」。");
        setStatusTone("info");
        return;
      }

      const { rows, skipped } = normalizeRows(rawRows, autoMap);
      applyImportData(rows, skipped, "auto");
    } catch {
      setStatusText("CSV 解析失敗，請確認編碼與欄位格式。");
      setStatusTone("warning");
    }
  };

  const handleConfirmColumnMap = () => {
    if (!importPreview || !columnMap) {
      return;
    }

    if (columnMap.questionKey === columnMap.answerKey) {
      setStatusText("題目與答案欄位不能相同，請重新選擇。");
      setStatusTone("warning");
      return;
    }

    if (
      columnMap.tagKey &&
      (columnMap.tagKey === columnMap.questionKey || columnMap.tagKey === columnMap.answerKey)
    ) {
      setStatusText("標記欄位不能與題目或答案欄位重複。");
      setStatusTone("warning");
      return;
    }

    const { rows, skipped } = normalizeRows(importPreview.rawRows, columnMap);
    applyImportData(rows, skipped, "manual");
  };

  const startEditing = (row: QAItem) => {
    setEditingRowId(row.id);
    setDraftQuestion(row.question);
    setDraftAnswer(row.answer);
    setDraftTag(row.tag);
  };

  const cancelEditing = () => {
    setEditingRowId(null);
    setDraftQuestion("");
    setDraftAnswer("");
    setDraftTag("");
  };

  const saveQA = (id: string) => {
    const nextQuestion = draftQuestion.trim();
    const nextAnswer = draftAnswer.trim();
    const nextTag = normalizeTag(draftTag);

    if (!nextQuestion || !nextAnswer) {
      setStatusText("題目與答案都需要填寫。");
      setStatusTone("warning");
      return;
    }

    setQaData((prev) =>
      prev.map((row) => {
        if (row.id !== id) {
          return row;
        }

        return {
          ...row,
          question: nextQuestion,
          answer: nextAnswer,
          tag: nextTag
        };
      })
    );

    setEditingRowId(null);
    setDraftQuestion("");
    setDraftAnswer("");
    setDraftTag("");
    setStatusText("題目/答案/標記已更新，並同步儲存在瀏覽器。");
    setStatusTone("success");
  };

  const addQA = () => {
    const question = newQuestion.trim();
    const answer = newAnswer.trim();
    const tag = normalizeTag(newTag);

    if (!question || !answer) {
      setStatusText("新增時，題目與答案都需要填寫。");
      setStatusTone("warning");
      return;
    }

    const row: QAItem = {
      id: buildLocalId(),
      question,
      answer,
      tag
    };

    setQaData((prev) => [row, ...prev]);
    setNewQuestion("");
    setNewAnswer("");
    setNewTag("");
    setStatusText("已新增題目。你可以立刻搜尋或下載最新 CSV。");
    setStatusTone("success");
  };

  const removeTagFromRow = (id: string, targetTag: string) => {
    setQaData((prev) =>
      prev.map((row) =>
        row.id === id
          ? {
              ...row,
              tag: removeTag(row.tag, targetTag)
            }
          : row
      )
    );
    setStatusText(`已從該題移除標記「${targetTag}」。`);
    setStatusTone("success");
  };

  const resolveBatchTag = (): string => {
    const custom = batchCustomTag.trim();
    if (custom) {
      return custom;
    }
    return batchTagPreset.trim();
  };

  const applyBatchTagToRows = (rows: QAItem[], tagValue: string): number => {
    const targetIds = new Set(rows.map((row) => row.id));
    let changed = 0;

    setQaData((prev) =>
      prev.map((row) => {
        if (!targetIds.has(row.id)) {
          return row;
        }

        const nextTag = appendTag(row.tag, tagValue);
        if (nextTag === row.tag) {
          return row;
        }

        changed += 1;
        return {
          ...row,
          tag: nextTag
        };
      })
    );

    return changed;
  };

  const applyQuickBatchTag = () => {
    const targetTag = resolveBatchTag();
    if (!targetTag) {
      setStatusText("請先選擇現有標記或輸入自訂標記。");
      setStatusTone("warning");
      return;
    }

    if (displayRows.length === 0) {
      setStatusText("目前搜尋結果為 0，無法批次補標。");
      setStatusTone("warning");
      return;
    }

    const changed = applyBatchTagToRows(displayRows, targetTag);
    if (changed === 0) {
      setStatusText("目前搜尋結果已包含該標記，沒有需要更新的題目。");
      setStatusTone("info");
      return;
    }

    setStatusText(`已對目前搜尋結果批次追加標記「${targetTag}」，更新 ${changed} 筆。`);
    setStatusTone("success");
  };

  const applyAdvancedBatchTag = () => {
    const targetTag = resolveBatchTag();
    if (!targetTag) {
      setStatusText("請先選擇現有標記或輸入自訂標記。");
      setStatusTone("warning");
      return;
    }

    if (advancedMatchedRows.length === 0) {
      setStatusText("進階規則沒有命中任何資料，請調整條件。");
      setStatusTone("warning");
      return;
    }

    const changed = applyBatchTagToRows(advancedMatchedRows, targetTag);
    if (changed === 0) {
      setStatusText("命中資料已包含該標記，沒有需要更新的題目。");
      setStatusTone("info");
      return;
    }

    setStatusText(`已依進階規則追加標記「${targetTag}」，更新 ${changed} 筆。`);
    setStatusTone("success");
  };

  const applySelectedBigramTag = () => {
    if (!selectedBigram) {
      setStatusText("請先點選一個詩詞2字片段。");
      setStatusTone("warning");
      return;
    }

    const ids = bigramToIds.get(selectedBigram);
    if (!ids || ids.size === 0) {
      setStatusText("目前片段沒有命中資料，請重新選擇。");
      setStatusTone("warning");
      return;
    }

    const targetRows = qaData.filter((row) => ids.has(row.id));
    const changed = applyBatchTagToRows(targetRows, selectedBigram);
    if (changed === 0) {
      setStatusText(`片段「${selectedBigram}」命中的題目都已包含此標記。`);
      setStatusTone("info");
      return;
    }

    setStatusText(`已將「${selectedBigram}」標記追加到 ${changed} 筆詩詞題。`);
    setStatusTone("success");
  };

  const openReportModal = (row?: QAItem) => {
    const target = row ?? null;
    setReportTarget(target);
    setReportCurrentQuestion(target?.question ?? "");
    setReportCurrentAnswer(target?.answer ?? "");
    setReportSuggestedQuestion("");
    setReportSuggestedAnswer("");
    setReportNote("");
    setReportTurnstileToken("");
    setReportModalOpen(true);
  };

  const closeReportModal = () => {
    if (reportSubmitting) {
      return;
    }
    setReportModalOpen(false);
    setReportTarget(null);
    setReportCurrentQuestion("");
    setReportCurrentAnswer("");
  };

  const submitReport = async () => {
    if (reportSubmitting) {
      return;
    }

    const payload: ReportPayload = {
      itemId: reportTarget?.id ?? "",
      currentQuestion: reportCurrentQuestion.trim(),
      currentAnswer: reportCurrentAnswer.trim(),
      suggestedQuestion: reportSuggestedQuestion.trim(),
      suggestedAnswer: reportSuggestedAnswer.trim(),
      note: reportNote.trim(),
      turnstileToken: reportTurnstileToken.trim()
    };

    if (!payload.suggestedQuestion && !payload.suggestedAnswer && !payload.note) {
      setStatusText("請至少填一項：建議題目、建議答案或備註。");
      setStatusTone("warning");
      return;
    }

    if (!payload.turnstileToken) {
      setStatusText("請先完成驗證後再送出回報。");
      setStatusTone("warning");
      return;
    }

    setReportSubmitting(true);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setStatusText(result.error || "回報送出失敗。");
        setStatusTone("warning");
        return;
      }

      setStatusText("感謝回報，已送進待審池。");
      setStatusTone("success");
      setReportModalOpen(false);
      setReportTarget(null);
      setReportCurrentQuestion("");
      setReportCurrentAnswer("");
    } catch {
      setStatusText("回報送出失敗，請稍後再試。");
      setStatusTone("warning");
    } finally {
      setReportSubmitting(false);
    }
  };

  const loadAdminReports = async () => {
    if (!adminApiKey.trim()) {
      setStatusText("請先填入管理 API Key。");
      setStatusTone("warning");
      return;
    }

    setAdminReportsLoading(true);
    try {
      const response = await fetch("/api/admin/reports?status=pending", {
        headers: {
          "x-admin-key": adminApiKey.trim()
        }
      });
      const result = (await response.json()) as { error?: string; reports?: ReportRecord[] };
      if (!response.ok) {
        setStatusText(result.error || "載入待審回報失敗。");
        setStatusTone("warning");
        return;
      }
      setAdminReports(result.reports ?? []);
      setStatusText(`已載入 ${result.reports?.length ?? 0} 筆待審回報。`);
      setStatusTone("info");
    } catch {
      setStatusText("載入待審回報失敗。");
      setStatusTone("warning");
    } finally {
      setAdminReportsLoading(false);
    }
  };

  const resolveReportAction = async (reportId: number, action: "accept" | "reject") => {
    if (!adminApiKey.trim()) {
      setStatusText("請先填入管理 API Key。");
      setStatusTone("warning");
      return;
    }

    try {
      const response = await fetch(`/api/admin/reports/${reportId}/${action}`, {
        method: "POST",
        headers: {
          "x-admin-key": adminApiKey.trim()
        }
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setStatusText(result.error || "處理回報失敗。");
        setStatusTone("warning");
        return;
      }

      setAdminReports((prev) => prev.filter((report) => report.id !== reportId));
      setStatusText(action === "accept" ? "回報已採納並轉入草稿流程。" : "回報已駁回。");
      setStatusTone("success");
    } catch {
      setStatusText("處理回報失敗。");
      setStatusTone("warning");
    }
  };

  const loadAdminDrafts = async () => {
    if (!adminApiKey.trim()) {
      setStatusText("請先填入管理 API Key。");
      setStatusTone("warning");
      return;
    }

    setAdminDraftsLoading(true);
    try {
      const response = await fetch("/api/admin/drafts", {
        headers: {
          "x-admin-key": adminApiKey.trim()
        }
      });
      const result = (await response.json()) as { error?: string; drafts?: DraftRecord[] };
      if (!response.ok) {
        setStatusText(result.error || "載入草稿失敗。");
        setStatusTone("warning");
        return;
      }
      setAdminDrafts(result.drafts ?? []);
    } catch {
      setStatusText("載入草稿失敗。");
      setStatusTone("warning");
    } finally {
      setAdminDraftsLoading(false);
    }
  };

  const enterEditMode = async () => {
    const key = adminApiKey.trim();
    if (!key) {
      setStatusText("請先輸入管理 API Key 才能進入編輯模式。");
      setStatusTone("warning");
      return;
    }

    try {
      const response = await fetch("/api/admin/drafts", {
        headers: {
          "x-admin-key": key
        }
      });
      const result = (await response.json()) as { error?: string; drafts?: DraftRecord[] };
      if (!response.ok) {
        setStatusText(result.error || "管理 API Key 無效，無法進入編輯模式。");
        setStatusTone("warning");
        return;
      }

      setAdminDrafts(result.drafts ?? []);
      setIsAdminUnlocked(true);
      setViewMode("edit");
      setStatusText("管理員驗證成功，已進入編輯模式。");
      setStatusTone("success");
    } catch {
      setStatusText("驗證失敗，請稍後再試。");
      setStatusTone("warning");
    }
  };

  const draftDeleteRow = async (row: QAItem) => {
    if (!adminApiKey.trim()) {
      setStatusText("請先填入管理 API Key。");
      setStatusTone("warning");
      return;
    }

    const ok = window.confirm("確定刪除此題？");
    if (!ok) {
      return;
    }

    try {
      const response = await fetch("/api/admin/drafts/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminApiKey.trim()
        },
        body: JSON.stringify({
          itemId: row.id,
          beforePayload: {
            question: row.question,
            answer: row.answer,
            tag: row.tag || null
          }
        })
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setStatusText(result.error || "建立刪除草稿失敗。");
        setStatusTone("warning");
        return;
      }

      setDeletedDraftIds((prev) => new Set(prev).add(row.id));
      setStatusText("已加入刪除草稿，待發佈生效。");
      setStatusTone("success");
      loadAdminDrafts();
    } catch {
      setStatusText("建立刪除草稿失敗。");
      setStatusTone("warning");
    }
  };

  const resetLocalCacheAndReloadSeed = async () => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.removeItem(STORAGE_KEY);
      setQaData([]);
      setEditingRowId(null);
      setDraftQuestion("");
      setDraftAnswer("");
      setDraftTag("");
      setSearchKeyword("");

      const response = await fetch("/qa_seed.csv", { cache: "no-store" });
      if (!response.ok) {
        setStatusText("已清除本機快取，但公開題庫載入失敗。");
        setStatusTone("warning");
        return;
      }

      const text = await response.text();
      const { rawRows, headers } = await parseCsvText(text);
      const map = detectColumnMap(headers) ?? defaultColumnMap(headers);
      if (!map) {
        setStatusText("已清除本機快取，但公開題庫欄位格式無法辨識。");
        setStatusTone("warning");
        return;
      }

      const { rows } = normalizeRows(rawRows, map);
      setQaData(rows);
      setStatusText(`已重置快取並重新載入公開題庫 ${rows.length} 筆。`);
      setStatusTone("success");
    } catch {
      setStatusText("重置本機快取失敗，請稍後再試。");
      setStatusTone("warning");
    }
  };

  return (
    <main
      className="flex min-h-screen w-full flex-col px-4 pb-40 pt-4 sm:px-6 lg:pb-10"
      style={{
        paddingRight: isDesktop ? rightPanelWidth + 24 : undefined
      }}
    >
      <section className="-mx-4 border-b border-slate-700/60 bg-surface-900/95 px-4 pb-4 pt-4 sm:-mx-6 sm:px-6">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-lg font-semibold tracking-wide text-slate-100 sm:text-xl">題庫搜尋與修改工作台</h1>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-xl border border-slate-600 bg-surface-800 p-1">
                <button
                  type="button"
                  onClick={() => setViewMode("query")}
                  className={`rounded-lg px-3 py-1.5 text-xs transition ${
                    viewMode === "query" ? "bg-accent-500 text-slate-950" : "text-slate-300 hover:text-white"
                  }`}
                >
                  查詢模式
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void enterEditMode();
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs transition ${
                    viewMode === "edit" ? "bg-accent-500 text-slate-950" : "text-slate-300 hover:text-white"
                  }`}
                >
                  編輯模式
                </button>
              </div>
              {viewMode === "query" ? (
                <input
                  type="password"
                  autoComplete="off"
                  value={adminApiKey}
                  onChange={(event) => setAdminApiKey(event.target.value)}
                  placeholder="管理 API Key（進入編輯用）"
                  className="h-10 w-52 rounded-xl border border-slate-600 bg-surface-800 px-3 text-xs text-slate-200 outline-none ring-accent-400 focus:ring-2"
                />
              ) : null}
              <button
                onClick={() => {
                  exportCsv(qaData);
                  setStatusText("已匯出最新題庫 CSV。");
                  setStatusTone("success");
                }}
                disabled={qaData.length === 0}
                className={`${buttonBase} bg-accent-500 text-slate-950 hover:bg-accent-400`}
              >
                下載最新題庫
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-4 grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className={`flex-1 rounded-xl border px-3 py-2 text-sm ${statusToneStyles[statusTone]}`}>{statusText}</div>
          <button
            type="button"
            onClick={() => {
              void resetLocalCacheAndReloadSeed();
            }}
            className="h-9 rounded-xl border border-slate-500 bg-surface-700 px-3 text-xs text-slate-200 transition hover:border-accent-400 hover:text-white active:scale-95"
          >
            重置快取並重載題庫
          </button>
        </div>

        <div className="sticky top-2 z-20 rounded-2xl border border-slate-700/80 bg-surface-900/95 p-3 backdrop-blur">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <input
              ref={searchInputRef}
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="快速查詢（可直接輸入或點下方快捷詞）"
              className="h-11 rounded-xl border border-slate-600 bg-surface-800 px-3 text-sm text-slate-100 outline-none ring-accent-400 transition placeholder:text-slate-400 focus:ring-2"
            />
            <div className="flex h-11 items-center rounded-xl border border-slate-700 bg-surface-800 px-3 text-sm text-slate-300">
              共 <span className="mx-1 font-semibold text-slate-100">{displayRows.length}</span> / {qaData.length} 筆
            </div>
            <button
              type="button"
              onClick={() => setSearchKeyword("")}
              className="h-11 rounded-xl border border-slate-500 bg-surface-700 px-3 text-xs text-slate-300 transition hover:border-slate-300 hover:text-white active:scale-95"
            >
              清除
            </button>
          </div>
          {viewMode === "query" ? (
            <div className="mt-2 flex items-center justify-end">
              <button
                type="button"
                onClick={() => openReportModal()}
                className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200 transition hover:border-amber-300 hover:text-amber-100 active:scale-95"
              >
                新增回報（題目不在列表時）
              </button>
            </div>
          ) : null}

          {middleQuickGroups.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {middleQuickGroups.map((group) => (
                <div key={`middle-${group.title}`} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-slate-400">{group.title}</span>
                  {group.items.map((keyword) => (
                    <button
                      key={`middle-${group.title}-${keyword.value}`}
                      type="button"
                      onClick={() => setSearchKeyword(keyword.value)}
                      className="h-8 rounded-lg border border-slate-600 bg-surface-800 px-2 text-xs text-slate-200 transition hover:border-accent-400 hover:text-white active:scale-95"
                    >
                      {keyword.value}
                      <span className="ml-1 text-slate-400">({keyword.count})</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {viewMode === "edit" && isAdminUnlocked ? (
          <div className="rounded-2xl border border-slate-700 bg-surface-800 p-4">
          <h2 className="text-sm font-semibold text-slate-100">新增題目</h2>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            <input
              value={newQuestion}
              onChange={(event) => setNewQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addQA();
                }
              }}
              placeholder="新增題目"
              className="h-11 min-w-[240px] flex-1 rounded-xl border border-slate-600 bg-surface-700 px-3 text-sm text-slate-100 outline-none ring-accent-400 transition placeholder:text-slate-400 focus:ring-2"
            />
            <input
              value={newAnswer}
              onChange={(event) => setNewAnswer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addQA();
                }
              }}
              placeholder="新增答案"
              className="h-11 min-w-[200px] flex-1 rounded-xl border border-slate-600 bg-surface-700 px-3 text-sm text-slate-100 outline-none ring-accent-400 transition placeholder:text-slate-400 focus:ring-2"
            />
            <input
              value={newTag}
              onChange={(event) => setNewTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addQA();
                }
              }}
              placeholder="標記（例：七言|借問）"
              className="h-11 min-w-[180px] rounded-xl border border-slate-600 bg-surface-700 px-3 text-sm text-slate-100 outline-none ring-accent-400 transition placeholder:text-slate-400 focus:ring-2"
            />
            <button
              type="button"
              onClick={addQA}
              className={`${buttonBase} h-11 shrink-0 bg-emerald-500 text-slate-950 hover:bg-emerald-400 active:scale-95`}
            >
              新增
            </button>
          </div>
          </div>
        ) : null}

        {viewMode === "edit" && isAdminUnlocked ? (
          <details className="rounded-2xl border border-slate-700 bg-surface-800 p-4" defaultOpen={qaData.length === 0}>
          <summary className="cursor-pointer list-none text-sm font-semibold text-slate-100">
            檔案匯入與欄位設定（可收合）
          </summary>
          <div className="mt-3 grid gap-4">
            <CSVReader
              config={{ header: true, skipEmptyLines: true }}
              onUploadAccepted={handleAcceptedFile}
              noDrag={false}
              onError={() => {
                setStatusText("檔案上傳失敗，請重新嘗試。");
                setStatusTone("warning");
              }}
            >
              {({ getRootProps, acceptedFile, getRemoveFileProps }: CsvReaderRenderProps) => (
                <div className="rounded-2xl border border-dashed border-slate-500/70 bg-surface-800 p-4 shadow-glow">
                  <div
                    {...getRootProps()}
                    className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-xl border border-transparent px-4 py-5 text-center transition hover:border-accent-400/60 hover:bg-surface-700"
                  >
                    <p className="text-sm font-medium text-slate-100">拖拉 CSV 到這裡，或點擊選擇檔案</p>
                    <p className="mt-1 text-xs text-slate-400">支援 UTF-8 編碼，欄位可為 question/answer/tag 或自訂名稱</p>
                    {acceptedFile ? <p className="mt-3 text-xs text-accent-400">已選擇：{String(acceptedFile.name ?? "CSV")}</p> : null}
                  </div>

                  {acceptedFile ? (
                    <div className="mt-3 flex justify-end">
                      <button
                        {...getRemoveFileProps()}
                        className={`${buttonBase} border border-slate-500 bg-surface-700 text-slate-200 hover:border-slate-300`}
                      >
                        清除檔案
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </CSVReader>

            {importPreview && columnMap ? (
              <div className="rounded-2xl border border-slate-700 bg-surface-800 p-4">
                <h2 className="text-sm font-semibold text-slate-100">欄位映射確認</h2>
                <p className="mt-1 text-xs text-slate-400">若自動辨識不符合你的檔案格式，可在這裡修正後再匯入。</p>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <label className="grid gap-1 text-sm">
                    <span className="text-slate-300">題目欄位</span>
                    <select
                      value={columnMap.questionKey}
                      onChange={(event) =>
                        setColumnMap((prev) =>
                          prev
                            ? {
                                ...prev,
                                questionKey: event.target.value
                              }
                            : prev
                        )
                      }
                      className="h-11 rounded-xl border border-slate-600 bg-surface-700 px-3 text-slate-100"
                    >
                      {importPreview.headers.map((header) => (
                        <option key={`question-${header}`} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1 text-sm">
                    <span className="text-slate-300">答案欄位</span>
                    <select
                      value={columnMap.answerKey}
                      onChange={(event) =>
                        setColumnMap((prev) =>
                          prev
                            ? {
                                ...prev,
                                answerKey: event.target.value
                              }
                            : prev
                        )
                      }
                      className="h-11 rounded-xl border border-slate-600 bg-surface-700 px-3 text-slate-100"
                    >
                      {importPreview.headers.map((header) => (
                        <option key={`answer-${header}`} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1 text-sm">
                    <span className="text-slate-300">標記欄位（可選）</span>
                    <select
                      value={columnMap.tagKey ?? ""}
                      onChange={(event) =>
                        setColumnMap((prev) =>
                          prev
                            ? {
                                ...prev,
                                tagKey: event.target.value || null
                              }
                            : prev
                        )
                      }
                      className="h-11 rounded-xl border border-slate-600 bg-surface-700 px-3 text-slate-100"
                    >
                      <option value="">（不使用標記欄位）</option>
                      {importPreview.headers.map((header) => (
                        <option key={`tag-${header}`} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    onClick={handleConfirmColumnMap}
                    className={`${buttonBase} bg-accent-500 text-slate-950 hover:bg-accent-400`}
                  >
                    套用欄位並匯入
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          </details>
        ) : null}
      </section>

      <section className="mt-5">
        {displayRows.length === 0 ? (
          <div className="rounded-2xl border border-slate-700 bg-surface-800 px-4 py-12 text-center text-slate-400">
            沒有符合條件的資料，試試不同關鍵字。
          </div>
        ) : null}

        {displayRows.length > 0 ? (
          <>
            <div className="hidden overflow-hidden rounded-2xl border border-slate-700 bg-surface-800 md:block">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700 bg-surface-700 text-slate-300">
                    <th className={`${viewMode === "edit" && isAdminUnlocked ? "w-[40%]" : "w-[50%]"} px-4 py-3 font-medium`}>題目</th>
                    <th className={`${viewMode === "edit" && isAdminUnlocked ? "w-[34%]" : "w-[38%]"} px-4 py-3 font-medium`}>答案</th>
                    <th className={`${viewMode === "edit" ? "w-[12%]" : "w-[12%]"} px-4 py-3 font-medium`}>標記</th>
                    {viewMode === "edit" && isAdminUnlocked ? <th className="w-[14%] px-4 py-3 font-medium">操作</th> : null}
                  </tr>
                </thead>

                <tbody>
                  {displayRows.map((row) => {
                    const isEditing = editingRowId === row.id;
                    const tags = parseTags(row.tag);

                    return (
                      <tr key={row.id} className="border-b border-slate-700/70 align-top last:border-b-0">
                        <td className="px-4 py-3 text-slate-100">
                          {isEditing ? (
                            <textarea
                              value={draftQuestion}
                              onChange={(event) => setDraftQuestion(event.target.value)}
                              className="min-h-20 w-full rounded-xl border border-slate-600 bg-surface-700 p-2 text-sm outline-none ring-accent-400 focus:ring-2"
                            />
                          ) : row.question ? (
                            row.question
                          ) : (
                            <span className="text-slate-500">(空白)</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-100">
                          {isEditing ? (
                            <textarea
                              value={draftAnswer}
                              onChange={(event) => setDraftAnswer(event.target.value)}
                              className="min-h-24 w-full rounded-xl border border-slate-600 bg-surface-700 p-2 text-sm outline-none ring-accent-400 focus:ring-2"
                            />
                          ) : row.answer ? (
                            row.answer
                          ) : (
                            <span className="text-slate-500">(空白)</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-100">
                          {isEditing ? (
                            <input
                              value={draftTag}
                              onChange={(event) => setDraftTag(event.target.value)}
                              placeholder="例如：對聯|借問"
                              className="h-10 w-full rounded-xl border border-slate-600 bg-surface-700 px-2 text-sm outline-none ring-accent-400 focus:ring-2"
                            />
                          ) : tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {tags.map((tag) => (
                                <span
                                  key={`${row.id}-${tag}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-slate-500 bg-surface-700 px-2 py-1 text-xs text-slate-200"
                                >
                                  {tag}
                                  <button
                                    type="button"
                                    onClick={() => removeTagFromRow(row.id, tag)}
                                    className="rounded px-1 text-slate-400 transition hover:bg-slate-600 hover:text-white"
                                  >
                                    x
                                  </button>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-slate-500">(未標記)</span>
                          )}
                          {viewMode === "query" ? (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => openReportModal(row)}
                                className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-xs text-amber-200 transition hover:border-amber-300 hover:text-amber-100"
                              >
                                回報
                              </button>
                            </div>
                          ) : null}
                        </td>

                        {viewMode === "edit" && isAdminUnlocked ? (
                          <td className="px-4 py-3">
                            {isEditing ? (
                              <div className="flex gap-2">
                              <button
                                onClick={() => saveQA(row.id)}
                                className={`${buttonBase} bg-emerald-500 px-3 py-1.5 text-slate-950 hover:bg-emerald-400`}
                                >
                                  儲存
                                </button>
                              <button
                                onClick={cancelEditing}
                                className={`${buttonBase} border border-slate-500 bg-surface-700 px-3 py-1.5 text-slate-200 hover:border-slate-300`}
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                              <div className="flex flex-col gap-2">
                                <button
                                  onClick={() => startEditing(row)}
                                  className={`${buttonBase} border border-slate-500 bg-surface-700 px-3 py-1.5 text-slate-100 hover:border-accent-400 hover:text-white`}
                                >
                                  修改題目/答案
                                </button>
                                <button
                                  onClick={() => draftDeleteRow(row)}
                                  className={`${buttonBase} border border-rose-400/40 bg-rose-500/15 px-3 py-1.5 text-rose-200 hover:border-rose-300 hover:text-rose-100`}
                                >
                                  刪除
                                </button>
                              </div>
                          )}
                        </td>
                      ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 md:hidden">
              {displayRows.map((row) => {
                const isEditing = editingRowId === row.id;
                const tags = parseTags(row.tag);

                return (
                  <article key={`card-${row.id}`} className="rounded-2xl border border-slate-700 bg-surface-800 p-4">
                    <p className="text-xs uppercase tracking-wider text-slate-400">題目</p>
                    {isEditing ? (
                      <textarea
                        value={draftQuestion}
                        onChange={(event) => setDraftQuestion(event.target.value)}
                        className="mt-1 min-h-20 w-full rounded-xl border border-slate-600 bg-surface-700 p-2 text-sm outline-none ring-accent-400 focus:ring-2"
                      />
                    ) : (
                      <p className="mt-1 text-sm text-slate-100">{row.question || <span className="text-slate-500">(空白)</span>}</p>
                    )}

                    <p className="mt-3 text-xs uppercase tracking-wider text-slate-400">答案</p>
                    {isEditing ? (
                      <textarea
                        value={draftAnswer}
                        onChange={(event) => setDraftAnswer(event.target.value)}
                        className="mt-1 min-h-24 w-full rounded-xl border border-slate-600 bg-surface-700 p-2 text-sm outline-none ring-accent-400 focus:ring-2"
                      />
                    ) : (
                      <p className="mt-1 text-sm text-slate-100">{row.answer || <span className="text-slate-500">(空白)</span>}</p>
                    )}

                    <p className="mt-3 text-xs uppercase tracking-wider text-slate-400">標記</p>
                    {isEditing ? (
                      <input
                        value={draftTag}
                        onChange={(event) => setDraftTag(event.target.value)}
                        placeholder="例如：對聯|借問"
                        className="mt-1 h-10 w-full rounded-xl border border-slate-600 bg-surface-700 px-3 text-sm text-slate-100 outline-none ring-accent-400 focus:ring-2"
                      />
                    ) : tags.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {tags.map((tag) => (
                          <span
                            key={`${row.id}-m-${tag}`}
                            className="inline-flex items-center gap-1 rounded-full border border-slate-500 bg-surface-700 px-2 py-1 text-xs text-slate-200"
                          >
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTagFromRow(row.id, tag)}
                              className="rounded px-1 text-slate-400 transition hover:bg-slate-600 hover:text-white"
                            >
                              x
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-sm text-slate-100"><span className="text-slate-500">(未標記)</span></p>
                    )}
                    {viewMode === "query" ? (
                      <button
                        type="button"
                        onClick={() => openReportModal(row)}
                        className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-xs text-amber-200 transition hover:border-amber-300 hover:text-amber-100"
                      >
                        回報
                      </button>
                    ) : null}

                    {viewMode === "edit" && isAdminUnlocked ? (
                      <div className="mt-4 flex gap-2">
                        {isEditing ? (
                          <>
                            <button
                              onClick={() => saveQA(row.id)}
                              className={`${buttonBase} flex-1 bg-emerald-500 text-slate-950 hover:bg-emerald-400`}
                            >
                              儲存
                            </button>
                            <button
                              onClick={cancelEditing}
                              className={`${buttonBase} flex-1 border border-slate-500 bg-surface-700 text-slate-200 hover:border-slate-300`}
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <div className="grid w-full gap-2">
                            <button
                              onClick={() => startEditing(row)}
                              className={`${buttonBase} w-full border border-slate-500 bg-surface-700 text-slate-100 hover:border-accent-400 hover:text-white`}
                            >
                              修改題目/答案
                            </button>
                            <button
                              onClick={() => draftDeleteRow(row)}
                              className={`${buttonBase} w-full border border-rose-400/40 bg-rose-500/15 text-rose-200 hover:border-rose-300 hover:text-rose-100`}
                            >
                              刪除
                            </button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      {reportModalOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-surface-900 p-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">匿名回報題庫錯誤</h2>
              <button
                type="button"
                onClick={closeReportModal}
                className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:text-white"
              >
                關閉
              </button>
            </div>

            <div className="mt-3 grid gap-2">
              <label className="grid gap-1 text-xs">
                <span className="text-slate-400">目前題目</span>
                <textarea
                  value={reportCurrentQuestion}
                  readOnly={Boolean(reportTarget)}
                  onChange={(event) => setReportCurrentQuestion(event.target.value)}
                  placeholder="若非對應當前題目，可自行填寫"
                  className="min-h-16 rounded-lg border border-slate-700 bg-surface-800 p-2 text-slate-200"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-slate-400">目前答案</span>
                <textarea
                  value={reportCurrentAnswer}
                  readOnly={Boolean(reportTarget)}
                  onChange={(event) => setReportCurrentAnswer(event.target.value)}
                  placeholder="若非對應當前題目，可自行填寫"
                  className="min-h-14 rounded-lg border border-slate-700 bg-surface-800 p-2 text-slate-200"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-slate-400">建議題目（可選）</span>
                <input
                  value={reportSuggestedQuestion}
                  onChange={(event) => setReportSuggestedQuestion(event.target.value)}
                  className="h-10 rounded-lg border border-slate-600 bg-surface-800 px-2 text-slate-100"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-slate-400">建議答案（可選）</span>
                <input
                  value={reportSuggestedAnswer}
                  onChange={(event) => setReportSuggestedAnswer(event.target.value)}
                  className="h-10 rounded-lg border border-slate-600 bg-surface-800 px-2 text-slate-100"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-slate-400">備註原因（可選）</span>
                <textarea
                  value={reportNote}
                  onChange={(event) => setReportNote(event.target.value)}
                  className="min-h-16 rounded-lg border border-slate-600 bg-surface-800 p-2 text-slate-100"
                />
              </label>

              {TURNSTILE_SITE_KEY ? (
                <div className="rounded-lg border border-slate-700 bg-surface-800 p-2">
                  <div ref={turnstileContainerRef} />
                </div>
              ) : (
                <label className="grid gap-1 text-xs">
                  <span className="text-amber-300">開發模式：請填 Turnstile token（正式環境請設定 VITE_TURNSTILE_SITE_KEY）</span>
                  <input
                    value={reportTurnstileToken}
                    onChange={(event) => setReportTurnstileToken(event.target.value)}
                    className="h-10 rounded-lg border border-slate-600 bg-surface-800 px-2 text-slate-100"
                  />
                </label>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeReportModal}
                className={`${buttonBase} border border-slate-500 bg-surface-700 text-slate-200 hover:border-slate-300`}
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitReport}
                disabled={reportSubmitting}
                className={`${buttonBase} bg-amber-500 text-slate-950 hover:bg-amber-400`}
              >
                {reportSubmitting ? "送出中..." : "送出回報"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <aside className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-700/80 bg-surface-900/95 p-3 backdrop-blur lg:hidden">
        <div className="flex w-full flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="查詢關鍵字"
              className="h-11 rounded-xl border border-slate-600 bg-surface-800 px-3 text-sm text-slate-100 outline-none ring-accent-400 transition placeholder:text-slate-400 focus:ring-2"
            />
            <button
              type="button"
              onClick={() => setSearchKeyword("")}
              className="h-11 rounded-xl border border-slate-500 bg-surface-700 px-3 text-xs text-slate-300 transition hover:border-slate-300 hover:text-white active:scale-95"
            >
              清除
            </button>
          </div>
        </div>
      </aside>

      <aside
        className="fixed right-0 top-0 hidden h-screen border-l border-slate-700/80 bg-surface-900/95 p-4 backdrop-blur lg:block"
        style={{ width: rightPanelWidth }}
      >
        <button
          type="button"
          aria-label="調整右側欄寬度"
          onMouseDown={(event) => {
            event.preventDefault();
            setIsResizingPanel(true);
          }}
          className="absolute left-0 top-0 h-full w-2 -translate-x-1 cursor-col-resize bg-transparent"
        />
        <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
          <p className="text-sm font-semibold tracking-wide text-slate-100">快捷面板</p>
          {viewMode === "query" ? (
            <button
              type="button"
              onClick={() => openReportModal()}
              className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-left text-xs text-amber-200 transition hover:border-amber-300 hover:text-amber-100 active:scale-95"
            >
              題目不在結果？點這裡新增回報
            </button>
          ) : null}

          {viewMode === "edit" && isAdminUnlocked ? (
            <div className="grid gap-2 rounded-2xl border border-slate-700 bg-surface-800 p-3">
            <p className="text-xs font-medium tracking-wide text-slate-300">批次補標（目前搜尋結果）</p>
            <select
              value={batchTagPreset}
              onChange={(event) => setBatchTagPreset(event.target.value)}
              className="h-10 rounded-xl border border-slate-600 bg-surface-700 px-2 text-xs text-slate-100"
            >
              <option value="">選擇現有標記</option>
              {existingTags.map((item) => (
                <option key={item.tag} value={item.tag}>
                  {item.tag} ({item.count})
                </option>
              ))}
            </select>
            <input
              value={batchCustomTag}
              onChange={(event) => setBatchCustomTag(event.target.value)}
              placeholder="或輸入自訂標記（可多個，|分隔）"
              className="h-10 rounded-xl border border-slate-600 bg-surface-700 px-2 text-xs text-slate-100 outline-none ring-accent-400 focus:ring-2"
            />
            <button
              type="button"
              onClick={applyQuickBatchTag}
              className={`${buttonBase} h-10 bg-emerald-500 text-slate-950 hover:bg-emerald-400 active:scale-95`}
            >
              套用到目前結果 ({displayRows.length})
            </button>

            <div className="mt-1 grid gap-2 rounded-xl border border-slate-700 bg-surface-900 p-2">
              <p className="text-[11px] text-slate-400">進階規則模式</p>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={advancedField}
                  onChange={(event) => setAdvancedField(event.target.value as BatchField)}
                  className="h-9 rounded-lg border border-slate-600 bg-surface-700 px-2 text-xs text-slate-100"
                >
                  <option value="all">題目+答案+標記</option>
                  <option value="question">題目</option>
                  <option value="answer">答案</option>
                  <option value="tag">標記</option>
                </select>
                <input
                  value={advancedKeyword}
                  onChange={(event) => setAdvancedKeyword(event.target.value)}
                  placeholder="關鍵字"
                  className="h-9 rounded-lg border border-slate-600 bg-surface-700 px-2 text-xs text-slate-100 outline-none ring-accent-400 focus:ring-2"
                />
              </div>
              <button
                type="button"
                onClick={applyAdvancedBatchTag}
                className={`${buttonBase} h-9 border border-slate-500 bg-surface-700 text-xs text-slate-100 hover:border-accent-400 hover:text-white`}
              >
                套用進階規則 ({advancedMatchedRows.length})
              </button>
            </div>
            </div>
          ) : null}

          {viewMode === "edit" ? (
            <div className="grid gap-2 rounded-2xl border border-slate-700 bg-surface-800 p-3">
              <p className="text-xs font-medium tracking-wide text-slate-300">社群回報待審</p>
              <input
                type="password"
                autoComplete="off"
                value={adminApiKey}
                onChange={(event) => setAdminApiKey(event.target.value)}
                placeholder="管理 API Key"
                className="h-9 rounded-lg border border-slate-600 bg-surface-700 px-2 text-xs text-slate-100 outline-none ring-accent-400 focus:ring-2"
              />
              <button
                type="button"
                onClick={loadAdminReports}
                disabled={adminReportsLoading}
                className={`${buttonBase} h-9 border border-slate-500 bg-surface-700 text-xs text-slate-100 hover:border-accent-400 hover:text-white`}
              >
                {adminReportsLoading ? "載入中..." : `刷新待審 (${adminReports.length})`}
              </button>
              <div className="grid max-h-56 gap-2 overflow-y-auto">
                {adminReports.map((report) => (
                  <div key={`report-${report.id}`} className="rounded-lg border border-slate-700 bg-surface-900 p-2">
                    <p className="line-clamp-2 text-xs text-slate-200">{report.current_question}</p>
                    <p className="mt-1 line-clamp-1 text-[11px] text-slate-400">
                      建議：{report.suggested_question || "(未填)"} / {report.suggested_answer || "(未填)"}
                    </p>
                    {report.note ? <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">備註：{report.note}</p> : null}
                    <div className="mt-2 flex gap-1">
                      <button
                        type="button"
                        onClick={() => resolveReportAction(report.id, "accept")}
                        className="flex-1 rounded-md border border-emerald-400/30 bg-emerald-500/20 px-2 py-1 text-[11px] text-emerald-200"
                      >
                        採納
                      </button>
                      <button
                        type="button"
                        onClick={() => resolveReportAction(report.id, "reject")}
                        className="flex-1 rounded-md border border-rose-400/30 bg-rose-500/20 px-2 py-1 text-[11px] text-rose-200"
                      >
                        駁回
                      </button>
                    </div>
                  </div>
                ))}
                {adminReports.length === 0 ? <p className="text-xs text-slate-500">目前沒有待審回報</p> : null}
              </div>
            </div>
          ) : null}

          {viewMode === "edit" && isAdminUnlocked ? (
            <div className="grid gap-2 rounded-2xl border border-slate-700 bg-surface-800 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium tracking-wide text-slate-300">草稿變更</p>
                <button
                  type="button"
                  onClick={loadAdminDrafts}
                  disabled={adminDraftsLoading}
                  className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:text-white"
                >
                  {adminDraftsLoading ? "刷新中..." : "刷新"}
                </button>
              </div>
              <div className="grid max-h-40 gap-2 overflow-y-auto">
                {adminDrafts.map((draft) => (
                  <div key={`draft-${draft.id}`} className="rounded-lg border border-slate-700 bg-surface-900 p-2">
                    <p className="text-[11px] text-slate-200">
                      #{draft.id} {draft.action} / item: {draft.item_id ?? "(null)"}
                    </p>
                    <p className="text-[10px] text-slate-500">{new Date(draft.created_at).toLocaleString("zh-TW")}</p>
                  </div>
                ))}
                {adminDrafts.length === 0 ? <p className="text-xs text-slate-500">目前沒有草稿</p> : null}
              </div>
            </div>
          ) : null}

          <div className="grid gap-2 rounded-2xl border border-slate-700 bg-surface-800 p-3">
            <p className="text-xs font-medium tracking-wide text-slate-300">詩詞2字（重複片段）</p>
            <div className="grid grid-cols-4 gap-2">
              {poetryBigramStats.map((item) => (
                <button
                  key={item.token}
                  type="button"
                  onClick={() => {
                    setSelectedBigram(item.token);
                    setSearchKeyword(item.token);
                  }}
                  className={`h-9 rounded-lg border px-1 text-xs transition active:scale-95 ${
                    selectedBigram === item.token
                      ? "border-accent-400 bg-accent-500/20 text-white"
                      : "border-slate-600 bg-surface-700 text-slate-200 hover:border-accent-400 hover:text-white"
                  }`}
                >
                  {item.token}
                  <span className="ml-1 text-slate-400">({item.count})</span>
                </button>
              ))}
            </div>
            {viewMode === "edit" && isAdminUnlocked ? (
              <button
                type="button"
                onClick={applySelectedBigramTag}
                disabled={!selectedBigram}
                className={`${buttonBase} h-9 border border-slate-500 bg-surface-700 text-xs text-slate-100 hover:border-accent-400 hover:text-white`}
              >
                將「{selectedBigram || "2字片段"}」批次寫入標記
              </button>
            ) : null}
          </div>

          <div className="grid gap-3">
            {sideQuickGroups.map((group) => (
              <section key={group.title} className="grid gap-2">
                <p className="text-xs font-medium tracking-wide text-slate-400">{group.title}</p>
                <div className="grid grid-cols-3 gap-2">
                  {group.items.map((keyword) => (
                    <button
                      key={keyword.value}
                      type="button"
                      onClick={() => setSearchKeyword(keyword.value)}
                      className="h-10 rounded-xl border border-slate-600 bg-surface-800 px-2 text-xs text-slate-200 transition hover:border-accent-400 hover:text-white active:scale-95"
                    >
                      {keyword.value}
                      <span className="ml-1 text-slate-400">({keyword.count})</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </aside>
    </main>
  );
}
