import type { APIRequestContext, Page } from "@playwright/test";

export const API_PORT = process.env.ORC_API_PORT ?? "9871";
export const API_BASE = `http://127.0.0.1:${API_PORT}/api`;
export const API_SECRET = process.env.ORC_API_SECRET ?? "";

export const AUTH_HEADERS: Record<string, string> = API_SECRET
  ? { Authorization: `Bearer ${API_SECRET}`, "Content-Type": "application/json" }
  : { "Content-Type": "application/json" };

/** Unique short id for test fixtures so multiple test runs don't collide. */
export function tid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Open the app, ensure web client has the bearer (if needed), and navigate to a view. */
export async function gotoView(
  page: Page,
  view:
    | "dashboard"
    | "tasks"
    | "jobs"
    | "memories"
    | "projects"
    | "sessions"
    | "knowledge"
    | "skills"
    | "settings",
): Promise<void> {
  if (API_SECRET) {
    await page.addInitScript(
      (secret: string) => localStorage.setItem("orc_api_secret", secret),
      API_SECRET,
    );
  }
  await page.goto("/");
  await page.getByTestId(`nav-${view}`).click();
}

export async function apiDelete(request: APIRequestContext, path: string): Promise<void> {
  await request.delete(`${API_BASE}${path}`, { headers: AUTH_HEADERS });
}

export async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`${API_BASE}${path}`, { headers: AUTH_HEADERS });
  if (!res.ok()) throw new Error(`GET ${path} failed: ${res.status()}`);
  return (await res.json()) as T;
}

export async function apiPost<T>(
  request: APIRequestContext,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await request.post(`${API_BASE}${path}`, {
    headers: AUTH_HEADERS,
    data: body,
  });
  if (!res.ok()) throw new Error(`POST ${path} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function apiPatch<T>(
  request: APIRequestContext,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await request.patch(`${API_BASE}${path}`, {
    headers: AUTH_HEADERS,
    data: body,
  });
  if (!res.ok()) throw new Error(`PATCH ${path} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}
