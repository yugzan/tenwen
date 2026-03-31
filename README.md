# QA CSV Workbench

純前端題庫搜尋與修改工具，使用 **Vite + React + TypeScript + Tailwind CSS**。

## 功能

- CSV 匯入（react-papaparse 上傳區）
- 即時搜尋（題目 + 答案）
- 原地編輯答案並即時更新 State
- 下載最新 CSV（Blob + URL.createObjectURL）
- localStorage 自動保存，重新整理後可保留資料
- 深色模式、手機優先介面

## 啟動

```bash
npm install
npm run dev
```

開啟 `http://localhost:5173`。

## 社群回報（Vercel API）

已新增匿名回報與待審採納 API（部署到 Vercel 時生效）：

- `POST /api/reports`：匿名送回報（需 Turnstile）
- `GET /api/admin/reports`：管理員查看待審
- `POST /api/admin/reports/:id/accept`：採納回報（可轉草稿）
- `POST /api/admin/reports/:id/reject`：駁回回報

### 必要環境變數

- `POSTGRES_URL`（或 Vercel Postgres/Neon 自帶 DB env）
- `TURNSTILE_SECRET_KEY`（後端驗證）
- `ADMIN_API_KEY`（管理 API 保護）
- `VITE_TURNSTILE_SITE_KEY`（前端 Turnstile widget）

### 初始化資料表

在資料庫執行：

```sql
-- db/reports.sql
CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT,
  current_question TEXT NOT NULL,
  current_answer TEXT NOT NULL,
  suggested_question TEXT,
  suggested_answer TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source_ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
