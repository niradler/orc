# ORC Web Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade React dashboard to manage and operate ORC — tasks, jobs, memories, projects, sessions, knowledge, and settings — with live auto-updating data via React Query.

**Architecture:** Left-sidebar layout with view routing via `useState`, shadcn/ui components throughout, TanStack Query for all API state (polling intervals per resource type), browser-compatible fetch client with proxy to the ORC API at `:7700`.

**Tech Stack:** Vite 6 + React 19 + TypeScript strict, Tailwind CSS v3 with custom ORC theme, shadcn/ui + Radix UI, TanStack Query v5, Lucide React icons, Manrope/Inter/Space Grotesk fonts.

---

## Color Theme (from `.examples/dashboard.html`)

```
Background:        #090e1a   (body, sidebar, header)
Surface low:       #0e1320   (hover states)
Surface:           #131928   (cards, table rows)
Surface high:      #191f2f   (elevated surfaces)
Surface highest:   #1e2537   (active nav, borders)
Surface bright:    #242c3f   (focused states)
Primary (blue):    #78b0ff   (active nav, links, accent)
Secondary (green): #70fda7   (success, done status)
Tertiary (orange): #ffa851   (warnings, high priority)
Error (red):       #ff716c   (errors, blocked, critical)
Text:              #e1e5f6   (main text)
Text muted:        #a6abbb   (secondary text)
Border subtle:     #434856   (dividers)
Border:            #1e2537   (card borders)
```

## File Structure

```
packages/web/
├── package.json                  replace existing — add tailwind, shadcn, react-query
├── tailwind.config.ts            NEW — ORC custom theme with above colors
├── postcss.config.ts             NEW — PostCSS for Tailwind
├── components.json               NEW — shadcn config
├── tsconfig.json                 keep (references app + node)
├── tsconfig.app.json             update — paths alias for @/
├── tsconfig.node.json            keep
├── vite.config.ts                update — add path alias @ → src/
├── index.html                    update — add Google Fonts
└── src/
    ├── main.tsx                  update — wrap with QueryClientProvider
    ├── App.tsx                   rewrite — sidebar layout + view state
    ├── index.css                 rewrite — Tailwind directives + base
    ├── lib/
    │   └── utils.ts              NEW — shadcn cn() helper
    ├── api/
    │   └── client.ts             rewrite — typed API client (all ORC endpoints)
    ├── hooks/
    │   ├── useHealth.ts          NEW — health check, 10s refetch
    │   ├── useTasks.ts           NEW — list/create/update/delete, 30s refetch
    │   ├── useJobs.ts            NEW — list/trigger, 15s refetch
    │   ├── useMemories.ts        NEW — list/search/create/delete, 60s refetch
    │   ├── useProjects.ts        NEW — list/create, 60s refetch
    │   └── useSessions.ts        NEW — list/get, 30s refetch
    ├── components/
    │   ├── ui/                   shadcn generated — button, card, table, badge, etc.
    │   ├── Sidebar.tsx           NEW — left nav with icons + active state
    │   ├── StatusBadge.tsx       NEW — colored badge for task/job status
    │   ├── PriorityBadge.tsx     NEW — colored badge for task priority
    │   ├── ViewHeader.tsx        NEW — page title + optional action slot
    │   ├── StatCard.tsx          NEW — dashboard metric card with border-l accent
    │   ├── EmptyState.tsx        NEW — centered empty message
    │   └── ErrorState.tsx        NEW — error display with retry
    └── views/
        ├── Dashboard.tsx         NEW — stats grid + recent tasks/jobs
        ├── Tasks.tsx             NEW — full CRUD table with inline status change
        ├── Jobs.tsx              NEW — list + trigger run button
        ├── Memories.tsx          NEW — search + list + create/delete
        ├── Projects.tsx          NEW — list + create
        ├── Sessions.tsx          NEW — read-only session history
        ├── Knowledge.tsx         NEW — collections + document search
        └── Settings.tsx          NEW — API URL / secret persisted to localStorage
```

---

## Task 1: Package Scaffold + Tailwind + shadcn Setup

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/tailwind.config.ts`
- Create: `packages/web/postcss.config.ts`
- Modify: `packages/web/tsconfig.app.json`
- Modify: `packages/web/vite.config.ts`
- Modify: `packages/web/index.html`

- [ ] **Step 1: Replace package.json with full dependency set**

```json
{
  "name": "@orc/web",
  "version": "0.1.14",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "^1.1.4",
    "@radix-ui/react-label": "^2.1.1",
    "@radix-ui/react-scroll-area": "^1.2.3",
    "@radix-ui/react-select": "^2.1.4",
    "@radix-ui/react-separator": "^1.1.1",
    "@radix-ui/react-slot": "^1.1.1",
    "@radix-ui/react-tabs": "^1.1.3",
    "@radix-ui/react-tooltip": "^1.1.8",
    "@tanstack/react-query": "^5.0.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.475.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwind-merge": "^2.6.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.5.3",
    "tailwindcss": "^3.4.17",
    "typescript": "^6.0.2",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create `tailwind.config.ts` with ORC theme**

```typescript
import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#090e1a",
        surface: {
          DEFAULT: "#131928",
          low: "#0e1320",
          high: "#191f2f",
          highest: "#1e2537",
          bright: "#242c3f",
        },
        primary: {
          DEFAULT: "#78b0ff",
          container: "#5ba2ff",
          dim: "#549fff",
        },
        secondary: {
          DEFAULT: "#70fda7",
          dim: "#61ee9a",
        },
        tertiary: {
          DEFAULT: "#ffa851",
          dim: "#eb8800",
        },
        "on-surface": "#e1e5f6",
        "on-surface-variant": "#a6abbb",
        "outline-variant": "#434856",
        outline: "#707584",
        error: {
          DEFAULT: "#ff716c",
          container: "#9f0519",
        },
      },
      fontFamily: {
        headline: ["Manrope", "sans-serif"],
        body: ["Inter", "sans-serif"],
        label: ["Space Grotesk", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "0.125rem",
        sm: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 3: Create `postcss.config.ts`**

```typescript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 4: Update `tsconfig.app.json` to add path alias**

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Update `vite.config.ts` to add path alias**

```typescript
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:7700",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
```

- [ ] **Step 6: Update `index.html` with Google Fonts**

```html
<!doctype html>
<html class="dark" lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ORC — Agent Orchestration</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@700;800&family=Space+Grotesk:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
  </head>
  <body class="bg-background text-on-surface font-body">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Replace `src/index.css` with Tailwind directives**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  * {
    @apply border-outline-variant;
  }

  body {
    @apply bg-background text-on-surface font-body;
    -webkit-font-smoothing: antialiased;
  }

  ::-webkit-scrollbar {
    width: 4px;
    height: 4px;
  }
  ::-webkit-scrollbar-track {
    background: #090e1a;
  }
  ::-webkit-scrollbar-thumb {
    background: #1e2537;
    border-radius: 10px;
  }
}
```

- [ ] **Step 8: Install dependencies**

```bash
cd packages/web && bun install
```

Expected: all packages resolve, no errors.

- [ ] **Step 9: Verify dev server starts**

```bash
bun run dev
```

Expected: Vite starts on port 5173, blank white/dark page loads.

---

## Task 2: shadcn Utilities + Core UI Components

**Files:**
- Create: `packages/web/src/lib/utils.ts`
- Create: `packages/web/src/components/ui/button.tsx`
- Create: `packages/web/src/components/ui/badge.tsx`
- Create: `packages/web/src/components/ui/card.tsx`
- Create: `packages/web/src/components/ui/dialog.tsx`
- Create: `packages/web/src/components/ui/input.tsx`
- Create: `packages/web/src/components/ui/label.tsx`
- Create: `packages/web/src/components/ui/select.tsx`
- Create: `packages/web/src/components/ui/table.tsx`
- Create: `packages/web/src/components/ui/tabs.tsx`
- Create: `packages/web/src/components/ui/textarea.tsx`
- Create: `packages/web/src/components/ui/skeleton.tsx`
- Create: `packages/web/src/components/ui/separator.tsx`
- Create: `packages/web/src/components/ui/scroll-area.tsx`
- Create: `packages/web/src/components/ui/tooltip.tsx`

- [ ] **Step 1: Create `src/lib/utils.ts`**

```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Initialize shadcn components.json**

Create `packages/web/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": false
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

- [ ] **Step 3: Add shadcn components via CLI**

Run from `packages/web/`:

```bash
cd packages/web
bunx shadcn@latest add button badge card dialog input label select table tabs textarea skeleton separator scroll-area tooltip
```

Expected: files created in `src/components/ui/`. Biome may format them.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd packages/web && bun run typecheck
```

Expected: 0 errors.

---

## Task 3: API Client

**Files:**
- Modify: `packages/web/src/api/client.ts`

- [ ] **Step 1: Rewrite `src/api/client.ts` with all ORC endpoints**

```typescript
// Browser-compatible ORC API client.
// Dev: Vite proxies /api/* → http://localhost:7700/*
// Override via localStorage: orc_api_url, orc_api_secret

export const getApiUrl = (): string =>
  localStorage.getItem("orc_api_url") ?? "/api";

export const getApiSecret = (): string =>
  localStorage.getItem("orc_api_secret") ?? "";

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  let url = `${getApiUrl()}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const q = params.toString();
    if (q) url += `?${q}`;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = getApiSecret();
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null as T;
  const json = (await res.json()) as unknown;
  if (!res.ok) {
    const e = json as { error?: string };
    throw new Error(e.error ?? `HTTP ${res.status}`);
  }
  return json as T;
}

// ---- Types ----

export type TaskStatus =
  | "todo" | "queued" | "doing" | "review"
  | "changes_requested" | "blocked" | "done" | "cancelled" | "paused";

export type TaskPriority = "low" | "normal" | "high" | "critical";

export type Task = {
  id: string;
  project_id: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  due_at: string | null;
  tags: string[] | null;
  author: string;
  claimed_by: string | null;
  skill_name: string | null;
  created_at: string;
  updated_at: string;
};

export type Memory = {
  id: string;
  project_id: string | null;
  content: string;
  source: string | null;
  scope: string | null;
  tags: string[] | null;
  importance: "low" | "normal" | "high" | "critical";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Job = {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  command: string;
  trigger_type: string;
  cron_expr: string | null;
  enabled: boolean;
  timeout_secs: number;
  max_retries: number;
  overlap: "skip" | "queue" | "kill";
  notify_on: string;
  run_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export type JobRun = {
  id: string;
  job_id: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled" | "skipped";
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
};

export type Session = {
  id: string;
  agent: string | null;
  job_run_id: string | null;
  agent_version: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
};

export type KnowledgeCollection = {
  name: string;
  path: string;
  pattern: string;
  documentCount: number;
  lastModified: string | null;
  projectId: string | null;
};

export type HealthResponse = {
  status: string;
  version: string;
  uptime: number;
};

// ---- API client ----

export const api = {
  health: {
    check: () => req<HealthResponse>("GET", "/health"),
  },

  tasks: {
    list: (params?: { status?: string; project_id?: string; limit?: number }) =>
      req<{ tasks: Task[]; total: number }>(
        "GET", "/tasks", undefined,
        params as Record<string, string | undefined>,
      ),
    create: (data: {
      title: string;
      body?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      project_id?: string;
    }) => req<Task>("POST", "/tasks", data),
    update: (id: string, data: Partial<Pick<Task, "status" | "priority" | "title" | "body">>) =>
      req<Task>("PATCH", `/tasks/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/tasks/${id}`),
    addComment: (id: string, content: string, author = "human") =>
      req<{ id: string; content: string; author: string; created_at: string }>(
        "POST", `/tasks/${id}/comments`, { content, author },
      ),
  },

  memories: {
    list: (params?: { scope?: string; project_id?: string; limit?: number }) =>
      req<{ memories: Memory[] }>(
        "GET", "/memories", undefined,
        params as Record<string, string | undefined>,
      ),
    search: (q: string, opts?: { scope?: string; limit?: number }) =>
      req<{ results: Memory[] }>("GET", "/memories/search", undefined, {
        q,
        scope: opts?.scope,
        limit: opts?.limit,
      }),
    create: (data: { content: string; scope?: string; tags?: string[]; importance?: string }) =>
      req<Memory>("POST", "/memories", data),
    update: (id: string, data: Partial<Pick<Memory, "content" | "scope" | "tags" | "importance">>) =>
      req<Memory>("PATCH", `/memories/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/memories/${id}`),
  },

  jobs: {
    list: (params?: { enabled?: boolean; project_id?: string }) =>
      req<{ jobs: Job[] }>(
        "GET", "/jobs", undefined,
        params as Record<string, string | undefined>,
      ),
    trigger: (id: string) => req<{ run_id: string }>("POST", `/jobs/${id}/trigger`),
    runs: (id: string, limit = 10) =>
      req<{ runs: JobRun[] }>("GET", `/jobs/${id}/runs`, undefined, { limit }),
  },

  projects: {
    list: (params?: { status?: string }) =>
      req<{ projects: Project[] }>(
        "GET", "/projects", undefined,
        params as Record<string, string | undefined>,
      ),
    get: (id: string) => req<Project>("GET", `/projects/${id}`),
    create: (data: { name: string; description?: string }) =>
      req<Project>("POST", "/projects", data),
    delete: (id: string) => req<null>("DELETE", `/projects/${id}`),
  },

  sessions: {
    list: (params?: { agent?: string; limit?: number }) =>
      req<{ sessions: Session[] }>(
        "GET", "/sessions", undefined,
        params as Record<string, string | undefined>,
      ),
    get: (id: string) =>
      req<Session & { events: unknown[]; snapshot: string | null }>("GET", `/sessions/${id}`),
  },

  knowledge: {
    collections: () =>
      req<{ collections: KnowledgeCollection[] }>("GET", "/knowledge/collections"),
    search: (q: string, opts?: { collection?: string; limit?: number }) =>
      req<{
        results: { docid: string; path: string; collection: string; title: string; snippet: string; score: number }[];
      }>("GET", "/knowledge/search", undefined, { q, collection: opts?.collection, limit: opts?.limit }),
    update: () =>
      req<{ indexed: number; updated: number; removed: number }>("POST", "/knowledge/update", {}),
  },
};
```

- [ ] **Step 2: Verify TypeScript sees no errors**

```bash
cd packages/web && bun run typecheck
```

Expected: 0 errors.

---

## Task 4: React Query Hooks

**Files:**
- Modify: `packages/web/src/main.tsx`
- Create: `packages/web/src/hooks/useHealth.ts`
- Create: `packages/web/src/hooks/useTasks.ts`
- Create: `packages/web/src/hooks/useJobs.ts`
- Create: `packages/web/src/hooks/useMemories.ts`
- Create: `packages/web/src/hooks/useProjects.ts`
- Create: `packages/web/src/hooks/useSessions.ts`

- [ ] **Step 1: Update `src/main.tsx` to wrap with QueryClientProvider**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("No root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 2: Create `src/hooks/useHealth.ts`**

```typescript
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.health.check(),
    refetchInterval: 10_000,
    retry: false,
  });
}
```

- [ ] **Step 3: Create `src/hooks/useTasks.ts`**

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Task, type TaskPriority, type TaskStatus } from "@/api/client";

export function useTasks(params?: { status?: string; project_id?: string }) {
  return useQuery({
    queryKey: ["tasks", params],
    queryFn: () => api.tasks.list({ ...params, limit: 200 }),
    refetchInterval: 30_000,
    select: (data) => data.tasks,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      body?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      project_id?: string;
    }) => api.tasks.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Pick<Task, "status" | "priority" | "title" | "body">>) =>
      api.tasks.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.tasks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}
```

- [ ] **Step 4: Create `src/hooks/useJobs.ts`**

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.jobs.list(),
    refetchInterval: 15_000,
    select: (data) => data.jobs,
  });
}

export function useTriggerJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.jobs.trigger(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useJobRuns(jobId: string) {
  return useQuery({
    queryKey: ["job-runs", jobId],
    queryFn: () => api.jobs.runs(jobId),
    refetchInterval: 5_000,
    select: (data) => data.runs,
    enabled: Boolean(jobId),
  });
}
```

- [ ] **Step 5: Create `src/hooks/useMemories.ts`**

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useMemories(params?: { scope?: string; project_id?: string }) {
  return useQuery({
    queryKey: ["memories", params],
    queryFn: () => api.memories.list({ ...params, limit: 100 }),
    refetchInterval: 60_000,
    select: (data) => data.memories,
  });
}

export function useMemorySearch(q: string) {
  return useQuery({
    queryKey: ["memories-search", q],
    queryFn: () => api.memories.search(q),
    enabled: q.trim().length > 0,
    select: (data) => data.results,
  });
}

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { content: string; scope?: string; tags?: string[]; importance?: string }) =>
      api.memories.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.memories.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}
```

- [ ] **Step 6: Create `src/hooks/useProjects.ts`**

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects.list(),
    refetchInterval: 60_000,
    select: (data) => data.projects,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      api.projects.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
```

- [ ] **Step 7: Create `src/hooks/useSessions.ts`**

```typescript
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useSessions(params?: { agent?: string; limit?: number }) {
  return useQuery({
    queryKey: ["sessions", params],
    queryFn: () => api.sessions.list({ ...params, limit: params?.limit ?? 50 }),
    refetchInterval: 30_000,
    select: (data) => data.sessions,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => api.sessions.get(id),
    enabled: Boolean(id),
  });
}
```

- [ ] **Step 8: Verify TypeScript**

```bash
cd packages/web && bun run typecheck
```

Expected: 0 errors.

---

## Task 5: Shared Display Components

**Files:**
- Create: `packages/web/src/components/StatusBadge.tsx`
- Create: `packages/web/src/components/PriorityBadge.tsx`
- Create: `packages/web/src/components/ViewHeader.tsx`
- Create: `packages/web/src/components/StatCard.tsx`
- Create: `packages/web/src/components/EmptyState.tsx`
- Create: `packages/web/src/components/ErrorState.tsx`

- [ ] **Step 1: Create `src/components/StatusBadge.tsx`**

```tsx
import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/api/client";

type JobStatus = "pending" | "running" | "success" | "failed" | "cancelled" | "skipped";

const TASK_COLORS: Record<TaskStatus, string> = {
  todo: "bg-surface-highest text-on-surface-variant border-outline-variant",
  queued: "bg-primary/10 text-primary border-primary/30",
  doing: "bg-primary/15 text-primary border-primary/40",
  review: "bg-tertiary/15 text-tertiary border-tertiary/40",
  changes_requested: "bg-tertiary/10 text-tertiary border-tertiary/30",
  blocked: "bg-error/15 text-error border-error/40",
  done: "bg-secondary/15 text-secondary border-secondary/40",
  cancelled: "bg-surface-highest text-outline border-outline-variant",
  paused: "bg-surface-highest text-on-surface-variant border-outline-variant",
};

const JOB_COLORS: Record<JobStatus, string> = {
  pending: "bg-surface-highest text-on-surface-variant border-outline-variant",
  running: "bg-primary/15 text-primary border-primary/40",
  success: "bg-secondary/15 text-secondary border-secondary/40",
  failed: "bg-error/15 text-error border-error/40",
  cancelled: "bg-surface-highest text-outline border-outline-variant",
  skipped: "bg-surface-highest text-outline border-outline-variant",
};

interface StatusBadgeProps {
  status: TaskStatus | JobStatus;
  type?: "task" | "job";
  className?: string;
}

export function StatusBadge({ status, type = "task", className }: StatusBadgeProps) {
  const colors =
    type === "job"
      ? (JOB_COLORS[status as JobStatus] ?? "bg-surface-highest text-on-surface-variant")
      : (TASK_COLORS[status as TaskStatus] ?? "bg-surface-highest text-on-surface-variant");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-label font-semibold uppercase tracking-wider border",
        colors,
        className,
      )}
    >
      <span className="w-1.5 h-1.5 rounded-sm bg-current opacity-70 flex-shrink-0" />
      {status.replace("_", " ")}
    </span>
  );
}
```

- [ ] **Step 2: Create `src/components/PriorityBadge.tsx`**

```tsx
import { cn } from "@/lib/utils";
import type { TaskPriority } from "@/api/client";

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  critical: "text-error font-bold",
  high: "text-tertiary font-semibold",
  normal: "text-on-surface-variant",
  low: "text-outline",
};

export function PriorityBadge({ priority, className }: { priority: TaskPriority; className?: string }) {
  return (
    <span className={cn("font-label text-xs uppercase tracking-wide", PRIORITY_COLORS[priority], className)}>
      {priority}
    </span>
  );
}
```

- [ ] **Step 3: Create `src/components/ViewHeader.tsx`**

```tsx
import type { ReactNode } from "react";

interface ViewHeaderProps {
  title: string;
  action?: ReactNode;
  meta?: ReactNode;
}

export function ViewHeader({ title, action, meta }: ViewHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-4">
        <h1 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface">
          {title}
        </h1>
        {meta && <span className="font-label text-[10px] text-outline uppercase tracking-widest">{meta}</span>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Create `src/components/StatCard.tsx`**

```tsx
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Accent = "primary" | "secondary" | "tertiary" | "error" | "muted";

const ACCENT_COLORS: Record<Accent, string> = {
  primary: "border-l-primary",
  secondary: "border-l-secondary",
  tertiary: "border-l-tertiary",
  error: "border-l-error",
  muted: "border-l-outline-variant",
};

const VALUE_COLORS: Record<Accent, string> = {
  primary: "text-primary terminal-glow",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
  error: "text-error",
  muted: "text-on-surface-variant",
};

interface StatCardProps {
  label: string;
  value: ReactNode;
  accent?: Accent;
  sub?: string;
  onClick?: () => void;
}

export function StatCard({ label, value, accent = "muted", sub, onClick }: StatCardProps) {
  return (
    <div
      className={cn(
        "bg-surface-low p-4 rounded-sm border-l-2 relative overflow-hidden",
        ACCENT_COLORS[accent],
        onClick && "cursor-pointer hover:bg-surface transition-colors",
      )}
      onClick={onClick}
    >
      <div className="flex justify-between items-start mb-2">
        <span className="font-label text-[10px] text-outline uppercase tracking-widest">{label}</span>
      </div>
      <div className={cn("text-2xl font-headline font-extrabold uppercase", VALUE_COLORS[accent])}>
        {value}
      </div>
      {sub && (
        <div className="font-label text-[10px] text-outline mt-1">{sub}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create `src/components/EmptyState.tsx`**

```tsx
export function EmptyState({ message = "No data" }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-outline font-label text-xs uppercase tracking-widest">
      {message}
    </div>
  );
}
```

- [ ] **Step 6: Create `src/components/ErrorState.tsx`**

```tsx
import { Button } from "@/components/ui/button";

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <p className="text-error font-label text-xs uppercase tracking-widest">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="text-xs">
          RETRY
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Verify TypeScript**

```bash
cd packages/web && bun run typecheck
```

Expected: 0 errors.

---

## Task 6: App Layout + Sidebar Navigation

**Files:**
- Rewrite: `packages/web/src/App.tsx`
- Create: `packages/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Create `src/components/Sidebar.tsx`**

```tsx
import {
  Activity,
  BookOpen,
  Brain,
  Folder,
  History,
  Settings,
  TerminalSquare,
  CheckSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useHealth } from "@/hooks/useHealth";
import type { View } from "@/App";

const NAV_ITEMS: { id: View; label: string; icon: React.ElementType }[] = [
  { id: "dashboard", label: "Dashboard", icon: Activity },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "jobs", label: "Jobs", icon: TerminalSquare },
  { id: "memories", label: "Memories", icon: Brain },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "sessions", label: "Sessions", icon: History },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
];

interface SidebarProps {
  active: View;
  onNavigate: (view: View) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  const { data: health, isError } = useHealth();

  return (
    <aside className="flex flex-col h-full w-64 fixed left-0 top-0 bg-background border-r border-surface-highest z-50 py-6">
      {/* Brand */}
      <div className="px-6 mb-10">
        <div className="font-headline font-black text-xl tracking-wider text-primary terminal-glow">
          ◈ ORC
        </div>
        <div className="font-label text-[10px] tracking-widest text-outline uppercase mt-1">
          Agent Orchestration
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-0.5">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 font-label text-xs tracking-tight uppercase transition-all duration-150",
              active === id
                ? "bg-surface-highest text-primary font-bold border-r-2 border-primary translate-x-0.5"
                : "text-outline hover:text-on-surface-variant hover:bg-surface-highest/50",
            )}
          >
            <Icon size={16} strokeWidth={active === id ? 2.5 : 1.5} />
            {label}
          </button>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-3 mt-auto space-y-3">
        <div className="pt-4 border-t border-surface-highest">
          <button
            onClick={() => onNavigate("settings")}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 font-label text-xs tracking-tight uppercase transition-all",
              active === "settings"
                ? "text-primary font-bold"
                : "text-outline hover:text-on-surface-variant",
            )}
          >
            <Settings size={16} />
            Settings
          </button>
        </div>
        <div className="px-3 py-2 flex items-center gap-2">
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              isError ? "bg-error" : "bg-secondary animate-pulse",
            )}
          />
          <span className="font-label text-[9px] text-outline uppercase tracking-widest">
            {isError ? "OFFLINE" : health ? `v${health.version}` : "CONNECTING..."}
          </span>
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Rewrite `src/App.tsx`**

```tsx
import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import Dashboard from "@/views/Dashboard";
import Jobs from "@/views/Jobs";
import Knowledge from "@/views/Knowledge";
import Memories from "@/views/Memories";
import Projects from "@/views/Projects";
import Sessions from "@/views/Sessions";
import Settings from "@/views/Settings";
import Tasks from "@/views/Tasks";

export type View =
  | "dashboard"
  | "tasks"
  | "jobs"
  | "memories"
  | "projects"
  | "sessions"
  | "knowledge"
  | "settings";

export default function App() {
  const [view, setView] = useState<View>("tasks");

  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar active={view} onNavigate={setView} />
      <main className="ml-64 flex-1 overflow-y-auto">
        <div className="p-8 max-w-[1200px]">
          {view === "dashboard" && <Dashboard onNavigate={setView} />}
          {view === "tasks" && <Tasks />}
          {view === "jobs" && <Jobs />}
          {view === "memories" && <Memories />}
          {view === "projects" && <Projects />}
          {view === "sessions" && <Sessions />}
          {view === "knowledge" && <Knowledge />}
          {view === "settings" && <Settings />}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Add `terminal-glow` utility to `index.css`**

Append to the `@layer utilities` block in `src/index.css`:

```css
@layer utilities {
  .terminal-glow {
    text-shadow: 0 0 8px rgba(120, 176, 255, 0.4);
  }
}
```

- [ ] **Step 4: Start dev server and verify sidebar renders**

```bash
bun run dev
```

Expected: left sidebar with ◈ ORC title + nav items visible. Main area blank.

---

## Task 7: Dashboard View

**Files:**
- Rewrite: `packages/web/src/views/Dashboard.tsx`

- [ ] **Step 1: Write `src/views/Dashboard.tsx`**

```tsx
import { useTasks } from "@/hooks/useTasks";
import { useJobs } from "@/hooks/useJobs";
import { useMemories } from "@/hooks/useMemories";
import { useProjects } from "@/hooks/useProjects";
import { StatCard } from "@/components/StatCard";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge } from "@/components/PriorityBadge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { View } from "@/App";

interface DashboardProps {
  onNavigate: (view: View) => void;
}

export default function Dashboard({ onNavigate }: DashboardProps) {
  const { data: tasks, isLoading: tasksLoading } = useTasks();
  const { data: jobs } = useJobs();
  const { data: memories } = useMemories();
  const { data: projects } = useProjects();

  const byStatus = (tasks ?? []).reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; },
    {} as Record<string, number>,
  );

  const recent = [...(tasks ?? [])]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 8);

  return (
    <div>
      <ViewHeader title="Dashboard" />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatCard
          label="Doing"
          value={byStatus["doing"] ?? 0}
          accent="primary"
          sub="in progress"
          onClick={() => onNavigate("tasks")}
        />
        <StatCard
          label="Review"
          value={byStatus["review"] ?? 0}
          accent="tertiary"
          sub="awaiting review"
          onClick={() => onNavigate("tasks")}
        />
        <StatCard
          label="Blocked"
          value={byStatus["blocked"] ?? 0}
          accent="error"
          sub="needs attention"
          onClick={() => onNavigate("tasks")}
        />
        <StatCard
          label="Todo"
          value={byStatus["todo"] ?? 0}
          accent="muted"
          sub="queued"
          onClick={() => onNavigate("tasks")}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
        <StatCard
          label="Done"
          value={byStatus["done"] ?? 0}
          accent="secondary"
          sub="completed"
        />
        <StatCard
          label="Active Jobs"
          value={(jobs ?? []).filter((j) => j.enabled).length}
          accent="primary"
          sub={`of ${(jobs ?? []).length} total`}
          onClick={() => onNavigate("jobs")}
        />
        <StatCard
          label="Memories"
          value={memories?.length ?? 0}
          accent="muted"
          onClick={() => onNavigate("memories")}
        />
      </div>

      {/* Recent Tasks */}
      <div className="mb-8">
        <div className="flex justify-between items-center px-1 mb-3">
          <h2 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface">
            Recent Tasks
          </h2>
          <button
            onClick={() => onNavigate("tasks")}
            className="font-label text-[10px] text-primary hover:underline uppercase tracking-widest"
          >
            View all →
          </button>
        </div>
        {tasksLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
          </div>
        ) : (
          <div className="border border-surface-highest rounded-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-surface-highest hover:bg-transparent">
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Title</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-32">Status</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Priority</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((task) => (
                  <TableRow key={task.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                    <TableCell className="font-body text-xs text-on-surface truncate max-w-xs">{task.title}</TableCell>
                    <TableCell><StatusBadge status={task.status} /></TableCell>
                    <TableCell><PriorityBadge priority={task.priority} /></TableCell>
                    <TableCell className="font-label text-[10px] text-outline">
                      {new Date(task.updated_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Projects summary */}
      {(projects ?? []).length > 0 && (
        <div>
          <h2 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface mb-3 px-1">
            Projects
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {(projects ?? []).slice(0, 6).map((p) => (
              <div
                key={p.id}
                className="bg-surface-high p-4 rounded-sm border border-surface-highest hover:bg-surface-bright transition-colors cursor-pointer"
                onClick={() => onNavigate("projects")}
              >
                <div className="font-label text-xs font-semibold text-on-surface truncate">{p.name}</div>
                {p.description && (
                  <div className="font-body text-[10px] text-outline mt-1 truncate">{p.description}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify in browser**

Navigate to Dashboard. Expected: stat cards with real counts, recent tasks table populating from API.

---

## Task 8: Tasks View

**Files:**
- Rewrite: `packages/web/src/views/Tasks.tsx`

- [ ] **Step 1: Write `src/views/Tasks.tsx`**

```tsx
import { useState } from "react";
import { useTasks, useCreateTask, useUpdateTask, useDeleteTask } from "@/hooks/useTasks";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge } from "@/components/PriorityBadge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2 } from "lucide-react";
import type { TaskPriority, TaskStatus } from "@/api/client";

const STATUS_TABS: Array<{ value: TaskStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "doing", label: "Doing" },
  { value: "review", label: "Review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

const ALL_STATUSES: TaskStatus[] = [
  "todo", "queued", "doing", "review", "changes_requested", "blocked", "done", "cancelled", "paused",
];

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "critical"];

export default function Tasks() {
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [creating, setCreating] = useState(false);

  const { data: allTasks, isLoading, error, refetch } = useTasks();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const visible =
    filter === "all" ? (allTasks ?? []) : (allTasks ?? []).filter((t) => t.status === filter);

  const counts = (allTasks ?? []).reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; },
    {} as Record<string, number>,
  );

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Tasks"
        meta={`${(allTasks ?? []).length} total`}
        action={
          <Button size="sm" onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20">
            + New Task
          </Button>
        }
      />

      <Tabs value={filter} onValueChange={(v) => setFilter(v as TaskStatus | "all")} className="mb-4">
        <TabsList className="bg-surface-highest border border-surface-highest gap-0 h-auto p-0">
          {STATUS_TABS.map(({ value, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="font-label text-[10px] uppercase tracking-widest px-4 py-2 rounded-none
                data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
                text-outline hover:text-on-surface-variant"
            >
              {label}
              {value !== "all" && counts[value] != null && (
                <span className="ml-1.5 text-[9px] bg-surface-highest px-1.5 py-0.5 rounded-sm">
                  {counts[value]}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="No tasks" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">ID</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Title</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-40">Status</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Priority</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Author</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Updated</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((task) => (
                <TableRow key={task.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                  <TableCell className="font-label text-[10px] text-outline">{task.id.slice(-6)}</TableCell>
                  <TableCell className="font-body text-xs text-on-surface max-w-xs truncate">{task.title}</TableCell>
                  <TableCell>
                    <Select
                      value={task.status}
                      onValueChange={(v) => updateTask.mutate({ id: task.id, status: v as TaskStatus })}
                    >
                      <SelectTrigger className="h-6 w-auto border-0 bg-transparent p-0 focus:ring-0 gap-1">
                        <SelectValue>
                          <StatusBadge status={task.status} />
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="bg-surface-highest border-surface-highest">
                        {ALL_STATUSES.map((s) => (
                          <SelectItem key={s} value={s} className="font-label text-xs uppercase">
                            {s.replace("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell><PriorityBadge priority={task.priority} /></TableCell>
                  <TableCell className="font-label text-[10px] text-outline">{task.author}</TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(task.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => deleteTask.mutate(task.id)}
                      className="text-outline hover:text-error transition-colors p-1"
                    >
                      <Trash2 size={12} />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateTaskDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CreateTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [status, setStatus] = useState<TaskStatus>("todo");

  const createTask = useCreateTask();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    createTask.mutate(
      { title: title.trim(), body: body.trim() || undefined, priority, status },
      { onSuccess: () => { setTitle(""); setBody(""); onClose(); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Task
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Title *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Body</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Optional description..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {ALL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="font-label text-xs">{s.replace("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p} className="font-label text-xs">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}
              className="font-label text-xs uppercase text-outline">Cancel</Button>
            <Button type="submit" size="sm" disabled={createTask.isPending || !title.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25">
              {createTask.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify in browser**

Navigate to Tasks. Expected: tab filters work, status select updates live, new task dialog creates and appears in list.

---

## Task 9: Jobs View

**Files:**
- Rewrite: `packages/web/src/views/Jobs.tsx`

- [ ] **Step 1: Write `src/views/Jobs.tsx`**

```tsx
import { useState } from "react";
import { Play, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useJobs, useTriggerJob, useJobRuns } from "@/hooks/useJobs";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function Jobs() {
  const { data: jobs, isLoading, error, refetch } = useJobs();
  const triggerJob = useTriggerJob();
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  const enabledCount = (jobs ?? []).filter((j) => j.enabled).length;

  return (
    <div>
      <ViewHeader
        title="Jobs"
        meta={`${enabledCount}/${(jobs ?? []).length} enabled`}
        action={
          <Button variant="ghost" size="sm" onClick={() => refetch()}
            className="font-label text-[10px] uppercase tracking-widest text-outline">
            <RefreshCw size={12} className="mr-1" /> Refresh
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full bg-surface-highest" />)}
        </div>
      ) : (jobs ?? []).length === 0 ? (
        <EmptyState message="No jobs configured" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Name</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Type</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Schedule</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-20">Status</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">Runs</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Last Run</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobs ?? []).map((job) => (
                <>
                  <TableRow
                    key={job.id}
                    className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                    onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
                  >
                    <TableCell>
                      <div className="font-body text-xs font-medium text-on-surface">{job.name}</div>
                      {job.description && (
                        <div className="font-body text-[10px] text-outline mt-0.5">{job.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="font-label text-[10px] text-outline uppercase">{job.trigger_type}</TableCell>
                    <TableCell className="font-label text-[10px] text-outline font-mono">
                      {job.cron_expr ?? "—"}
                    </TableCell>
                    <TableCell>
                      <span className={cn(
                        "font-label text-[10px] font-bold uppercase",
                        job.enabled ? "text-secondary" : "text-outline",
                      )}>
                        {job.enabled ? "● ON" : "○ OFF"}
                      </span>
                    </TableCell>
                    <TableCell className="font-label text-[10px] text-outline">{job.run_count}</TableCell>
                    <TableCell className="font-label text-[10px] text-outline">
                      {job.last_run_at ? new Date(job.last_run_at).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="sm"
                          disabled={triggerJob.isPending && triggerJob.variables === job.id}
                          onClick={() => triggerJob.mutate(job.id)}
                          className="font-label text-[10px] uppercase h-7 px-3 bg-secondary/10 text-secondary border border-secondary/30 hover:bg-secondary/20"
                        >
                          <Play size={10} className="mr-1" />
                          {triggerJob.isPending && triggerJob.variables === job.id ? "..." : "Run"}
                        </Button>
                        {expandedJob === job.id ? <ChevronUp size={14} className="text-outline" /> : <ChevronDown size={14} className="text-outline" />}
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedJob === job.id && (
                    <TableRow key={`${job.id}-runs`} className="border-b border-surface-highest/50 bg-surface-low">
                      <TableCell colSpan={7} className="p-0">
                        <JobRunsExpanded jobId={job.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function JobRunsExpanded({ jobId }: { jobId: string }) {
  const { data: runs, isLoading } = useJobRuns(jobId);

  if (isLoading) return (
    <div className="px-6 py-3">
      <Skeleton className="h-6 w-full bg-surface-highest" />
    </div>
  );

  if (!runs?.length) return (
    <div className="px-6 py-3 font-label text-[10px] text-outline uppercase">No runs yet</div>
  );

  return (
    <div className="px-6 py-3 space-y-2">
      <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-2">Recent Runs</div>
      {runs.map((run) => (
        <div key={run.id} className="flex items-center gap-4 font-label text-[10px]">
          <StatusBadge status={run.status} type="job" />
          <span className="text-outline">{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</span>
          {run.error && <span className="text-error truncate max-w-xs">{run.error}</span>}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify in browser**

Navigate to Jobs. Expected: job list with run button, expand row shows recent run history.

---

## Task 10: Memories View

**Files:**
- Rewrite: `packages/web/src/views/Memories.tsx`

- [ ] **Step 1: Write `src/views/Memories.tsx`**

```tsx
import { useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import { useMemories, useMemorySearch, useCreateMemory, useDeleteMemory } from "@/hooks/useMemories";
import { ViewHeader } from "@/components/ViewHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

export default function Memories() {
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [creating, setCreating] = useState(false);
  const deleteMemory = useDeleteMemory();

  const listResult = useMemories();
  const searchResult = useMemorySearch(query);

  const isSearching = query.trim().length > 0;
  const { data, isLoading, error, refetch } = isSearching ? searchResult : listResult;
  const memories = data ?? [];

  if (error && !isSearching) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Memories"
        meta={`${memories.length} shown`}
        action={
          <Button size="sm" onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20">
            + New Memory
          </Button>
        }
      />

      {/* Search */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(searchInput)}
            placeholder="Search memories..."
            className="pl-8 bg-surface-highest border-surface-highest text-on-surface font-body text-xs placeholder:text-outline"
          />
        </div>
        <Button size="sm" onClick={() => setQuery(searchInput)}
          className="font-label text-xs uppercase bg-primary/10 text-primary border border-primary/30">
          Search
        </Button>
        {query && (
          <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setSearchInput(""); }}
            className="font-label text-xs text-outline">
            <X size={12} className="mr-1" /> Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
        </div>
      ) : memories.length === 0 ? (
        <EmptyState message={isSearching ? "No results" : "No memories"} />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Content</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Scope</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Importance</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-40">Tags</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {memories.map((mem) => (
                <TableRow key={mem.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                  <TableCell className="font-body text-xs text-on-surface max-w-xs truncate">{mem.content}</TableCell>
                  <TableCell className="font-label text-[10px] text-outline">{mem.scope ?? "—"}</TableCell>
                  <TableCell className="font-label text-[10px]">
                    <span className={{
                      critical: "text-error", high: "text-tertiary",
                      normal: "text-on-surface-variant", low: "text-outline",
                    }[mem.importance] ?? "text-outline"}>
                      {mem.importance}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(mem.tags ?? []).map((t) => (
                        <span key={t} className="font-label text-[9px] px-1.5 py-0.5 bg-surface-highest text-outline border border-surface-highest/50">
                          {t}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(mem.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button onClick={() => deleteMemory.mutate(mem.id)}
                      className="text-outline hover:text-error transition-colors p-1">
                      <Trash2 size={12} />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateMemoryDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CreateMemoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [scope, setScope] = useState("");
  const [tags, setTags] = useState("");
  const createMemory = useCreateMemory();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    createMemory.mutate(
      { content: content.trim(), scope: scope.trim() || undefined, tags: tagList.length ? tagList : undefined },
      { onSuccess: () => { setContent(""); setScope(""); setTags(""); onClose(); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">New Memory</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Content *</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Memory content..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
              rows={4}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Scope</Label>
            <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. project:orc, global"
              className="bg-background border-surface-highest text-on-surface font-body text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Tags (comma-separated)</Label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag1, tag2, ..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}
              className="font-label text-xs uppercase text-outline">Cancel</Button>
            <Button type="submit" size="sm" disabled={createMemory.isPending || !content.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25">
              {createMemory.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Task 11: Projects View

**Files:**
- Rewrite: `packages/web/src/views/Projects.tsx`

- [ ] **Step 1: Write `src/views/Projects.tsx`**

```tsx
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useProjects, useCreateProject, useDeleteProject } from "@/hooks/useProjects";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import type { TaskStatus } from "@/api/client";

export default function Projects() {
  const { data: projects, isLoading, error, refetch } = useProjects();
  const deleteProject = useDeleteProject();
  const [creating, setCreating] = useState(false);

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Projects"
        meta={`${(projects ?? []).length} total`}
        action={
          <Button size="sm" onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20">
            + New Project
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full bg-surface-highest" />)}
        </div>
      ) : (projects ?? []).length === 0 ? (
        <EmptyState message="No projects" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Name</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Description</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Status</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Tags</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(projects ?? []).map((p) => (
                <TableRow key={p.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                  <TableCell className="font-body text-xs font-semibold text-on-surface">{p.name}</TableCell>
                  <TableCell className="font-body text-xs text-outline max-w-xs truncate">{p.description ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge
                      status={
                        p.status === "active" ? ("doing" as TaskStatus)
                        : p.status === "done" ? ("done" as TaskStatus)
                        : ("todo" as TaskStatus)
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(p.tags ?? []).map((t) => (
                        <span key={t} className="font-label text-[9px] px-1.5 py-0.5 bg-surface-highest text-outline border border-surface-highest/50">
                          {t}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(p.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button onClick={() => deleteProject.mutate(p.id)}
                      className="text-outline hover:text-error transition-colors p-1">
                      <Trash2 size={12} />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const createProject = useCreateProject();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createProject.mutate(
      { name: name.trim(), description: description.trim() || undefined },
      { onSuccess: () => { setName(""); setDescription(""); onClose(); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">New Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="project-name"
              className="bg-background border-surface-highest text-on-surface font-body text-xs" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description..." rows={2}
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}
              className="font-label text-xs uppercase text-outline">Cancel</Button>
            <Button type="submit" size="sm" disabled={createProject.isPending || !name.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30">
              {createProject.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Task 12: Sessions View

**Files:**
- Create: `packages/web/src/views/Sessions.tsx`

- [ ] **Step 1: Create `src/views/Sessions.tsx`**

```tsx
import { useSessions } from "@/hooks/useSessions";
import { ViewHeader } from "@/components/ViewHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export default function Sessions() {
  const { data: sessions, isLoading, error, refetch } = useSessions({ limit: 50 });

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader title="Sessions" meta={`${(sessions ?? []).length} recent`} />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
        </div>
      ) : (sessions ?? []).length === 0 ? (
        <EmptyState message="No sessions" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">ID</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Agent</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Summary</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Version</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sessions ?? []).map((s) => (
                <TableRow key={s.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                  <TableCell className="font-label text-[10px] text-outline">{s.id.slice(-6)}</TableCell>
                  <TableCell className="font-label text-xs text-primary">{s.agent ?? "—"}</TableCell>
                  <TableCell className="font-body text-xs text-on-surface-variant max-w-sm truncate">
                    {s.summary ?? "—"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">{s.agent_version ?? "—"}</TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(s.created_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
```

---

## Task 13: Knowledge View

**Files:**
- Create: `packages/web/src/views/Knowledge.tsx`

- [ ] **Step 1: Create `src/views/Knowledge.tsx`**

```tsx
import { useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { ViewHeader } from "@/components/ViewHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export default function Knowledge() {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const qc = useQueryClient();

  const { data: collectionsData, isLoading, error } = useQuery({
    queryKey: ["knowledge-collections"],
    queryFn: () => api.knowledge.collections(),
    refetchInterval: 60_000,
  });

  const { data: searchData, isLoading: isSearching } = useQuery({
    queryKey: ["knowledge-search", query],
    queryFn: () => api.knowledge.search(query, { limit: 20 }),
    enabled: query.trim().length > 0,
  });

  const reindex = useMutation({
    mutationFn: () => api.knowledge.update(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge-collections"] }),
  });

  if (error) return <ErrorState message={(error as Error).message} />;

  const collections = collectionsData?.collections ?? [];
  const totalDocs = collections.reduce((sum, c) => sum + c.documentCount, 0);

  return (
    <div>
      <ViewHeader
        title="Knowledge"
        meta={`${totalDocs} documents`}
        action={
          <Button size="sm" variant="ghost" onClick={() => reindex.mutate()}
            disabled={reindex.isPending}
            className="font-label text-[10px] uppercase tracking-widest text-outline">
            <RefreshCw size={12} className={`mr-1 ${reindex.isPending ? "animate-spin" : ""}`} />
            {reindex.isPending ? "Indexing..." : "Reindex"}
          </Button>
        }
      />

      {/* Search */}
      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(searchInput)}
            placeholder="Search knowledge base..."
            className="pl-8 bg-surface-highest border-surface-highest text-on-surface font-body text-xs"
          />
        </div>
        <Button size="sm" onClick={() => setQuery(searchInput)}
          className="font-label text-xs uppercase bg-primary/10 text-primary border border-primary/30">
          Search
        </Button>
        {query && (
          <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setSearchInput(""); }}
            className="font-label text-xs text-outline">Clear</Button>
        )}
      </div>

      {/* Search results */}
      {query && (
        <div className="mb-6">
          <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-3">
            Search Results
          </div>
          {isSearching ? (
            <Skeleton className="h-20 w-full bg-surface-highest" />
          ) : (searchData?.results ?? []).length === 0 ? (
            <EmptyState message="No results" />
          ) : (
            <div className="border border-surface-highest rounded-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-surface-highest hover:bg-transparent">
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Title</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Collection</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Snippet</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(searchData?.results ?? []).map((r) => (
                    <TableRow key={r.docid} className="border-b border-surface-highest/50 hover:bg-surface-low">
                      <TableCell className="font-body text-xs font-medium text-on-surface">{r.title || r.path}</TableCell>
                      <TableCell className="font-label text-[10px] text-primary">{r.collection}</TableCell>
                      <TableCell className="font-body text-[10px] text-outline max-w-sm truncate">{r.snippet}</TableCell>
                      <TableCell className="font-label text-[10px] text-outline">{r.score.toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* Collections */}
      <div>
        <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-3">Collections</div>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
          </div>
        ) : collections.length === 0 ? (
          <EmptyState message="No collections" />
        ) : (
          <div className="border border-surface-highest rounded-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-surface-highest hover:bg-transparent">
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Name</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Path</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Docs</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Last Modified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {collections.map((c) => (
                  <TableRow key={c.name} className="border-b border-surface-highest/50 hover:bg-surface-low">
                    <TableCell className="font-label text-xs font-semibold text-primary">{c.name}</TableCell>
                    <TableCell className="font-body text-[10px] text-outline truncate max-w-xs">{c.path}</TableCell>
                    <TableCell className="font-label text-xs text-on-surface">{c.documentCount}</TableCell>
                    <TableCell className="font-label text-[10px] text-outline">
                      {c.lastModified ? new Date(c.lastModified).toLocaleDateString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Task 14: Settings View

**Files:**
- Create: `packages/web/src/views/Settings.tsx`

- [ ] **Step 1: Create `src/views/Settings.tsx`**

```tsx
import { useState } from "react";
import { Save, CheckCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getApiUrl, getApiSecret } from "@/api/client";
import { ViewHeader } from "@/components/ViewHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default function Settings() {
  const [apiUrl, setApiUrl] = useState(getApiUrl);
  const [apiSecret, setApiSecret] = useState(getApiSecret);
  const [saved, setSaved] = useState(false);
  const qc = useQueryClient();

  const handleSave = () => {
    localStorage.setItem("orc_api_url", apiUrl.trim() || "/api");
    localStorage.setItem("orc_api_secret", apiSecret.trim());
    qc.invalidateQueries();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    localStorage.removeItem("orc_api_url");
    localStorage.removeItem("orc_api_secret");
    setApiUrl("/api");
    setApiSecret("");
    qc.invalidateQueries();
  };

  return (
    <div>
      <ViewHeader title="Settings" />

      <div className="max-w-lg space-y-8">
        {/* API Configuration */}
        <section>
          <h2 className="font-headline font-bold text-xs uppercase tracking-widest text-on-surface mb-1">
            API Configuration
          </h2>
          <p className="font-body text-xs text-outline mb-4">
            Configure how the frontend connects to the ORC API server.
            In development, the default <code className="text-primary">/api</code> is proxied by Vite to{" "}
            <code className="text-primary">localhost:7700</code>.
          </p>
          <Separator className="bg-surface-highest mb-4" />
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                API Base URL
              </Label>
              <Input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="/api  or  http://localhost:7700"
                className="bg-surface-highest border-surface-highest text-on-surface font-body text-sm"
              />
              <p className="font-body text-[10px] text-outline">
                Use <code>/api</code> (dev proxy) or a direct URL when CORS is enabled.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                API Secret (Bearer Token)
              </Label>
              <Input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="Leave empty if no auth required"
                className="bg-surface-highest border-surface-highest text-on-surface font-body text-sm"
              />
            </div>
          </div>
        </section>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button onClick={handleSave}
            className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25">
            {saved ? (
              <>
                <CheckCircle size={12} className="mr-1.5 text-secondary" /> Saved
              </>
            ) : (
              <>
                <Save size={12} className="mr-1.5" /> Save Settings
              </>
            )}
          </Button>
          <Button variant="ghost" onClick={handleReset}
            className="font-label text-xs uppercase text-outline hover:text-on-surface">
            Reset to Defaults
          </Button>
        </div>

        {/* Info */}
        <section>
          <Separator className="bg-surface-highest mb-4" />
          <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-2">
            Storage
          </div>
          <p className="font-body text-xs text-outline">
            Settings are persisted in <code className="text-primary">localStorage</code> and survive page reloads.
            Clearing browser storage resets to defaults.
          </p>
        </section>
      </div>
    </div>
  );
}
```

---

## Task 15: Final Integration + Typecheck

**Files:**
- Verify all views are wired

- [ ] **Step 1: Run full typecheck**

```bash
cd packages/web && bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 2: Start dev server and do a full walkthrough**

```bash
bun run dev
```

Visit `http://localhost:5173`. Verify:
- Sidebar navigation switches between all 8 views
- Dashboard shows stats + recent tasks (updates every 30s)
- Tasks: filter tabs, inline status change, create dialog, delete
- Jobs: list with run button, expand for run history
- Memories: search works, create dialog, delete
- Projects: list, create dialog
- Sessions: read-only list
- Knowledge: collections list, search
- Settings: save/load API URL and secret
- Health indicator (green pulse) in sidebar footer
- All views handle loading (skeleton) and error states

- [ ] **Step 3: Build production bundle**

```bash
bun run build
```

Expected: `dist/` created, no TypeScript or Vite errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/
git commit -m "feat(web): add React frontend with Tailwind, shadcn, and React Query"
```

---

## Self-Review

**Spec coverage:**
- ✅ Dashboard with stats grid — Task 7
- ✅ Auto-updating via React Query `refetchInterval` — Task 4
- ✅ Tasks: list, filter, create, status change, delete — Task 8
- ✅ Jobs: list, trigger, run history expand — Task 9
- ✅ Memories: list, search, create, delete — Task 10
- ✅ Projects: list, create, delete — Task 11
- ✅ Sessions: read-only list — Task 12
- ✅ Knowledge: collections + search + reindex — Task 13
- ✅ Settings: API URL + secret — Task 14
- ✅ Health status in sidebar — Task 6
- ✅ Tailwind with ORC color theme — Task 1
- ✅ shadcn/ui components throughout — Task 2
- ✅ React Query for all API state — Task 4
- ✅ Shared components (StatusBadge, PriorityBadge, StatCard, ViewHeader, EmptyState, ErrorState) — Task 5
- ✅ Component reuse: modals use shadcn Dialog, tables use shadcn Table, all views share ViewHeader
