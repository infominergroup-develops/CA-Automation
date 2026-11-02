export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

type Body = Record<string, unknown> | FormData | undefined;

/** All calls send the custom header the server requires on state-changing requests (CSRF defence). */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: Body } = {}): Promise<T> {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'fetch',
      ...(opts.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.code === 'unauthenticated') window.dispatchEvent(new Event('session-expired'));
    if (data.code === 'consent_required' || data.code === 'monitoring_ack_required') window.dispatchEvent(new Event('refresh-me'));
    const fallback = res.status >= 500 ? 'The server is not reachable. Please try again shortly.' : 'Request failed.';
    throw new ApiError(res.status, data.error ?? fallback, data.code);
  }
  return data as T;
}

/** Downloads through fetch so the session cookie and integrity checks apply; no public file URLs exist. */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? 'Download failed.');
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const name = decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? fallbackName);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const fmtDateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtHours = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
export const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

/** Indian financial year for a date, e.g. 2026-27. */
export function currentFy(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
export const fyOptions = () => {
  const y = Number(currentFy().slice(0, 4));
  return [0, 1, 2, 3, 4].map((i) => `${y - i}-${String((y - i + 1) % 100).padStart(2, '0')}`);
};
