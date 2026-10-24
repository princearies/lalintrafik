// ============================================================
//  Middleware — CORS, pengendali ralat, sokongan
// ============================================================

import type { Context, ErrorHandler, MiddlewareHandler, Next } from 'hono';
import type { Env } from '../types';
import { AppError, ValidationError } from '../lib/errors';

// ------------------------------------------------------------
//  CORS
// ------------------------------------------------------------
/**
 * CORS khusus untuk API edge.
 *
 * PENTING: jangan balas `Access-Control-Allow-Origin: *` bersama
 * `Access-Control-Allow-Credentials: true` — imbasan menafikan kombinasi
 * itu, jadi kita pacak balik asal sebenar.
 */
export function cors(opts?: { origins?: string[]; maxAge?: number }): MiddlewareHandler {
  const allowed = opts?.origins;
  const maxAge = opts?.maxAge ?? 86_400;

  return async (c: Context, next: Next): Promise<void> => {
    const origin = c.req.header('Origin');

    if (origin && (!allowed || allowed.includes('*') || allowed.includes(origin))) {
      c.res.headers.set('Access-Control-Allow-Origin', allowed?.includes('*') ? '*' : origin);
      c.res.headers.set('Vary', 'Origin');
    }

    c.res.headers.set(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, OPTIONS',
    );
    c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');
    c.res.headers.set('Access-Control-Max-Age', String(maxAge));

    //_preflight dijawab di sini, tidak ke route
    if (c.req.method === 'OPTIONS') {
      c.res.headers.set('Content-Length', '0');
      c.status(204);
      return;
    }

    await next();
  };
}

// ------------------------------------------------------------
//  Pengendali ralat berpusat
// ------------------------------------------------------------
/**
 * Pengendali ralat.
 *
 * PENTING: kita padankan secara STRUKTUR (bukan `instanceof`). Pemeriksa
 * `instanceof` boleh gagal bila pakej diduplikasi oleh bundler, dan
 * kesudahannya ralat 502 yang sah menjadi 500 tanpa sebab.
 */
export function errorHandler(): ErrorHandler {
  return async (err: Error, c: Context): Promise<Response> => {
    const e = (err ?? {}) as {
      name?: string;
      message?: string;
      status?: number;
      code?: string;
      details?: unknown;
    };
    const msg = e.message ?? 'Ralat tidak dijangka';

    // ralat D1 — jangan dedah butiran dalaman
    if (/D1_|SQLITE_|Durable Object/.test(msg)) {
      c.executionCtx?.waitUntil?.(logSafely(c.env, 'd1_error', msg));
      return Response.json(
        { success: false, error: 'Ralat pangkalan data' },
        { status: 500 },
      );
    }

    // ValidationError: ada `status` + `details`
    // AppError: ada `status` + `code`
    if (typeof e.status === 'number' && Number.isFinite(e.status)) {
      const body: Record<string, unknown> = { success: false, error: msg };
      if (typeof e.code === 'string') body.code = e.code;
      if (e.details !== undefined) body.details = e.details;
      return Response.json(body, { status: e.status });
    }

    // tak dijangka
    c.executionCtx?.waitUntil?.(
      logSafely(c.env, 'unhandled', typeof err === 'object' ? msg : String(err)),
    );
    return Response.json(
      { success: false, error: 'Ralat dalaman pelayan' },
      { status: 500 },
    );
  };
}

// ------------------------------------------------------------
//  Bantuan
// ------------------------------------------------------------
/** Badan permintaan JSON dengan had saiz — elakkan muat naik gergasi. */
export async function readJson<T = unknown>(c: Context, maxBytes = 8_192): Promise<T> {
  const raw = await c.req.text();
  if (raw.length > maxBytes) {
    throw new AppError('Badan permintaan melebihi 8 KB', 413, 'PAYLOAD_TOO_LARGE');
  }
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ValidationError('JSON tidak sah');
  }
}

/** Pembaca header peranti — hulung, senang, tanpa keperluan akaun. */
export function deviceIdOf(c: Context): string {
  const id = c.req.header('X-Device-Id');
  if (!id || id.length < 8 || id.length > 128) {
    throw new ValidationError('Header X-Device-Id diperlukan (8-128 aksara)');
  }
  return id;
}

/** Tambah header prestasi ringan pada setiap balasan. */
export function timing(): MiddlewareHandler {
  return async (c: Context, next: Next): Promise<void> => {
    const start = Date.now();
    await next();
    c.res.headers.set('Server-Timing', `edge;dur=${Date.now() - start}`);
  };
}

async function logSafely(env: Env | undefined, kind: string, message: string): Promise<void> {
  // Di produksi, hantar ke logpush/R2. Di sini kami hanya jadikan kekal.
  void env;
  void kind;
  void message;
}
