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

const VIEW_MODE_KEY = "qa-view-mode-v1";
const RIGHT_PANEL_WIDTH_KEY = "qa-right-panel-width-v1";
const DEFAULT_RIGHT_PANEL_WIDTH = 360;
const MIN_RIGHT_PANEL_WIDTH = 300;
const MAX_RIGHT_PANEL_WIDTH = 520;
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";
const ADSENSE_CLIENT = import.meta.env.VITE_ADSENSE_CLIENT ?? "";
const ADSENSE_SLOT = import.meta.env.VITE_ADSENSE_SLOT ?? "";

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

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: { sitekey: string; callback: (token: string) => void }) => unknown;
      reset: (widget?: unknown) => void;
    };
    adsbygoogle?: unknown[];
  }
}

function DrawerAdSlot() {
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!ADSENSE_CLIENT || !ADSENSE_SLOT || typeof window === "undefined") {
      return;
    }

    const scriptId = "adsense-script";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.async = true;
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
      script.crossOrigin = "anonymous";
      document.head.appendChild(script);
    }

    if (!mountedRef.current) {
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        mountedRef.current = true;
      } catch {
        // ignore ads push errors
      }
    }
  }, []);

  if (!ADSENSE_CLIENT || !ADSENSE_SLOT) {
    return null;
  }

  return (
    <div className="rounded-xl border border-mist-300 bg-paper-200 p-2">
      <p className="mb-1 text-[10px] text-mist-500">贊助內容</p>
      <ins
        className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={ADSENSE_SLOT}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}

const statusToneStyles: Record<StatusTone, string> = {
  success: "border-emerald-500/30 bg-emerald-200/60 text-emerald-900",
  warning: "border-amber-500/35 bg-amber-200/60 text-amber-900",
  info: "border-stone-500/35 bg-stone-200/70 text-stone-900"
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
  const mobileSearchPanelRef = useRef<HTMLDivElement | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetRef = useRef<unknown>(null);
  const swipeStartXRef = useRef<number | null>(null);
  const swipeStartYRef = useRef<number | null>(null);

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
  const [viewMode, setViewMode] = useState<ViewMode>("query");
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [showMobileBackToSearch, setShowMobileBackToSearch] = useState(false);
  const [mobileQuickDrawerOpen, setMobileQuickDrawerOpen] = useState(false);
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

  const ensureAdminKey = async (): Promise<string | null> => {
    const current = adminApiKey.trim();
    if (current) {
      return current;
    }

    if (typeof window === "undefined") {
      return null;
    }

    const promptValue = window.prompt("請輸入管理 API Key");
    if (!promptValue) {
      return null;
    }

    const key = promptValue.trim();
    if (!key) {
      return null;
    }
    setAdminApiKey(key);
    return key;
  };

  const fetchItemsFromServer = async (): Promise<QAItem[] | null> => {
    try {
      const response = await fetch("/api/items", { cache: "no-store" });
      const result = (await response.json()) as { error?: string; rows?: QAItem[] };
      if (!response.ok) {
        return null;
      }
      return Array.isArray(result.rows) ? result.rows : [];
    } catch {
      return null;
    }
  };

  const adminRequest = async (
    path: string,
    body: Record<string, unknown>
  ): Promise<{ ok: boolean; data: Record<string, unknown> }> => {
    const key = await ensureAdminKey();
    if (!key) {
      return { ok: false, data: { error: "請先填入管理 API Key。" } };
    }

    try {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": key
        },
        body: JSON.stringify(body)
      });
      const data = (await response.json()) as Record<string, unknown>;
      return { ok: response.ok, data };
    } catch {
      return { ok: false, data: { error: "連線失敗，請稍後再試。" } };
    }
  };

  const replaceAllRowsToServer = async (rows: QAItem[]): Promise<boolean> => {
    const result = await adminRequest("/api/admin/items/replace", { rows });
    return result.ok;
  };

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
        setStatusText(`已載入 ${rows.length} 筆資料。`);
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

    const loadInitialData = async () => {
      const serverRows = await fetchItemsFromServer();
      if (serverRows && serverRows.length > 0) {
        setQaData(serverRows);
        setStatusText(`已載入 ${serverRows.length} 筆資料。`);
        setStatusTone("info");
        return;
      }

      await loadSeedData();
    };

    void loadInitialData();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onTouchStart = (event: TouchEvent) => {
      if (window.innerWidth >= 1024) {
        return;
      }
      if (event.touches.length !== 1) {
        return;
      }
      const touch = event.touches[0];
      swipeStartXRef.current = touch.clientX;
      swipeStartYRef.current = touch.clientY;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (window.innerWidth >= 1024) {
        return;
      }
      if (event.changedTouches.length !== 1) {
        return;
      }

      const startX = swipeStartXRef.current;
      const startY = swipeStartYRef.current;
      swipeStartXRef.current = null;
      swipeStartYRef.current = null;
      if (startX === null || startY === null) {
        return;
      }

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (Math.abs(deltaY) > 50) {
        return;
      }

      const edgeThreshold = 28;
      if (!mobileQuickDrawerOpen && startX >= window.innerWidth - edgeThreshold && deltaX <= -45) {
        setMobileQuickDrawerOpen(true);
        return;
      }

      if (mobileQuickDrawerOpen && deltaX >= 45) {
        setMobileQuickDrawerOpen(false);
      }
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [mobileQuickDrawerOpen]);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onScroll = () => {
      const isMobile = window.innerWidth < 1024;
      setShowMobileBackToSearch(isMobile && window.scrollY > 280);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

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

  const displayRows = useMemo(() => filteredQA, [filteredQA]);

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

  const applyImportData = async (rows: QAItem[], skipped: number, mode: SaveMode) => {
    if (qaData.length > 0) {
      const shouldOverwrite = window.confirm("目前已有題庫資料，是否覆蓋為新的 CSV 內容？");
      if (!shouldOverwrite) {
        return;
      }
    }

    const normalizedRows = rows.map((row) => ({ ...row, tag: normalizeTag(row.tag) }));
    if (isAdminUnlocked) {
      const ok = await replaceAllRowsToServer(normalizedRows);
      if (!ok) {
        setStatusText("匯入成功，但同步到資料庫失敗。");
        setStatusTone("warning");
      }
    }

    setQaData(normalizedRows);
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
      await applyImportData(rows, skipped, "auto");
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
    void applyImportData(rows, skipped, "manual");
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

  const saveQA = async (id: string) => {
    const nextQuestion = draftQuestion.trim();
    const nextAnswer = draftAnswer.trim();
    const nextTag = normalizeTag(draftTag);

    if (!nextQuestion || !nextAnswer) {
      setStatusText("題目與答案都需要填寫。");
      setStatusTone("warning");
      return;
    }

    const result = await adminRequest("/api/admin/items/update", {
      id,
      question: nextQuestion,
      answer: nextAnswer,
      tag: nextTag
    });
    if (!result.ok) {
      setStatusText(String(result.data.error || "更新題目失敗。"));
      setStatusTone("warning");
      return;
    }

    const refreshed = await fetchItemsFromServer();
    if (refreshed) {
      setQaData(refreshed);
    } else {
      setQaData((prev) => prev.map((row) => (row.id === id ? ({ ...row, question: nextQuestion, answer: nextAnswer, tag: nextTag }) : row)));
    }

    setEditingRowId(null);
    setDraftQuestion("");
    setDraftAnswer("");
    setDraftTag("");
    setStatusText("題目已更新。");
    setStatusTone("success");
  };

  const addQA = async () => {
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

    const result = await adminRequest("/api/admin/items/create", row);
    if (!result.ok) {
      setStatusText(String(result.data.error || "新增題目失敗。"));
      setStatusTone("warning");
      return;
    }

    const refreshed = await fetchItemsFromServer();
    if (refreshed) {
      setQaData(refreshed);
    } else {
      setQaData((prev) => [row, ...prev]);
    }
    setNewQuestion("");
    setNewAnswer("");
    setNewTag("");
    setStatusText("已新增題目。");
    setStatusTone("success");
  };

  const removeTagFromRow = async (id: string, targetTag: string) => {
    if (!isAdminUnlocked) {
      return;
    }

    const target = qaData.find((row) => row.id === id);
    if (!target) {
      return;
    }
    const nextTag = removeTag(target.tag, targetTag);
    const result = await adminRequest("/api/admin/items/update", {
      id,
      question: target.question,
      answer: target.answer,
      tag: nextTag
    });
    if (!result.ok) {
      setStatusText(String(result.data.error || "移除標記失敗。"));
      setStatusTone("warning");
      return;
    }

    const refreshed = await fetchItemsFromServer();
    if (refreshed) {
      setQaData(refreshed);
    } else {
      setQaData((prev) => prev.map((row) => (row.id === id ? { ...row, tag: nextTag } : row)));
    }
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

  const applyBatchTagToRows = (rows: QAItem[], tagValue: string): { nextRows: QAItem[]; changed: number } => {
    const targetIds = new Set(rows.map((row) => row.id));
    let changed = 0;

    const nextRows = qaData.map((row) => {
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
      });

    return { nextRows, changed };
  };

  const applyQuickBatchTag = async () => {
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

    const { nextRows, changed } = applyBatchTagToRows(displayRows, targetTag);
    if (changed === 0) {
      setStatusText("目前搜尋結果已包含該標記，沒有需要更新的題目。");
      setStatusTone("info");
      return;
    }

    const ok = await replaceAllRowsToServer(nextRows);
    if (!ok) {
      setStatusText("批次補標成功，但同步資料庫失敗。");
      setStatusTone("warning");
      return;
    }
    setQaData(nextRows);
    setStatusText(`已對目前搜尋結果批次追加標記「${targetTag}」，更新 ${changed} 筆。`);
    setStatusTone("success");
  };

  const applyAdvancedBatchTag = async () => {
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

    const { nextRows, changed } = applyBatchTagToRows(advancedMatchedRows, targetTag);
    if (changed === 0) {
      setStatusText("命中資料已包含該標記，沒有需要更新的題目。");
      setStatusTone("info");
      return;
    }

    const ok = await replaceAllRowsToServer(nextRows);
    if (!ok) {
      setStatusText("進階補標成功，但同步資料庫失敗。");
      setStatusTone("warning");
      return;
    }
    setQaData(nextRows);
    setStatusText(`已依進階規則追加標記「${targetTag}」，更新 ${changed} 筆。`);
    setStatusTone("success");
  };

  const applySelectedBigramTag = async () => {
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
    const { nextRows, changed } = applyBatchTagToRows(targetRows, selectedBigram);
    if (changed === 0) {
      setStatusText(`片段「${selectedBigram}」命中的題目都已包含此標記。`);
      setStatusTone("info");
      return;
    }

    const ok = await replaceAllRowsToServer(nextRows);
    if (!ok) {
      setStatusText("片段補標成功，但同步資料庫失敗。");
      setStatusTone("warning");
      return;
    }
    setQaData(nextRows);
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
    const key = await ensureAdminKey();
    if (!key) {
      setStatusText("未輸入 API Key。");
      setStatusTone("info");
      return;
    }

    setAdminReportsLoading(true);
    try {
      const response = await fetch("/api/admin/reports?status=pending", {
        headers: {
          "x-admin-key": key
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
    const key = await ensureAdminKey();
    if (!key) {
      setStatusText("未輸入 API Key，無法處理回報。");
      setStatusTone("info");
      return;
    }

    try {
      const response = await fetch(`/api/admin/reports/${reportId}/${action}`, {
        method: "POST",
        headers: {
          "x-admin-key": key
        }
      });
      const result = (await response.json()) as {
        error?: string;
        report?: {
          itemId?: string | null;
          currentQuestion?: string | null;
          currentAnswer?: string | null;
          suggestedQuestion?: string | null;
          suggestedAnswer?: string | null;
        };
        apply?: {
          applied?: boolean;
          action?: string;
        };
      };
      if (!response.ok) {
        setStatusText(result.error || "處理回報失敗。");
        setStatusTone("warning");
        return;
      }

      if (action === "accept") {
        const rows = await fetchItemsFromServer();
        if (rows) {
          setQaData(rows);
        }
        const apply = result.apply as { applied?: boolean } | undefined;
        setStatusText(apply?.applied ? "回報已採納，並套用到題庫。" : "回報已採納。");
        setStatusTone(apply?.applied ? "success" : "info");
      } else {
        setStatusText("回報已駁回。");
        setStatusTone("success");
      }

      setAdminReports((prev) => prev.filter((report) => report.id !== reportId));
    } catch {
      setStatusText("處理回報失敗。");
      setStatusTone("warning");
    }
  };

  const enterEditMode = async () => {
    const key = await ensureAdminKey();
    if (!key) {
      setStatusText("未輸入 API Key，維持查詢模式。");
      setStatusTone("info");
      return;
    }

    try {
      const response = await fetch("/api/admin/reports?status=pending", {
        headers: {
          "x-admin-key": key
        }
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setStatusText(result.error || "管理 API Key 無效，無法進入編輯模式。");
        setStatusTone("warning");
        return;
      }

      const currentRows = await fetchItemsFromServer();
      if (currentRows && currentRows.length === 0 && qaData.length > 0) {
        const synced = await replaceAllRowsToServer(qaData);
        if (synced) {
          setStatusText(`已初始化資料庫，共 ${qaData.length} 筆。`);
          setStatusTone("success");
        }
      }

      setIsAdminUnlocked(true);
      setViewMode("edit");
      setStatusText("管理員驗證成功，已進入編輯模式。");
      setStatusTone("success");
    } catch {
      setStatusText("驗證失敗，請稍後再試。");
      setStatusTone("warning");
    }
  };

  const deleteRow = async (row: QAItem) => {
    const ok = window.confirm("確定刪除此題？");
    if (!ok) {
      return;
    }

    const result = await adminRequest("/api/admin/items/delete", { id: row.id });
    if (!result.ok) {
      setStatusText(String(result.data.error || "刪除失敗。"));
      setStatusTone("warning");
      return;
    }

    const refreshed = await fetchItemsFromServer();
    if (refreshed) {
      setQaData(refreshed);
    } else {
      setQaData((prev) => prev.filter((item) => item.id !== row.id));
    }
    setStatusText("已刪除題目。");
    setStatusTone("success");
  };

  const resetLocalCacheAndReloadSeed = async () => {
    try {
      const serverRows = await fetchItemsFromServer();
      if (serverRows) {
        setQaData(serverRows);
        setStatusText(`已重新載入 ${serverRows.length} 筆資料。`);
        setStatusTone("success");
        return;
      }

      setStatusText("重新載入失敗，請稍後再試。");
      setStatusTone("warning");
    } catch {
      setStatusText("重新載入失敗，請稍後再試。");
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
      <section className="-mx-4 border-b border-mist-300/80 bg-paper-100/95 px-4 pb-4 pt-4 sm:-mx-6 sm:px-6">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <h1 className="font-title text-lg font-semibold tracking-wide text-ink-900 sm:text-xl">天問大會，你問了嗎</h1>
              <p className="text-xs text-mist-600">Powered by 旅行散仙</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  exportCsv(qaData);
                  setStatusText("已下載 CSV。");
                  setStatusTone("success");
                }}
                disabled={qaData.length === 0}
                className={`${buttonBase} bg-gold-500 text-ink-900 hover:bg-gold-400`}
              >
                下載CSV
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
            className="h-9 rounded-xl border border-mist-500 bg-paper-300 px-3 text-xs text-ink-800 transition hover:border-gold-500 hover:text-ink-900 active:scale-95"
          >
            重新載入
          </button>
        </div>

        <div ref={mobileSearchPanelRef} className="sticky top-2 z-20 rounded-2xl border border-mist-300/90 bg-paper-100/95 p-3 backdrop-blur">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <input
              ref={searchInputRef}
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="快速查詢（可直接輸入或點下方快捷詞）"
              className="h-11 rounded-xl border border-mist-400 bg-paper-200 px-3 text-sm text-ink-900 outline-none ring-gold-500 transition placeholder:text-mist-600 focus:ring-2"
            />
            <div className="flex h-11 items-center rounded-xl border border-mist-300 bg-paper-200 px-3 text-sm text-ink-700">
              共 <span className="mx-1 font-semibold text-ink-900">{displayRows.length}</span> / {qaData.length} 筆
            </div>
            <button
              type="button"
              onClick={() => setSearchKeyword("")}
              className="h-11 rounded-xl border border-mist-500 bg-paper-300 px-3 text-xs text-ink-700 transition hover:border-mist-600 hover:text-ink-900 active:scale-95"
            >
              清除
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-mist-400 bg-paper-200 p-1">
              <button
                type="button"
                onClick={() => setViewMode("query")}
                className={`rounded-md px-2 py-1 text-[11px] transition ${
                  viewMode === "query" ? "bg-gold-500 text-ink-900" : "text-ink-700 hover:text-ink-900"
                }`}
              >
                查詢
              </button>
              <button
                type="button"
                onClick={() => {
                  void enterEditMode();
                }}
                className={`rounded-md px-2 py-1 text-[11px] transition ${
                  viewMode === "edit" ? "bg-gold-500 text-ink-900" : "text-ink-700 hover:text-ink-900"
                }`}
              >
                編輯
              </button>
            </div>
            {viewMode === "query" ? (
              <button
                type="button"
                onClick={() => openReportModal()}
                className="rounded-lg border border-amber-500/40 bg-amber-200/35 px-2.5 py-1 text-[11px] text-amber-900 transition hover:border-amber-500 hover:text-amber-800 active:scale-95"
              >
                新增回報
              </button>
            ) : null}
          </div>

          {isDesktop && middleQuickGroups.length > 0 ? (
            <details className="mt-2 rounded-xl border border-mist-300 bg-paper-200/80 p-2" defaultOpen>
              <summary className="cursor-pointer list-none text-xs font-medium text-ink-700">快捷按鈕</summary>
              <div className="mt-2 grid gap-2">
                {middleQuickGroups.map((group) => (
                  <div key={`middle-${group.title}`} className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-mist-600">{group.title}</span>
                    {group.items.map((keyword) => (
                      <button
                        key={`middle-${group.title}-${keyword.value}`}
                        type="button"
                        onClick={() => setSearchKeyword(keyword.value)}
                        className="h-8 rounded-lg border border-mist-400 bg-paper-200 px-2 text-xs text-ink-800 transition hover:border-gold-500 hover:text-ink-900 active:scale-95"
                      >
                        {keyword.value}
                        <span className="ml-1 text-mist-600">({keyword.count})</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>

        {viewMode === "edit" && isAdminUnlocked ? (
          <div className="rounded-2xl border border-mist-300 bg-paper-200 p-4">
          <h2 className="text-sm font-semibold text-ink-900">新增題目</h2>
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
              className="h-11 min-w-[240px] flex-1 rounded-xl border border-mist-400 bg-paper-300 px-3 text-sm text-ink-900 outline-none ring-gold-500 transition placeholder:text-mist-600 focus:ring-2"
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
              className="h-11 min-w-[200px] flex-1 rounded-xl border border-mist-400 bg-paper-300 px-3 text-sm text-ink-900 outline-none ring-gold-500 transition placeholder:text-mist-600 focus:ring-2"
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
              className="h-11 min-w-[180px] rounded-xl border border-mist-400 bg-paper-300 px-3 text-sm text-ink-900 outline-none ring-gold-500 transition placeholder:text-mist-600 focus:ring-2"
            />
            <button
              type="button"
              onClick={addQA}
              className={`${buttonBase} h-11 shrink-0 bg-emerald-500 text-ink-900 hover:bg-emerald-400 active:scale-95`}
            >
              新增
            </button>
          </div>
          </div>
        ) : null}

        {viewMode === "edit" && isAdminUnlocked ? (
          <details className="rounded-2xl border border-mist-300 bg-paper-200 p-4" defaultOpen={qaData.length === 0}>
          <summary className="cursor-pointer list-none text-sm font-semibold text-ink-900">
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
                <div className="rounded-2xl border border-dashed border-mist-500/70 bg-paper-200 p-4 shadow-glow">
                  <div
                    {...getRootProps()}
                    className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-xl border border-transparent px-4 py-5 text-center transition hover:border-gold-500/60 hover:bg-paper-300"
                  >
                    <p className="text-sm font-medium text-ink-900">拖拉 CSV 到這裡，或點擊選擇檔案</p>
                    <p className="mt-1 text-xs text-mist-600">支援 UTF-8 編碼，欄位可為 question/answer/tag 或自訂名稱</p>
                    {acceptedFile ? <p className="mt-3 text-xs text-gold-500">已選擇：{String(acceptedFile.name ?? "CSV")}</p> : null}
                  </div>

                  {acceptedFile ? (
                    <div className="mt-3 flex justify-end">
                      <button
                        {...getRemoveFileProps()}
                        className={`${buttonBase} border border-mist-500 bg-paper-300 text-ink-800 hover:border-mist-600`}
                      >
                        清除檔案
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </CSVReader>

            {importPreview && columnMap ? (
              <div className="rounded-2xl border border-mist-300 bg-paper-200 p-4">
                <h2 className="text-sm font-semibold text-ink-900">欄位映射確認</h2>
                <p className="mt-1 text-xs text-mist-600">若自動辨識不符合你的檔案格式，可在這裡修正後再匯入。</p>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <label className="grid gap-1 text-sm">
                    <span className="text-ink-700">題目欄位</span>
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
                      className="h-11 rounded-xl border border-mist-400 bg-paper-300 px-3 text-ink-900"
                    >
                      {importPreview.headers.map((header) => (
                        <option key={`question-${header}`} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1 text-sm">
                    <span className="text-ink-700">答案欄位</span>
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
                      className="h-11 rounded-xl border border-mist-400 bg-paper-300 px-3 text-ink-900"
                    >
                      {importPreview.headers.map((header) => (
                        <option key={`answer-${header}`} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1 text-sm">
                    <span className="text-ink-700">標記欄位（可選）</span>
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
                      className="h-11 rounded-xl border border-mist-400 bg-paper-300 px-3 text-ink-900"
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
                    className={`${buttonBase} bg-gold-500 text-ink-900 hover:bg-gold-400`}
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
          <div className="rounded-2xl border border-mist-300 bg-paper-200 px-4 py-12 text-center text-mist-600">
            沒有符合條件的資料，試試不同關鍵字。
          </div>
        ) : null}

        {displayRows.length > 0 ? (
          <>
            <div className="hidden overflow-hidden rounded-2xl border border-mist-300 bg-paper-200 md:block">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-mist-300 bg-paper-300 text-ink-700">
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
                      <tr key={row.id} className="border-b border-mist-300/80 align-top last:border-b-0">
                        <td className="px-4 py-3 text-ink-900">
                          {isEditing ? (
                            <textarea
                              value={draftQuestion}
                              onChange={(event) => setDraftQuestion(event.target.value)}
                              className="min-h-20 w-full rounded-xl border border-mist-400 bg-paper-300 p-2 text-sm outline-none ring-gold-500 focus:ring-2"
                            />
                          ) : row.question ? (
                            row.question
                          ) : (
                            <span className="text-mist-500">(空白)</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-ink-900">
                          {isEditing ? (
                            <textarea
                              value={draftAnswer}
                              onChange={(event) => setDraftAnswer(event.target.value)}
                              className="min-h-24 w-full rounded-xl border border-mist-400 bg-paper-300 p-2 text-sm outline-none ring-gold-500 focus:ring-2"
                            />
                          ) : row.answer ? (
                            row.answer
                          ) : (
                            <span className="text-mist-500">(空白)</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-ink-900">
                          {isEditing ? (
                            <input
                              value={draftTag}
                              onChange={(event) => setDraftTag(event.target.value)}
                              placeholder="例如：對聯|借問"
                              className="h-10 w-full rounded-xl border border-mist-400 bg-paper-300 px-2 text-sm outline-none ring-gold-500 focus:ring-2"
                            />
                          ) : tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {tags.map((tag) => (
                                <span
                                  key={`${row.id}-${tag}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-mist-500 bg-paper-300 px-2 py-1 text-xs text-ink-800"
                                >
                                  {tag}
                                  <button
                                    type="button"
                                    onClick={() => removeTagFromRow(row.id, tag)}
                                    className="rounded px-1 text-mist-600 transition hover:bg-mist-400 hover:text-ink-900"
                                  >
                                    x
                                  </button>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-mist-500">(未標記)</span>
                          )}
                          {viewMode === "query" ? (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => openReportModal(row)}
                                className="rounded-lg border border-amber-500/40 bg-amber-200/35 px-2 py-1 text-xs text-amber-900 transition hover:border-amber-500 hover:text-amber-800"
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
                                className={`${buttonBase} bg-emerald-500 px-3 py-1.5 text-ink-900 hover:bg-emerald-400`}
                                >
                                  儲存
                                </button>
                              <button
                                onClick={cancelEditing}
                                className={`${buttonBase} border border-mist-500 bg-paper-300 px-3 py-1.5 text-ink-800 hover:border-mist-600`}
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                              <div className="flex flex-col gap-2">
                                <button
                                  onClick={() => startEditing(row)}
                                  className={`${buttonBase} border border-mist-500 bg-paper-300 px-3 py-1.5 text-ink-900 hover:border-gold-500 hover:text-ink-900`}
                                >
                                  修改題目/答案
                                </button>
                                <button
                                  onClick={() => deleteRow(row)}
                                  className={`${buttonBase} border border-rose-500/40 bg-rose-200/40 px-3 py-1.5 text-rose-900 hover:border-rose-500 hover:text-rose-800`}
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

            <div className="grid gap-2 md:hidden">
              {displayRows.map((row) => {
                const isEditing = editingRowId === row.id;
                const tags = parseTags(row.tag);

                return (
                  <article key={`card-${row.id}`} className="rounded-xl border border-mist-300 bg-paper-200 p-3">
                    {isEditing ? (
                      <textarea
                        value={draftQuestion}
                        onChange={(event) => setDraftQuestion(event.target.value)}
                        className="qa-mobile-input mt-1 min-h-20 w-full rounded-xl border border-mist-400 bg-paper-300 p-2 text-sm outline-none ring-gold-500 focus:ring-2 max-[430px]:text-[18px] max-[430px]:leading-8"
                      />
                    ) : (
                      <p className="qa-mobile-card-question text-base leading-6 text-ink-900">{row.question || <span className="text-mist-500">(空白)</span>}</p>
                    )}

                    {isEditing ? (
                      <textarea
                        value={draftAnswer}
                        onChange={(event) => setDraftAnswer(event.target.value)}
                        className="qa-mobile-input mt-1 min-h-24 w-full rounded-xl border border-mist-400 bg-paper-300 p-2 text-sm outline-none ring-gold-500 focus:ring-2 max-[430px]:text-[17px] max-[430px]:leading-8"
                      />
                    ) : (
                      <p className="qa-mobile-card-answer mt-1 text-sm leading-6 text-ink-700">{row.answer || <span className="text-mist-500">(空白)</span>}</p>
                    )}

                    {isEditing ? (
                      <input
                        value={draftTag}
                        onChange={(event) => setDraftTag(event.target.value)}
                        placeholder="例如：對聯|借問"
                        className="qa-mobile-input mt-1 h-10 w-full rounded-xl border border-mist-400 bg-paper-300 px-3 text-sm text-ink-900 outline-none ring-gold-500 focus:ring-2"
                      />
                    ) : tags.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {tags.map((tag) => (
                          <span
                            key={`${row.id}-m-${tag}`}
                            className="qa-mobile-tag inline-flex items-center gap-1 rounded-full border border-mist-500 bg-paper-300 px-2 py-1 text-xs text-ink-800"
                          >
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTagFromRow(row.id, tag)}
                              className="rounded px-1 text-mist-600 transition hover:bg-mist-400 hover:text-ink-900"
                            >
                              x
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-mist-500">(未標記)</p>
                    )}
                    {viewMode === "query" ? (
                      <button
                        type="button"
                        onClick={() => openReportModal(row)}
                        className="qa-mobile-action mt-2 rounded-lg border border-amber-500/40 bg-amber-200/35 px-2 py-1 text-xs text-amber-900 transition hover:border-amber-500 hover:text-amber-800"
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
                              className={`${buttonBase} qa-mobile-action flex-1 bg-emerald-500 text-ink-900 hover:bg-emerald-400`}
                            >
                              儲存
                            </button>
                            <button
                              onClick={cancelEditing}
                              className={`${buttonBase} qa-mobile-action flex-1 border border-mist-500 bg-paper-300 text-ink-800 hover:border-mist-600`}
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <div className="grid w-full gap-2">
                            <button
                              onClick={() => startEditing(row)}
                              className={`${buttonBase} qa-mobile-action w-full border border-mist-500 bg-paper-300 text-ink-900 hover:border-gold-500 hover:text-ink-900`}
                            >
                              修改題目/答案
                            </button>
                            <button
                              onClick={() => deleteRow(row)}
                  className={`${buttonBase} qa-mobile-action w-full border border-rose-500/40 bg-rose-200/40 text-rose-900 hover:border-rose-500 hover:text-rose-800`}
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
          <div className="w-full max-w-2xl rounded-2xl border border-mist-300 bg-paper-100 p-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="font-title text-sm font-semibold text-ink-900">匿名回報題庫錯誤</h2>
              <button
                type="button"
                onClick={closeReportModal}
                className="rounded-md border border-mist-400 px-2 py-1 text-xs text-ink-700 hover:text-ink-900"
              >
                關閉
              </button>
            </div>

            <div className="mt-3 grid gap-2">
              <label className="grid gap-1 text-xs">
                <span className="text-mist-600">目前題目</span>
                <textarea
                  value={reportCurrentQuestion}
                  readOnly={Boolean(reportTarget)}
                  onChange={(event) => setReportCurrentQuestion(event.target.value)}
                  placeholder="若非對應當前題目，可自行填寫"
                  className="min-h-16 rounded-lg border border-mist-300 bg-paper-200 p-2 text-ink-800"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-mist-600">目前答案</span>
                <textarea
                  value={reportCurrentAnswer}
                  readOnly={Boolean(reportTarget)}
                  onChange={(event) => setReportCurrentAnswer(event.target.value)}
                  placeholder="若非對應當前題目，可自行填寫"
                  className="min-h-14 rounded-lg border border-mist-300 bg-paper-200 p-2 text-ink-800"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-mist-600">建議題目（可選）</span>
                <input
                  value={reportSuggestedQuestion}
                  onChange={(event) => setReportSuggestedQuestion(event.target.value)}
                  className="h-10 rounded-lg border border-mist-400 bg-paper-200 px-2 text-ink-900"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-mist-600">建議答案（可選）</span>
                <input
                  value={reportSuggestedAnswer}
                  onChange={(event) => setReportSuggestedAnswer(event.target.value)}
                  className="h-10 rounded-lg border border-mist-400 bg-paper-200 px-2 text-ink-900"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-mist-600">備註原因（可選）</span>
                <textarea
                  value={reportNote}
                  onChange={(event) => setReportNote(event.target.value)}
                  className="min-h-16 rounded-lg border border-mist-400 bg-paper-200 p-2 text-ink-900"
                />
              </label>

              {TURNSTILE_SITE_KEY ? (
                <div className="rounded-lg border border-mist-300 bg-paper-200 p-2">
                  <div ref={turnstileContainerRef} />
                </div>
              ) : (
                <label className="grid gap-1 text-xs">
                  <span className="text-amber-300">開發模式：請填 Turnstile token（正式環境請設定 VITE_TURNSTILE_SITE_KEY）</span>
                  <input
                    value={reportTurnstileToken}
                    onChange={(event) => setReportTurnstileToken(event.target.value)}
                    className="h-10 rounded-lg border border-mist-400 bg-paper-200 px-2 text-ink-900"
                  />
                </label>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeReportModal}
                className={`${buttonBase} border border-mist-500 bg-paper-300 text-ink-800 hover:border-mist-600`}
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitReport}
                disabled={reportSubmitting}
                className={`${buttonBase} bg-amber-500 text-ink-900 hover:bg-amber-400`}
              >
                {reportSubmitting ? "送出中..." : "送出回報"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <aside className="fixed bottom-0 left-0 right-0 z-30 border-t border-mist-300/90 bg-paper-100/95 p-3 backdrop-blur lg:hidden">
        <div className="flex w-full flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
            <input
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="查詢關鍵字"
              className="qa-mobile-input h-12 rounded-xl border border-mist-400 bg-paper-200 px-3 text-base text-ink-900 outline-none ring-gold-500 transition placeholder:text-mist-600 focus:ring-2"
            />
            <button
              type="button"
              onClick={() => setSearchKeyword("")}
              className="qa-mobile-action h-12 rounded-xl border border-mist-500 bg-paper-300 px-3 text-sm text-ink-700 transition hover:border-mist-600 hover:text-ink-900 active:scale-95"
            >
              清除
            </button>
            <button
              type="button"
              onClick={() => setMobileQuickDrawerOpen(true)}
              className="qa-mobile-action h-12 rounded-xl border border-gold-500/70 bg-gold-500 px-3 text-sm font-semibold text-ink-900 transition active:scale-95"
            >
              快捷
            </button>
          </div>
        </div>
      </aside>
      {showMobileBackToSearch ? (
        <button
          type="button"
          onClick={() => {
            mobileSearchPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
          }}
          className="fixed bottom-20 right-3 z-40 rounded-full border border-gold-500/70 bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-900 shadow-lg active:scale-95 lg:hidden"
        >
          回到查詢
        </button>
      ) : null}

      {!isDesktop && mobileQuickDrawerOpen ? (
        <>
          <button
            type="button"
            onClick={() => setMobileQuickDrawerOpen(false)}
            className="fixed inset-0 z-40 bg-slate-950/60 lg:hidden"
            aria-label="關閉快捷抽屜遮罩"
          />
          <aside className="fixed right-0 top-0 z-50 h-screen w-[82vw] max-w-xs border-l border-mist-300/90 bg-paper-100 p-3 shadow-2xl lg:hidden">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-ink-900">快捷面板</p>
              <button
                type="button"
                onClick={() => setMobileQuickDrawerOpen(false)}
                className="rounded-md border border-mist-400 px-2 py-1 text-xs text-ink-700"
              >
                關閉
              </button>
            </div>
            <div className="mt-3 grid max-h-[85vh] gap-3 overflow-y-auto pr-1">
              {viewMode === "query" ? (
                <button
                  type="button"
                  onClick={() => {
                    setMobileQuickDrawerOpen(false);
                    openReportModal();
                  }}
                  className="rounded-xl border border-amber-500/40 bg-amber-200/35 px-3 py-2 text-left text-xs text-amber-900"
                >
                  題目不在結果？點這裡新增回報
                </button>
              ) : null}
              {quickKeywordGroups.map((group) => (
                <section key={`mobile-drawer-${group.title}`} className="grid gap-2">
                  <p className="text-xs font-medium tracking-wide text-mist-600">{group.title}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {group.items.map((keyword) => (
                      <button
                        key={`mobile-drawer-${group.title}-${keyword.value}`}
                        type="button"
                        onClick={() => {
                          setSearchKeyword(keyword.value);
                          setMobileQuickDrawerOpen(false);
                        }}
                        className="h-9 rounded-lg border border-mist-400 bg-paper-200 px-2 text-xs text-ink-800"
                      >
                        {keyword.value}
                        <span className="ml-1 text-mist-600">({keyword.count})</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              <DrawerAdSlot />
            </div>
          </aside>
        </>
      ) : null}

      <aside
        className="fixed right-0 top-0 hidden h-screen border-l border-mist-300/90 bg-paper-100/95 p-4 backdrop-blur lg:block"
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
          <p className="text-sm font-semibold tracking-wide text-ink-900">快捷面板</p>
          {viewMode === "query" ? (
            <button
              type="button"
              onClick={() => openReportModal()}
              className="rounded-xl border border-amber-500/40 bg-amber-200/35 px-3 py-2 text-left text-xs text-amber-900 transition hover:border-amber-500 hover:text-amber-800 active:scale-95"
            >
              題目不在結果？點這裡新增回報
            </button>
          ) : null}

          {viewMode === "edit" && isAdminUnlocked ? (
            <div className="grid gap-2 rounded-2xl border border-mist-300 bg-paper-200 p-3">
            <p className="text-xs font-medium tracking-wide text-ink-700">批次補標（目前搜尋結果）</p>
            <select
              value={batchTagPreset}
              onChange={(event) => setBatchTagPreset(event.target.value)}
              className="h-10 rounded-xl border border-mist-400 bg-paper-300 px-2 text-xs text-ink-900"
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
              className="h-10 rounded-xl border border-mist-400 bg-paper-300 px-2 text-xs text-ink-900 outline-none ring-gold-500 focus:ring-2"
            />
            <button
              type="button"
              onClick={applyQuickBatchTag}
              className={`${buttonBase} h-10 bg-emerald-500 text-ink-900 hover:bg-emerald-400 active:scale-95`}
            >
              套用到目前結果 ({displayRows.length})
            </button>

            <div className="mt-1 grid gap-2 rounded-xl border border-mist-300 bg-paper-100 p-2">
              <p className="text-[11px] text-mist-600">進階規則模式</p>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={advancedField}
                  onChange={(event) => setAdvancedField(event.target.value as BatchField)}
                  className="h-9 rounded-lg border border-mist-400 bg-paper-300 px-2 text-xs text-ink-900"
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
                  className="h-9 rounded-lg border border-mist-400 bg-paper-300 px-2 text-xs text-ink-900 outline-none ring-gold-500 focus:ring-2"
                />
              </div>
              <button
                type="button"
                onClick={applyAdvancedBatchTag}
                className={`${buttonBase} h-9 border border-mist-500 bg-paper-300 text-xs text-ink-900 hover:border-gold-500 hover:text-ink-900`}
              >
                套用進階規則 ({advancedMatchedRows.length})
              </button>
            </div>
            </div>
          ) : null}

          {viewMode === "edit" ? (
            <div className="grid gap-2 rounded-2xl border border-mist-300 bg-paper-200 p-3">
              <p className="text-xs font-medium tracking-wide text-ink-700">社群回報待審</p>
              <input
                type="password"
                autoComplete="off"
                value={adminApiKey}
                onChange={(event) => setAdminApiKey(event.target.value)}
                placeholder="管理 API Key"
                className="h-9 rounded-lg border border-mist-400 bg-paper-300 px-2 text-xs text-ink-900 outline-none ring-gold-500 focus:ring-2"
              />
              <button
                type="button"
                onClick={loadAdminReports}
                disabled={adminReportsLoading}
                className={`${buttonBase} h-9 border border-mist-500 bg-paper-300 text-xs text-ink-900 hover:border-gold-500 hover:text-ink-900`}
              >
                {adminReportsLoading ? "載入中..." : `刷新待審 (${adminReports.length})`}
              </button>
              <div className="grid max-h-56 gap-2 overflow-y-auto">
                {adminReports.map((report) => (
                  <div key={`report-${report.id}`} className="rounded-lg border border-mist-300 bg-paper-100 p-2">
                    <p className="line-clamp-2 text-xs text-ink-800">{report.current_question}</p>
                    <p className="mt-1 line-clamp-1 text-[11px] text-mist-600">
                      建議：{report.suggested_question || "(未填)"} / {report.suggested_answer || "(未填)"}
                    </p>
                    {report.note ? <p className="mt-1 line-clamp-2 text-[11px] text-mist-600">備註：{report.note}</p> : null}
                    <div className="mt-2 flex gap-1">
                      <button
                        type="button"
                        onClick={() => resolveReportAction(report.id, "accept")}
                        className="flex-1 rounded-md border border-emerald-500/40 bg-emerald-200/55 px-2 py-1 text-[11px] text-emerald-900"
                      >
                        採納
                      </button>
                      <button
                        type="button"
                        onClick={() => resolveReportAction(report.id, "reject")}
                        className="flex-1 rounded-md border border-rose-500/40 bg-rose-200/45 px-2 py-1 text-[11px] text-rose-900"
                      >
                        駁回
                      </button>
                    </div>
                  </div>
                ))}
                {adminReports.length === 0 ? <p className="text-xs text-mist-500">目前沒有待審回報</p> : null}
              </div>
            </div>
          ) : null}


          <div className="grid gap-2 rounded-2xl border border-mist-300 bg-paper-200 p-3">
            <p className="text-xs font-medium tracking-wide text-ink-700">詩詞2字（重複片段）</p>
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
                      ? "border-gold-500 bg-gold-500/20 text-ink-900"
                      : "border-mist-400 bg-paper-300 text-ink-800 hover:border-gold-500 hover:text-ink-900"
                  }`}
                >
                  {item.token}
                  <span className="ml-1 text-mist-600">({item.count})</span>
                </button>
              ))}
            </div>
            {viewMode === "edit" && isAdminUnlocked ? (
              <button
                type="button"
                onClick={applySelectedBigramTag}
                disabled={!selectedBigram}
                className={`${buttonBase} h-9 border border-mist-500 bg-paper-300 text-xs text-ink-900 hover:border-gold-500 hover:text-ink-900`}
              >
                將「{selectedBigram || "2字片段"}」批次寫入標記
              </button>
            ) : null}
          </div>

          <div className="grid gap-3">
            {sideQuickGroups.map((group) => (
              <section key={group.title} className="grid gap-2">
                <p className="text-xs font-medium tracking-wide text-mist-600">{group.title}</p>
                <div className="grid grid-cols-3 gap-2">
                  {group.items.map((keyword) => (
                    <button
                      key={keyword.value}
                      type="button"
                      onClick={() => setSearchKeyword(keyword.value)}
                      className="h-10 rounded-xl border border-mist-400 bg-paper-200 px-2 text-xs text-ink-800 transition hover:border-gold-500 hover:text-ink-900 active:scale-95"
                    >
                      {keyword.value}
                      <span className="ml-1 text-mist-600">({keyword.count})</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          <DrawerAdSlot />
        </div>
      </aside>
    </main>
  );
}
