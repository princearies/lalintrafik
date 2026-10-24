// ============================================================
//  Laluan laporan — cipta, nearby, confirm, dismiss, status
// ============================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { REPORT_TYPES, type CreateReportRequest, type NearbyQuery } from '../types';
import {
  clampInt,
  limits,
  optionalNumber,
  optionalString,
  requireEnum,
  requireLat,
  requireLng,
  ttlFor,
} from '../lib/errors';
import { cellFor, neighbourCells } from '../lib/geo';
import {
  confirmReport,
  createReport,
  dismissReport,
  expireStaleReports,
  findNearby,
  getReport,
  upsertSession,
  upsertUser,
} from '../db/reports';
import { publishReport, publishVote } from './ws';
import { deviceIdOf, readJson } from '../middleware/cors';

export const reports = new Hono<{ Bindings: Env }>();

// ------------------------------------------------------------
//  POST /api/v1/reports — hantar laporan baharu
// ------------------------------------------------------------
reports.post('/', async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const deviceId = deviceIdOf(c);

  const type = requireEnum(body.type, 'type', REPORT_TYPES);
  const lat = requireLat(body.lat);
  const lng = requireLng(body.lng);

  const input: CreateReportRequest = {
    type,
    lat,
    lng,
    accuracyM: optionalNumber(body.accuracyM, 'accuracyM', 0, 100_000),
    heading: optionalNumber(body.heading, 'heading', 0, 360),
    speedKmh: optionalNumber(body.speedKmh, 'speedKmh', 0, 500),
    roadName: optionalString(body.roadName, 'roadName', 120),
    note: optionalString(body.note, 'note', 280),
    severity: clampInt(body.severity, 'severity', 0, 3, 0),
  };

  // pengguna hulung (tiada akaun) — dicipta/dikemas kini mengikut device_id
  const user = await upsertUser(c.env.DB, deviceId);
  const created = await createReport(
    c.env.DB,
    { ...input, userId: user.id, deviceId },
    c.env,
  );

  const cell = cellFor(lat, lng);
  const neighbours = neighbourCells(cell);

  // siaran masa nyata — dilaksanakan sebagai latar belakang supaya
  // balasan HTTP tidak terperangkap oleh kelewatan DO.
  c.executionCtx.waitUntil(publishReport(c.env, created.report, cell, neighbours));

  return c.json(
    { success: true, data: { ...created.report, ttlMs: ttlFor(type, c.env) } },
    201,
  );
});

// ------------------------------------------------------------
//  GET /api/v1/reports/nearby — laporan dalam radius
// ------------------------------------------------------------
reports.get('/nearby', async (c) => {
  const q = c.req.query();

  const query: NearbyQuery = {
    lat: requireLat(q.lat),
    lng: requireLng(q.lng),
    radiusM: clampInt(q.radiusM ?? q.radius ?? 5000, 'radiusM', 50, limits(c.env).maxRadiusM, 5000),
    limit: clampInt(q.limit ?? 50, 'limit', 1, limits(c.env).maxLimit, limits(c.env).defaultLimit),
    type: q.type ? requireEnum(q.type, 'type', REPORT_TYPES) : undefined,
    since: q.since,
  };

  // `since` mestilah tarikh ISO yang sah
  let sinceMs: number | undefined;
  if (query.since !== undefined && query.since !== '') {
    const parsed = Date.parse(query.since);
    if (Number.isNaN(parsed)) {
      return c.json({ success: false, error: "'since' mestilah tarikh ISO 8601" }, 422);
    }
    sinceMs = parsed;
  }

  const reports = await findNearby(
    c.env.DB,
    query,
    {
      limit: query.limit,
      maxRadiusM: limits(c.env).maxRadiusM,
      type: query.type,
      sinceMs,
    },
  );

  return c.json({
    success: true,
    data: reports,
    meta: {
      center: { lat: query.lat, lng: query.lng },
      radiusM: query.radiusM,
      count: reports.length,
    },
  });
});

// ------------------------------------------------------------
//  GET /api/v1/reports/:id
// ------------------------------------------------------------
reports.get('/:id', async (c) => {
  const id = c.req.param('id');
  const report = await getReport(c.env.DB, id);
  if (!report) {
    return c.json({ success: false, error: 'Laporan tidak dijumpai' }, 404);
  }
  return c.json({ success: true, data: report });
});

// ------------------------------------------------------------
//  POST /api/v1/reports/:id/confirm  — "ada juga di sana"
// ------------------------------------------------------------
reports.post('/:id/confirm', async (c) => {
  const id = c.req.param('id');
  const result = await confirmReport(c.env.DB, id);
  if (!result) {
    return c.json({ success: false, error: 'Laporan tidak dijumpai' }, 404);
  }

  const cell = c.req.query('cell') || '';
  if (cell) {
    c.executionCtx.waitUntil(
      publishVote(c.env, cell, {
        kind: 'report.confirm',
        id,
        confirmCount: result.confirmCount,
        confidence: result.confidence,
      }),
    );
  }

  return c.json({ success: true, data: result });
});

// ------------------------------------------------------------
//  POST /api/v1/reports/:id/dismiss  — "sudah tiada"
// ------------------------------------------------------------
reports.post('/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  const result = await dismissReport(c.env.DB, id);
  if (!result) {
    return c.json({ success: false, error: 'Laporan tidak dijumpai' }, 404);
  }

  const cell = c.req.query('cell') || '';
  if (cell) {
    c.executionCtx.waitUntil(
      publishVote(c.env, cell, {
        kind: 'report.dismiss',
        id,
        dismissCount: result.dismissCount,
        confidence: result.confidence,
      }),
    );
  }

  return c.json({ success: true, data: result });
});

// ------------------------------------------------------------
//  POST /api/v1/sessions — daftar kehadiran (dipanggil oleh frontend)
// ------------------------------------------------------------
reports.post('/session', async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const deviceId = deviceIdOf(c);

  const lat = requireLat(body.lat);
  const lng = requireLng(body.lng);

  const user = await upsertUser(c.env.DB, deviceId);
  const session = await upsertSession(
    c.env.DB,
    deviceId,
    user.id,
    lat,
    lng,
    optionalNumber(body.heading, 'heading', 0, 360),
    optionalNumber(body.speedKmh, 'speedKmh', 0, 500),
  );

  return c.json({ success: true, data: session }, 201);
});

// ------------------------------------------------------------
//  GET /api/v1/reports — ringkasan peta (peti pembagi besar)
// ------------------------------------------------------------
reports.get('/', async (c) => {
  const q = c.req.query();
  const box = {
    minLat: requireLat(q.minLat),
    minLng: requireLng(q.minLng),
    maxLat: requireLat(q.maxLat),
    maxLng: requireLng(q.maxLng),
  };
  const limit = clampInt(q.limit ?? 500, 'limit', 1, 1000, 500);

  const { results } = await c.env.DB.prepare(
    `SELECT id, type, lat, lng, severity, confirm_count, dismiss_count, created_at
       FROM reports
      WHERE status = 'ACTIVE'
        AND lat BETWEEN ? AND ?
        AND lng BETWEEN ? AND ?
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(box.minLat, box.maxLat, box.minLng, box.maxLng, Date.now(), limit)
    .all();

  return c.json({
    success: true,
    data: results,
    meta: { count: results.length, bbox: box },
  });
});

// ------------------------------------------------------------
//  Cron — tamatkan laporan lama
// ------------------------------------------------------------
reports.post('/admin/expire', async (c) => {
  const n = await expireStaleReports(c.env.DB);
  return c.json({ success: true, expired: n });
});
