// ============================================================
//  MYKIRA MAP — Profil pengguna (tanpa akaun)
//
//  Profil dipertanggungkanjawabkan kepada `device_id` dari header
//  `X-Device-Id` — tiada log masuk, tiada kata laluan. Ini menjadikan
//  aplikasi Android akan guna endpoint yang sama kemudian.
//
//  Semantik medan (sama di POST /reports dan di sini):
//    tidak dihantar → jangan ubah
//    "" atau null    → kosongkan
//    nilai lain      → set nilai itu
//
//  `displayName` dan `gender` juga dihantar bersama laporan dan mesej
//  WebSocket supaya pelapor dikenali walaupun tidak pernah membuka
//  tetapan profil.
// ============================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { GENDERS, toUser } from '../types';
import { getProfile, upsertUser } from '../db/reports';
import { profileEnum, profileString, ValidationError } from '../lib/errors';
import { deviceIdOf, readJson } from '../middleware/cors';

export const profile = new Hono<{ Bindings: Env }>();

/** Had panjang nama paparan — sama dengan `maxlength` pada input klien. */
export const DISPLAY_NAME_MAX = 60;

/**
 * GET /api/v1/profile
 *
 * Memulangkan profil peranti ini, atau `data: null` jika belum pernah
 * wujud. Klien menggunakan ini untuk mengisi borang semasa pertama kali
 * dibuka.
 */
profile.get('/', async (c) => {
  const deviceId = deviceIdOf(c);
  if (!c.env.DB) {
    return c.json({ success: false, error: 'Ralat pangkalan data' }, 500);
  }

  const row = await getProfile(c.env.DB, deviceId);
  return c.json({ success: true, data: row ? toUser(row) : null });
});

/**
 * PATCH /api/v1/profile
 *
 * Body: `{ displayName?: string | null, gender?: 'MALE'|'FEMALE'|'UNSPECIFIED' | null }`
 *
 * Hanya medan yang dihantar akan ditulis — jadi klien hulung boleh
 * mengemas kini nama sahaja tanpa menghantar jantina.
 */
profile.patch('/', async (c) => {
  const deviceId = deviceIdOf(c);
  const body = await readJson<Record<string, unknown>>(c);

  const displayName = profileString(body.displayName, 'displayName', DISPLAY_NAME_MAX);
  const gender = profileEnum(body.gender, 'gender', GENDERS);

  if (displayName === undefined && gender === undefined) {
    throw new ValidationError('Tiada perubahan diterima', {
      fields: ['displayName', 'gender'],
    });
  }

  if (!c.env.DB) {
    return c.json({ success: false, error: 'Ralat pangkalan data' }, 500);
  }

  const row = await upsertUser(c.env.DB, deviceId, { displayName, gender });
  return c.json({ success: true, data: toUser(row) });
});
