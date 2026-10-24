// ============================================================
//  Siaran masa nyata — penghubung Worker ↔ Durable Object
// ============================================================

import type { Env, Report, ServerMessage } from '../types';

/** URL pseudohos yang difahami Durable Object. */
const DO_HOST = 'https://grid';

/**
 * Hantar mesej kepada sel ini dan 8 sel jiranan.
 *
 * DO menguruskan penghantaran sebenar; Worker hanya menghantar sekali.
 * Kegagalan DO tidak boleh menggagalkan operasi D1 yang sudah selesai —
 * oleh itu kita `catch` dan seteruskan.
 */
export async function broadcastToCell(
  env: Env,
  cell: string,
  message: ServerMessage,
  targets?: string[],
): Promise<void> {
  try {
    const id = env.GRID.idFromName(cell);
    const stub = env.GRID.get(id);
    await stub.fetch(`${DO_HOST}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, targets }),
    });
  } catch {
    // sel tidak wujud / DO gagal — siaran tempatan tidak berlaku,
    // tetapi laporan sudah tersimpan dan akan muncul apabila muat semula.
  }
}

/** Siar laporan baharu kepada selnya + jiranan. */
export async function publishReport(env: Env, report: Report, cell: string, neighbours: string[]): Promise<void> {
  await broadcastToCell(env, cell, { kind: 'report.new', report }, neighbours);
}

/** Siar pengesahan/dafis kepada sel. */
export async function publishVote(env: Env, cell: string, message: ServerMessage): Promise<void> {
  await broadcastToCell(env, cell, message);
}
