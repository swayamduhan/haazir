/** Small shared helpers for the three pages: API calls, DOM, storage, sensors. */

export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail: string) {
    super(`${code}: ${detail}`);
  }
}

/** Calls the REST API through the dev server's /api proxy — one origin, one certificate. */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'cannot reach the attendance server');
  }
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'HTTP_' + res.status,
      data?.error?.detail ?? res.statusText);
  }
  return data as T;
}

/** What a student is shown for each rejection, in plain words. The code is shown too. */
const FRIENDLY: Record<string, string> = {
  NOT_ENROLLED: 'You are not on the roster for this course.',
  DUPLICATE_ATTENDANCE: 'You are already marked for this session.',
  WINDOW_MISMATCH: 'That code has already rotated. Scan the one on screen now.',
  OUTSIDE_SESSION_WINDOW: 'This session is not accepting attendance right now.',
  SESSION_NOT_OPEN: 'This session has been closed.',
  SESSION_NOT_FOUND: 'That session does not exist.',
  INVALID_SIGNATURE: 'This device’s key is not the one registered for you.',
  STUDENT_NOT_FOUND: 'This device is not registered.',
  STUDENT_NOT_ACTIVE: 'Your identity is not active.',
  NETWORK: 'Cannot reach the attendance server.',
};

export function explain(err: unknown): { code: string; message: string } {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.code === 'OUTSIDE_GEOFENCE' ? capitalise(err.detail) : (FRIENDLY[err.code] ?? err.detail) };
  }
  return { code: 'ERROR', message: err instanceof Error ? err.message : String(err) };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- DOM
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, any> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function mount(root: HTMLElement, ...nodes: Child[]): void {
  root.replaceChildren(...nodes.filter((n): n is Node | string => n !== null && n !== undefined && n !== false)
    .map((n) => (n instanceof Node ? n : String(n))));
}

export const short = (id: string, n = 8) => (id.length > n * 2 + 1 ? `${id.slice(0, n)}…${id.slice(-4)}` : id);

export function badge(kind: 'ok' | 'bad' | 'warn' | 'neutral', text: string) {
  return h('span', { class: `badge ${kind}` }, text);
}

// ------------------------------------------------------------- storage
// Wrapped because storage can be unavailable (private mode, blocked site data),
// and a page that throws on load is worse than one that forgets.
export const store = {
  get<T>(key: string): T | null {
    try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* best effort */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* best effort */ }
  },
};

// ------------------------------------------------------------- sensors
export interface Position { lat: number; lng: number; accuracy: number }

export function currentPosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('This browser has no location access.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED
        ? 'Location permission was denied.' : 'Could not get a location fix.')),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function topbar(role: string): HTMLElement {
  return h('header', { class: 'topbar' },
    h('span', { class: 'brand' }, 'haazir', h('b', {}, '.')),
    h('span', { class: 'role' }, role),
    h('span', { class: 'spacer' }),
    h('a', { href: '/' }, 'Home'));
}
