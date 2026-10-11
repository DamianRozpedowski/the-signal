// Small fetch wrapper: JSON in/out, CSRF header on every request, readable errors.
// In the static edition (GitHub Pages) the same calls are answered in the browser.

import { STATIC, staticRequest } from "./static";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (STATIC) {
    try {
      return (await staticRequest(method, url, body)) as T;
    } catch (e: any) {
      throw new ApiError(e?.status ?? 500, e?.message ?? "Something went wrong");
    }
  }
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "x-dw-csrf": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data);
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>("GET", url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  put: <T = any>(url: string, body: unknown = {}) => request<T>("PUT", url, body),
  patch: <T = any>(url: string, body: unknown = {}) => request<T>("PATCH", url, body),
  del: <T = any>(url: string, body?: unknown) => request<T>("DELETE", url, body),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
