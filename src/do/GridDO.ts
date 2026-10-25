// ============================================================
//  GridDO — Durable Object: siaran masa nyata + geofencing
//
//  Satu instance setiap sel geohash precision 6 (~1.2km x 0.6km).
//  Worker memanggil idFromName(cell) — jadi DO tahu selnya sendiri
//  melalui state.id.toString().
//
//  - Memegang WebSocket pengguna dalam sel itu (hibernasi dibenarkan,
//    jadi ribuan sambungan idle tidak memakan CPU).
//  - Menyiarkan laporan baharu kepada semua peer.
//  - Menghantar ke sel jiranan supaya pengguna di sempadan masih
//    melihat insiden seberang sempadan.
//
//  Kenapa DO dan bukan KV: KV konsisten akhir-akhir dengan latensi
//  tulis+baca 50-100ms — terlalu lambat untuk siaran masa nyata.
//  Hanya DO boleh mengekalkan koneksi WebSocket berterusan.
// ============================================================

import type { ClientMessage, Env, ServerMessage } from '../types';

interface Peer {
  socket: WebSocket;
  /** Sel yang sedang dilanggan (diset pada mesej `subscribe`). */
  cell: string;
  deviceId: string;
  lat: number;
  lng: number;
  /** Profil — pilihan, dan hanya diumumkan dalam `presence`. */
  displayName: string | null;
  gender: string | null;
}

export class GridDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  /** Sel yang dipertanggungjawabkan instance ini. */
  private readonly cell: string;

  private readonly peers = new Map<WebSocket, Peer>();
  private broadcastCount = 0;
  private lastBroadcast = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // idFromName(cell) → state.id.toString() === cell
    this.cell = state.id.toString();
  }

  // ------------------------------------------------------------
  //  Titik masuk HTTP
  // ------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'POST' && url.pathname === '/broadcast') {
      return this.onBroadcast(request);
    }

    if (method === 'GET' && url.pathname === '/status') {
      return Response.json({
        cell: this.cell,
        peers: this.peers.size,
        broadcastCount: this.broadcastCount,
        lastBroadcast: this.lastBroadcast,
        hibernated: this.state.getWebSockets().length,
      });
    }

    if (method === 'GET' && url.pathname === '/ping') {
      const delivered = this.broadcast({ kind: 'pong', ts: Date.now() });
      return Response.json({ ok: true, delivered });
    }

    if (method === 'GET' && request.headers.get('Upgrade') === 'websocket') {
      return this.upgrade();
    }

    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  // ------------------------------------------------------------
  //  WebSocket (API hibernasi — skala besar, CPU rendah)
  // ------------------------------------------------------------
  private upgrade(): Response {
    const limit = Number(this.env.MAX_PEERS_PER_CELL ?? 500);

    // tolak lebih had — lebih baik menolak sekarang daripada gagal tengah siaran
    if (this.state.getWebSockets().length >= limit) {
      return Response.json({ error: 'cell penuh' }, { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernasi: sambungan idle tidak memakan CPU sehingga ada mesej.
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      this.trySend(ws, { kind: 'error', message: 'JSON tidak sah' });
      return;
    }

    // Peer belum wujud sehingga ia melanggan — cipta entri sementara.
    let peer = this.peers.get(ws);
    if (!peer) {
      peer = {
        socket: ws,
        cell: '',
        deviceId: '',
        lat: 0,
        lng: 0,
        displayName: null,
        gender: null,
      };
      this.peers.set(ws, peer);
    }

    switch (msg.kind) {
      case 'subscribe': {
        peer.cell = msg.cell;
        peer.lat = msg.lat;
        peer.lng = msg.lng;
        // Profil boleh jadi undefined (klien lama) atau null (tidak dinyatakan).
        peer.displayName = msg.displayName ?? null;
        peer.gender = msg.gender ?? null;
        // `presence` membawa profil penyerta supaya klien lain dapat
        // mengumumkan "X menyertai" — bukan sekadar menolak bilangan.
        this.trySend(ws, {
          kind: 'presence',
          online: this.state.getWebSockets().length,
          displayName: peer.displayName,
          gender: peer.gender,
        });
        break;
      }
      case 'unsubscribe':
        peer.cell = '';
        break;
      case 'ping':
        this.trySend(ws, { kind: 'pong', ts: Date.now() });
        break;
      case 'report.confirm':
      case 'report.dismiss':
        // Pengesahan/dafis diemas kini oleh Worker, kemudian memanggil
        // semula /broadcast dengan mesej penuh. DO tidak memprosesnya di sini.
        break;
      default:
        this.trySend(ws, { kind: 'error', message: 'Jenis mesej tidak dikenali' });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.peers.delete(ws);
    this.broadcast({ kind: 'presence', online: this.state.getWebSockets().length });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.peers.delete(ws);
  }

  // ------------------------------------------------------------
  //  Siaran
  // ------------------------------------------------------------
  private async onBroadcast(request: Request): Promise<Response> {
    let body: { message?: ServerMessage; targets?: string[] };
    try {
      body = await request.json<{ message?: ServerMessage; targets?: string[] }>();
    } catch {
      return Response.json({ success: false, error: 'JSON tidak sah' }, { status: 400 });
    }
    if (!body.message) {
      return Response.json({ success: false, error: 'Tiada mesej' }, { status: 400 });
    }

    // Siar tempatan dahulu — ini yang dilihat pengguna serta-merta.
    const delivered = this.broadcast(body.message);

    // Kemudian ke sel jiranan. Kegagalan di sini tidak menjejaskan sel ini.
    const targets = body.targets ?? [];
    let fannedOut = 0;
    if (targets.length) fannedOut = await this.fanout(targets, body.message);

    return Response.json({ success: true, delivered, fannedOut });
  }

  /** Siar kepada setiap peer dalam sel ini. Pulangkan bilangan sebenar dihantar. */
  private broadcast(message: ServerMessage): number {
    const payload = JSON.stringify(message);
    let delivered = 0;

    for (const peer of this.peers.values()) {
      // belum melanggan sel → jangan ganggu
      if (!peer.cell) continue;
      try {
        peer.socket.send(payload);
        delivered++;
      } catch {
        this.peers.delete(peer.socket);
      }
    }

    this.broadcastCount++;
    this.lastBroadcast = Date.now();
    return delivered;
  }

  /**
   * Hantar mesej kepada sel jiranan melalui DO masing-masing.
   * Kegagalan satu sel bukan ralat — sel itu sahaja yang terlepas.
   */
  private async fanout(cells: string[], message: ServerMessage): Promise<number> {
    const targets = [...new Set(cells)].filter((c) => c && c !== this.cell);
    if (!targets.length) return 0;

    let sent = 0;
    await Promise.all(
      targets.map(async (cell) => {
        try {
          const stub = this.env.GRID.get(this.env.GRID.idFromName(cell));
          const res = await stub.fetch('https://grid/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
          });
          if (res.ok) sent++;
        } catch {
          // jiran tidak wujud — abaikan
        }
      }),
    );
    return sent;
  }

  private trySend(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // sokongan sudah mati
    }
  }
}
