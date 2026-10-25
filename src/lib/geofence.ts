// ============================================================
//  Geofence Kota Kinabalu (KK), Sabah
//
//  Lalintrafik hanya menerima laporan dari dalam zon operasi KK.
//  Titik tengah dan radius boleh ditukar melalui pembolehubah
//  persekitaran — tiada perubahan kod diperlukan.
//
//  Zon 25 km daripada pusat KK meliputi:
//    Sepanggar, Inanam, Donggongon, Penampang, Putatan, KKIA
// ============================================================

import type { Env } from '../types';
import { haversineM } from './geo';

/** Titik tengah Kota Kinabalu (lembah KK / pusat bandar). */
export const KK_CENTER = { lat: 5.9804, lng: 116.0735 } as const;

/**
 * Had geofence lalai — 25 km.
 * Julat yang diminta ialah 20–30 km; 25 km ialah titik tengah dan
 * meliputi semua zon senarai di atas dengan margin yang selesa.
 */
export const KK_RADIUS_M = 25_000;

export interface Geofence {
  lat: number;
  lng: number;
  radiusM: number;
}

/**
 * Nombor env yang selamat: kosong / bukan nombor / tak terhingga semua
 * jatuh balik kepada lalai — jangan biarkan satu pembolehubah salah
 * mematikan geofence dan menolak semua laporan.
 *
 * PENTING: `Number('')` ialah **0**, bukan NaN — dan 0° longitud adalah
 * lokasi yang sah (Gulf of Guinea). Tanpa semakan rentetan kosong ini,
 * satu pembolehubah env yang kosong akan mengalih geofence ke 0°E
 * tanpa sebarang ralat.
 */
function toFinite(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const t = raw.trim();
  if (t === '') return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
}

export function geofenceOf(env?: Env): Geofence {
  const lat = toFinite(env?.CENTER_LAT, KK_CENTER.lat);
  const lng = toFinite(env?.CENTER_LNG, KK_CENTER.lng);
  const radiusM = toFinite(env?.GEOFENCE_RADIUS_M, KK_RADIUS_M);

  return {
    lat,
    lng,
    radiusM: radiusM > 0 ? radiusM : KK_RADIUS_M,
  };
}

/** Jarak (meter) dari titik tengah geofence. */
export function distanceFromCenterM(
  lat: number,
  lng: number,
  env?: Env,
): number {
  const g = geofenceOf(env);
  return haversineM(lat, lng, g.lat, g.lng);
}

/** Adakah titik ini di dalam zon operasi? */
export function isWithinGeofence(
  lat: number,
  lng: number,
  env?: Env,
): boolean {
  return distanceFromCenterM(lat, lng, env) <= geofenceOf(env).radiusM;
}

/** Paparan mesra-manusia untuk mesej ralat — jarak dibundarkan kepada km. */
export function geofenceMessage(lat: number, lng: number, env?: Env): string {
  const g = geofenceOf(env);
  const km = (distanceFromCenterM(lat, lng, env) / 1000).toFixed(1);
  return (
    `Laporan di luar zon operasi — ${km} km dari pusat Kota Kinabalu ` +
    `(had ${(g.radiusM / 1000).toFixed(0)} km)`
  );
}
