// ============================================================
//  Geofence Mykira Map — koridor selatan Sabah
//
//  Aplikasi hanya menerima laporan dari dalam koridor operasi:
//    Kota Kinabalu → Putatan → Papar → Kimanis → Membakut
//
//  Titik tengah dan radius boleh ditukar melalui pembolehubah
//  persekitaran — tiada perubahan kod diperlukan.
// ============================================================

import type { Env } from '../types';
import { haversineM } from './geo';

/**
 * Titik tengah zon operasi — Putatan, Sabah.
 * Dipilih kerana ia terletak di pertengahan koridor KK ↔ Membakut.
 */
export const MAP_CENTER = { lat: 5.8943, lng: 116.0505 } as const;

/**
 * Had geofence lalai — 90 km.
 * Julat yang diminta ialah 80–100 km; 90 km ialah titik tengah.
 *
 * Dari Putatan, 90 km meliputi:
 *   KK & KKIA (~10 km), Petagas (~3 km), Lok Kawi (~5 km),
 *   Papar (~22 km), Kimanis (~44 km), Membakut / Kg Pimping (~62 km)
 * dengan margin yang selesa ke hujung koridor.
 */
export const MAP_RADIUS_M = 90_000;

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
  const lat = toFinite(env?.CENTER_LAT, MAP_CENTER.lat);
  const lng = toFinite(env?.CENTER_LNG, MAP_CENTER.lng);
  const radiusM = toFinite(env?.GEOFENCE_RADIUS_M, MAP_RADIUS_M);

  return {
    lat,
    lng,
    radiusM: radiusM > 0 ? radiusM : MAP_RADIUS_M,
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
    `Laporan di luar zon operasi — ${km} km dari Putatan ` +
    `(had ${(g.radiusM / 1000).toFixed(0)} km)`
  );
}
