import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import Database from '@tauri-apps/plugin-sql';
import type { SyncPeerRecord } from '../types';
import { isMobileUserAgent } from '../utils/platform';

const DB_URL = 'sqlite:readingbook.db';

export interface DiscoveredPeer {
  deviceId: string;
  deviceName: string;
  ip: string;
  httpPort: number;
  lastSeenMs: number;
}

export interface SyncStatus {
  running: boolean;
  localIp: string | null;
  httpPort: number;
  deviceId: string;
  deviceName: string;
  discoveredPeers: DiscoveredPeer[];
  activePairingCode: string | null;
  pairingExpiresAt: number | null;
}

export interface PairedPeerInfo {
  deviceId: string;
  deviceName: string;
  pairingSecret: string;
  ip: string;
  port: number;
}

export interface SyncResultSummary {
  booksCount: number;
  anchorsCount: number;
  cardsCount: number;
  edgesCount: number;
  filesPulled: number;
  filesPushed: number;
}

interface RawBookRow {
  id: string;
  title: string;
  author: string;
  format: string;
  file_path: string;
  file_sha256: string | null;
  cover_path: string | null;
  cover_sha256: string | null;
  total_paragraphs: number;
  added_at: number;
  last_opened_at: number | null;
  progress: number;
  progress_locator: string | null;
  progress_updated_at: number | null;
  tts_locator: string | null;
  updated_at: number;
  deleted_at: number | null;
}

interface RawAnchorRow {
  id: string;
  book_id: string;
  doc_format: string | null;
  paragraph_id: string;
  epub_cfi: string | null;
  pdf_page: number | null;
  pdf_rects_json: string | null;
  quote: string;
  start_offset: number;
  end_offset: number;
  style: string;
  color: string | null;
  badge_number: number;
  kind: string;
  target_node_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface RawCardRow {
  id: string;
  book_id: string;
  anchor_id: string | null;
  kind: string;
  badge_number: number | null;
  body: string;
  images_json: string;
  status: string | null;
  collapsed: number;
  x: number;
  y: number;
  width: number | null;
  anchor_offset_y: number | null;
  needs_layout: number;
  layout_updated_at: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface RawEdgeRow {
  id: string;
  book_id: string;
  source_card_id: string;
  target_card_id: string;
  color: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface SyncPayload {
  version: number;
  books: RawBookRow[];
  anchors: RawAnchorRow[];
  cards: RawCardRow[];
  edges: RawEdgeRow[];
}

async function getDb(): Promise<Database> {
  return Database.load(DB_URL);
}

export async function getOrCreateDeviceIdentity(): Promise<{
  deviceId: string;
  deviceName: string;
}> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'sync_device'"
  );
  if (rows[0]) {
    try {
      const parsed = JSON.parse(rows[0].value) as {
        deviceId?: string;
        deviceName?: string;
      };
      if (parsed.deviceId && parsed.deviceName) {
        return { deviceId: parsed.deviceId, deviceName: parsed.deviceName };
      }
    } catch {
      // fall through
    }
  }
  const deviceId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const deviceName = isMobileUserAgent() ? 'Android 手机' : 'Mac 桌面端';
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ('sync_device', $1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify({ deviceId, deviceName })]
  );
  return { deviceId, deviceName };
}

export async function listSyncPeers(): Promise<SyncPeerRecord[]> {
  const db = await getDb();
  const rows = await db.select<
    {
      device_id: string;
      device_name: string;
      pairing_secret: string;
      last_sync_at: number;
      last_ip: string | null;
      last_port: number | null;
    }[]
  >('SELECT * FROM sync_peers ORDER BY last_sync_at DESC');
  return rows.map((r) => ({
    deviceId: r.device_id,
    deviceName: r.device_name,
    pairingSecret: r.pairing_secret,
    lastSyncAt: r.last_sync_at,
    lastIp: r.last_ip,
    lastPort: r.last_port,
  }));
}

export async function upsertSyncPeer(peer: PairedPeerInfo): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO sync_peers
       (device_id, device_name, pairing_secret, last_sync_at, last_ip, last_port)
     VALUES ($1, $2, $3, 0, $4, $5)
     ON CONFLICT(device_id) DO UPDATE SET
       device_name = excluded.device_name,
       pairing_secret = excluded.pairing_secret,
       last_ip = excluded.last_ip,
       last_port = excluded.last_port`,
    [peer.deviceId, peer.deviceName, peer.pairingSecret, peer.ip, peer.port]
  );
  await invoke('sync_register_peer_secret', {
    peerDeviceId: peer.deviceId,
    pairingSecret: peer.pairingSecret,
  }).catch(() => {});
}

export async function deleteSyncPeer(deviceId: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM sync_peers WHERE device_id = $1', [deviceId]);
}

export async function updatePeerSyncMeta(
  deviceId: string,
  ip: string,
  port: number
): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE sync_peers SET last_sync_at = $1, last_ip = $2, last_port = $3 WHERE device_id = $4',
    [Date.now(), ip, port, deviceId]
  );
}

export async function exportSyncPayload(): Promise<SyncPayload> {
  const db = await getDb();
  const [books, anchors, cards, edges] = await Promise.all([
    db.select<RawBookRow[]>('SELECT * FROM books'),
    db.select<RawAnchorRow[]>('SELECT * FROM anchors'),
    db.select<RawCardRow[]>('SELECT * FROM cards'),
    db.select<RawEdgeRow[]>('SELECT * FROM edges'),
  ]);
  return { version: 2, books, anchors, cards, edges };
}

export async function mergeSyncPayload(remote: SyncPayload): Promise<{
  booksMerged: number;
  anchorsMerged: number;
  cardsMerged: number;
  edgesMerged: number;
}> {
  const db = await getDb();
  const [localBooks, localAnchors, localCards, localEdges] = await Promise.all([
    db.select<RawBookRow[]>('SELECT * FROM books'),
    db.select<RawAnchorRow[]>('SELECT * FROM anchors'),
    db.select<RawCardRow[]>('SELECT * FROM cards'),
    db.select<RawEdgeRow[]>('SELECT * FROM edges'),
  ]);

  const bookMap = new Map(localBooks.map((r) => [r.id, r]));
  const anchorMap = new Map(localAnchors.map((r) => [r.id, r]));
  const cardMap = new Map(localCards.map((r) => [r.id, r]));
  const edgeMap = new Map(localEdges.map((r) => [r.id, r]));

  let booksMerged = 0;
  let anchorsMerged = 0;
  let cardsMerged = 0;
  let edgesMerged = 0;

  for (const rb of remote.books ?? []) {
    const lb = bookMap.get(rb.id);
    if (!lb) {
      await db.execute(
        `INSERT INTO books
           (id, title, author, format, file_path, file_sha256, cover_path, cover_sha256,
            total_paragraphs, added_at, last_opened_at, progress, progress_locator,
            progress_updated_at, tts_locator, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          rb.id, rb.title, rb.author, rb.format, rb.file_path, rb.file_sha256,
          rb.cover_path, rb.cover_sha256, rb.total_paragraphs, rb.added_at,
          rb.last_opened_at, rb.progress, rb.progress_locator,
          rb.progress_updated_at, rb.tts_locator, rb.updated_at, rb.deleted_at,
        ]
      );
      booksMerged += 1;
    } else {
      const remoteNewerMeta = rb.updated_at > lb.updated_at;
      const remoteNewerProgress =
        (rb.progress_updated_at ?? 0) > (lb.progress_updated_at ?? 0);
      if (remoteNewerMeta || remoteNewerProgress) {
        const nextProgress = remoteNewerProgress ? rb.progress : lb.progress;
        const nextLocator = remoteNewerProgress ? rb.progress_locator : lb.progress_locator;
        const nextProgTs = remoteNewerProgress
          ? rb.progress_updated_at
          : lb.progress_updated_at;
        await db.execute(
          `UPDATE books SET
             title = $1, author = $2, file_sha256 = $3, cover_path = $4, cover_sha256 = $5,
             total_paragraphs = $6, last_opened_at = $7, progress = $8, progress_locator = $9,
             progress_updated_at = $10, tts_locator = $11, updated_at = $12, deleted_at = $13
           WHERE id = $14`,
          [
            remoteNewerMeta ? rb.title : lb.title,
            remoteNewerMeta ? rb.author : lb.author,
            rb.file_sha256 ?? lb.file_sha256,
            remoteNewerMeta ? rb.cover_path : lb.cover_path,
            rb.cover_sha256 ?? lb.cover_sha256,
            Math.max(rb.total_paragraphs, lb.total_paragraphs),
            Math.max(rb.last_opened_at ?? 0, lb.last_opened_at ?? 0) || null,
            nextProgress,
            nextLocator,
            nextProgTs,
            remoteNewerMeta ? rb.tts_locator : lb.tts_locator,
            Math.max(rb.updated_at, lb.updated_at),
            remoteNewerMeta ? rb.deleted_at : lb.deleted_at,
            rb.id,
          ]
        );
        booksMerged += 1;
      }
    }
  }

  for (const ra of remote.anchors ?? []) {
    const la = anchorMap.get(ra.id);
    if (!la) {
      await db.execute(
        `INSERT INTO anchors
           (id, book_id, doc_format, paragraph_id, epub_cfi, pdf_page, pdf_rects_json,
            quote, start_offset, end_offset, style, color, badge_number, kind,
            target_node_id, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          ra.id, ra.book_id, ra.doc_format, ra.paragraph_id, ra.epub_cfi,
          ra.pdf_page, ra.pdf_rects_json, ra.quote, ra.start_offset, ra.end_offset,
          ra.style, ra.color, ra.badge_number, ra.kind, ra.target_node_id,
          ra.created_at, ra.updated_at, ra.deleted_at,
        ]
      );
      anchorsMerged += 1;
    } else if (ra.updated_at > la.updated_at) {
      await db.execute(
        `UPDATE anchors SET
           doc_format = $1, paragraph_id = $2, epub_cfi = $3, pdf_page = $4,
           pdf_rects_json = $5, quote = $6, start_offset = $7, end_offset = $8,
           style = $9, color = $10, badge_number = $11, kind = $12,
           target_node_id = $13, updated_at = $14, deleted_at = $15
         WHERE id = $16`,
        [
          ra.doc_format, ra.paragraph_id, ra.epub_cfi, ra.pdf_page,
          ra.pdf_rects_json, ra.quote, ra.start_offset, ra.end_offset,
          ra.style, ra.color, ra.badge_number, ra.kind, ra.target_node_id,
          ra.updated_at, ra.deleted_at, ra.id,
        ]
      );
      anchorsMerged += 1;
    }
  }

  for (const rc of remote.cards ?? []) {
    const lc = cardMap.get(rc.id);
    if (!lc) {
      await db.execute(
        `INSERT INTO cards
           (id, book_id, anchor_id, kind, badge_number, body, images_json, status,
            collapsed, x, y, width, anchor_offset_y, needs_layout, layout_updated_at,
            created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          rc.id, rc.book_id, rc.anchor_id, rc.kind, rc.badge_number, rc.body,
          rc.images_json, rc.status, rc.collapsed, rc.x, rc.y, rc.width,
          rc.anchor_offset_y, rc.needs_layout, rc.layout_updated_at,
          rc.created_at, rc.updated_at, rc.deleted_at,
        ]
      );
      cardsMerged += 1;
    } else {
      // Independent LWW: content domain (updated_at) vs desktop canvas layout domain (layout_updated_at)
      const contentNewer = rc.updated_at > lc.updated_at;
      const layoutNewer = rc.layout_updated_at > lc.layout_updated_at;
      if (contentNewer || layoutNewer) {
        await db.execute(
          `UPDATE cards SET
             anchor_id = $1, kind = $2, badge_number = $3, body = $4,
             images_json = $5, status = $6, collapsed = $7,
             x = $8, y = $9, width = $10, anchor_offset_y = $11, needs_layout = $12,
             layout_updated_at = $13, updated_at = $14, deleted_at = $15
           WHERE id = $16`,
          [
            contentNewer ? rc.anchor_id : lc.anchor_id,
            contentNewer ? rc.kind : lc.kind,
            contentNewer ? rc.badge_number : lc.badge_number,
            contentNewer ? rc.body : lc.body,
            contentNewer ? rc.images_json : lc.images_json,
            contentNewer ? rc.status : lc.status,
            contentNewer ? rc.collapsed : lc.collapsed,
            layoutNewer ? rc.x : lc.x,
            layoutNewer ? rc.y : lc.y,
            layoutNewer ? rc.width : lc.width,
            layoutNewer ? rc.anchor_offset_y : lc.anchor_offset_y,
            layoutNewer ? rc.needs_layout : lc.needs_layout,
            Math.max(rc.layout_updated_at, lc.layout_updated_at),
            Math.max(rc.updated_at, lc.updated_at),
            contentNewer ? rc.deleted_at : lc.deleted_at,
            rc.id,
          ]
        );
        cardsMerged += 1;
      }
    }
  }

  for (const re of remote.edges ?? []) {
    const le = edgeMap.get(re.id);
    if (!le) {
      await db.execute(
        `INSERT INTO edges
           (id, book_id, source_card_id, target_card_id, color, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          re.id, re.book_id, re.source_card_id, re.target_card_id, re.color,
          re.created_at, re.updated_at, re.deleted_at,
        ]
      );
      edgesMerged += 1;
    } else if (re.updated_at > le.updated_at) {
      await db.execute(
        `UPDATE edges SET
           source_card_id = $1, target_card_id = $2, color = $3,
           updated_at = $4, deleted_at = $5
         WHERE id = $6`,
        [
          re.source_card_id, re.target_card_id, re.color,
          re.updated_at, re.deleted_at, re.id,
        ]
      );
      edgesMerged += 1;
    }
  }

  return { booksMerged, anchorsMerged, cardsMerged, edgesMerged };
}

function collectReferencedFiles(payload: SyncPayload): string[] {
  const paths = new Set<string>();
  for (const b of payload.books) {
    if (b.deleted_at !== null) continue;
    if (b.file_path) paths.add(b.file_path);
    if (b.cover_path) paths.add(b.cover_path);
  }
  for (const c of payload.cards) {
    if (c.deleted_at !== null) continue;
    if (!c.images_json || c.images_json === '[]') continue;
    try {
      const imgs = JSON.parse(c.images_json) as { filePath?: string; thumbPath?: string }[];
      for (const img of imgs) {
        if (img.filePath) paths.add(img.filePath);
        if (img.thumbPath) paths.add(img.thumbPath);
      }
    } catch {
      // ignore malformed
    }
  }
  return Array.from(paths);
}

export async function syncWithPeer(
  peer: SyncPeerRecord,
  ip: string,
  port: number,
  onStatus?: (msg: string) => void
): Promise<SyncResultSummary> {
  onStatus?.('正在导出本地数据…');
  const localPayload = await exportSyncPayload();

  onStatus?.(`正在与 ${peer.deviceName} 交换批注与书库元数据…`);
  const remoteJson = await invoke<string>('sync_exchange_with_peer', {
    ip,
    port,
    pairingSecret: peer.pairingSecret,
    localPayloadJson: JSON.stringify(localPayload),
  });
  const remotePayload = JSON.parse(remoteJson) as SyncPayload;

  onStatus?.('正在合并双向变更…');
  await mergeSyncPayload(remotePayload);

  // Pull missing files referenced by remote
  const remoteFiles = collectReferencedFiles(remotePayload);
  let filesPulled = 0;
  for (let i = 0; i < remoteFiles.length; i += 1) {
    const relPath = remoteFiles[i];
    onStatus?.(`检查并拉取文件 (${i + 1}/${remoteFiles.length})…`);
    const downloaded = await invoke<boolean>('sync_pull_file', {
      ip,
      port,
      pairingSecret: peer.pairingSecret,
      relPath,
    }).catch(() => false);
    if (downloaded) filesPulled += 1;
  }

  // Push local files not yet referenced on remote
  const remoteFileSet = new Set(remoteFiles);
  const localOnlyFiles = collectReferencedFiles(localPayload).filter(
    (p) => !remoteFileSet.has(p)
  );
  let filesPushed = 0;
  for (let i = 0; i < localOnlyFiles.length; i += 1) {
    const relPath = localOnlyFiles[i];
    onStatus?.(`推送本地书籍与附图 (${i + 1}/${localOnlyFiles.length})…`);
    const uploaded = await invoke<boolean>('sync_push_file', {
      ip,
      port,
      pairingSecret: peer.pairingSecret,
      relPath,
    }).catch(() => false);
    if (uploaded) filesPushed += 1;
  }

  await updatePeerSyncMeta(peer.deviceId, ip, port);

  return {
    booksCount: remotePayload.books.length,
    anchorsCount: remotePayload.anchors.length,
    cardsCount: remotePayload.cards.length,
    edgesCount: remotePayload.edges.length,
    filesPulled,
    filesPushed,
  };
}

export async function initSyncHost(
  onLibraryChanged: () => void
): Promise<() => void> {
  const { deviceId, deviceName } = await getOrCreateDeviceIdentity();
  const peers = await listSyncPeers();
  const knownPeers: [string, string][] = peers.map((p) => [
    p.deviceId,
    p.pairingSecret,
  ]);

  await invoke('sync_start', {
    deviceId,
    deviceName,
    knownPeers,
  });

  const unlisteners: UnlistenFn[] = [];

  unlisteners.push(
    await listen<PairedPeerInfo>('sync-paired', (event) => {
      void upsertSyncPeer(event.payload).then(() => onLibraryChanged());
    })
  );

  unlisteners.push(
    await listen<{
      reqId: string;
      peerDeviceId: string;
      payloadJson: string;
    }>('sync-exchange-request', (event) => {
      void (async () => {
        try {
          const localPayload = await exportSyncPayload();
          const remotePayload = JSON.parse(event.payload.payloadJson) as SyncPayload;
          await mergeSyncPayload(remotePayload);
          await invoke('sync_reply_exchange', {
            reqId: event.payload.reqId,
            responseJson: JSON.stringify(localPayload),
          });
          onLibraryChanged();
        } catch (err) {
          console.warn('处理局域网同步请求失败', err);
        }
      })();
    })
  );

  return () => {
    for (const u of unlisteners) u();
  };
}
