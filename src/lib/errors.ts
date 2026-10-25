// ============================================================
//  Konfigurasi & pemangkuan input
// ============================================================

import type { Env } from '../types';

/** Ralat pengesahan — membawa kod mesin untuk pemetaan HTTP. */
export class ValidationError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.status = 422;
    this.details = details;
  }
}

/** Ralat aplikasi umum. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------
// TTL mengikut jenis laporan (ms)
// ------------------------------------------------------------
export const REPORT_TTL_MS: Record<string, number> = {
  ACCIDENT: 45 * 60_000, // 45 minit
  SPEED_TRAP: 90 * 60_000, // 1.5 jam
  HAZARD: 6 * 3_600_000, // 6 jam
  TRAFFIC_JAM: 60 * 60_000, // 1 jam
  POLICE: 90 * 60_000,
  ROAD_CLOSURE: 24 * 3_600_000, // 24 jam
  WEATHER: 3 * 3_600_000,
  COMMUNITY: 12 * 3_600_000,
};

export function ttlFor(type: string, env?: Env): number {
  const fallback = Number(env?.DEFAULT_TTL_MS ?? 3_600_000);
  return REPORT_TTL_MS[type] ?? fallback;
}

// ------------------------------------------------------------
// Pangkuh Env dengan had lalai
// ------------------------------------------------------------
export interface Limits {
  maxRadiusM: number;
  maxLimit: number;
  defaultLimit: number;
  /** Had sel masa nyata dalam satu Durable Object. */
  maxPeersPerCell: number;
}

export function limits(env: Env): Limits {
  return {
    maxRadiusM: Math.min(Math.max(Number(env.MAX_RADIUS_M ?? 5_000), 100), 50_000),
    maxLimit: Math.min(Math.max(Number(env.MAX_LIMIT ?? 200), 1), 1_000),
    defaultLimit: 50,
    maxPeersPerCell: 500,
  };
}

// ------------------------------------------------------------
// Pengesah ringkas (tanpa kebergantungan zod)
// ------------------------------------------------------------
/**
 * Nombor dengan paksaan string.
 *
 * PENTING: parameter query SELALU string, jadi `"3.139"` mesti diterima.
 * Sebelum ini kita hanya terima `typeof v === 'number'`, yang membuat setiap
 * panggilan `?lat=3.139&lng=101.68` gagal dengan 422/500.
 */
export function requireNumber(v: unknown, field: string): number {
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string' && v.trim() !== '') {
    n = Number(v);
  } else {
    n = NaN;
  }
  if (!Number.isFinite(n)) throw new ValidationError(`'${field}' mestilah nombor`);
  return n;
}

export function requireLat(v: unknown, field = 'lat'): number {
  const n = requireNumber(v, field);
  if (n < -90 || n > 90) throw new ValidationError(`'${field}' mestilah antara -90 dan 90`);
  return n;
}

export function requireLng(v: unknown, field = 'lng'): number {
  const n = requireNumber(v, field);
  if (n < -180 || n > 180) throw new ValidationError(`'${field}' mestilah antara -180 dan 180`);
  return n;
}

export function optionalNumber(
  v: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = requireNumber(v, field);
  if (n < min || n > max) throw new ValidationError(`'${field}' mestilah antara ${min} dan ${max}`);
  return n;
}

export function optionalString(
  v: unknown,
  field: string,
  maxLen: number,
): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ValidationError(`'${field}' mestilah teks`);
  const t = v.trim();
  if (t.length > maxLen) throw new ValidationError(`'${field}' melebihi ${maxLen} aksara`);
  return t;
}

/**
 * Integer terhad dari parameter query.
 *
 * PENTING: parameter query SELALU string, jadi kita paksa ke nombor
 * dan kembali ke nilai lalai jika tidak sah — bukan melempar ralat.
 * Melempar di sini akan membuat setiap panggilan `?limit=50` gagal.
 */
export function clampInt(
  v: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (v === undefined || v === null || v === '') return fallback;

  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;

  void field; // dikekalkan untuk keserasian panggilan
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function requireEnum<T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new ValidationError(
      `'${field}' mestilah salah satu: ${allowed.join(', ')}`,
      { allowed },
    );
  }
  return v as T;
}

// ------------------------------------------------------------
// ID ringkas
// ------------------------------------------------------------
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** ID ringkas 16 aksara — cukup untuk jutaan baris, mesra URL. */
export function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let out = '';
  for (const byte of b) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export function nowMs(): number {
  return Date.now();
}

/** Potong pada ruang — elakkan pertanyaan tanpa had daripada klien. */
export function normalizeOptionalString(v: unknown, field: string, maxLen: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ValidationError(`'${field}' mestilah teks`);
  const t = v.trim();
  if (!t) return null;
  if (t.length > maxLen) throw new ValidationError(`'${field}' melebihi ${maxLen} aksara`);
  return t;
}

// ------------------------------------------------------------
// Profil pengguna — `undefined` berbeza daripada `null`
// ------------------------------------------------------------
/**
 * Teks profil.
 *
 * `undefined` = medan tidak dihantar → JANGAN ubah.
 * `null`/`""`  = kosongkan (pengguna memilih "tiada nama").
 * string lain = nilai baharu.
 *
 * `null` dan `""` dibezakan daripada "tiada perubahan" di dua sebab:
 *  - `""` adalah apa yang diterima parameter QUERY (`?name=`) — tidak ada
 *    cara untuk menghantar JSON `null` melalui URL.
 *  - Jika `""` bermaksud "tiada perubahan", pengguna tidak akan pernah
 *    boleh mengosongkan nama mereka.
 */
export function profileString(
  v: unknown,
  field: string,
  maxLen: number,
): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new ValidationError(`'${field}' mestilah teks`);
  const t = v.trim();
  if (!t) return null;
  if (t.length > maxLen) throw new ValidationError(`'${field}' melebihi ${maxLen} aksara`);
  return t;
}

/** Enum profil dengan semantik yang sama (`undefined` = jangan ubah). */
export function profileEnum<T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
): T | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new ValidationError(`'${field}' mestilah teks`);
  if (v === '') return null;
  return requireEnum(v, field, allowed);
}
