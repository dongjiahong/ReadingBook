import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import Database from '@tauri-apps/plugin-sql';
import type { SyncPeerRecord } from '../types';
import { isMobileUserAgent } from '../utils/platform';
import { subscribeLocalDataChange, type LocalDataChangeKind } from './db';

const DB_URL = 'sqlite:readingbook.db';
const CONTENT_DEBOUNCE_MS = 1500;
const LIGHT_DEBOUNCE_MS = 5000;
const ERROR_RETRY_DELAY_MS = 5000;
const INCOMING_SETTLE_MS = 1400;

export interface DiscoveredPeer {
  deviceId: string;
  deviceName: string;
  ip: string;
  httpPort: number;
  dataRev: number;
  lastSeenMs: number;
}

export interface SyncStatus {
  running: boolean;
  localIp: string | null;
  httpPort: number;
  deviceId: string;
  deviceName: string;
  dataRev: number;
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
  booksMerged: number;
  anchorsMerged: number;
  cardsMerged: number;
  edgesMerged: number;
  filesPulled: number;
  filesPushed: number;
  updatedBooks: RemoteBookUpdate[];
}

export interface RemoteBookUpdate {
  bookId: string;
  annotationsChanged: boolean;
  progressChanged: boolean;
  progress?: number;
  locator?: string | null;
}

export type SyncPhase =
  | 'unpaired'
  | 'offline'
  | 'synced'
  | 'pending'
  | 'syncing'
  | 'error';

export interface SyncRuntimeSnapshot {
  phase: SyncPhase;
  autoSyncEnabled: boolean;
  pairedCount: number;
  onlinePeerIds: string[];
  onlinePeerNames: string[];
  activePeerName: string | null;
  detail: string | null;
  lastSyncAt: number | null;
  lastSummary: string | null;
  lastError: string | null;
  pendingLocalChanges: boolean;
}

interface PeerSignalEvent {
  deviceId: string;
  deviceName: string;
  ip: string;
  httpPort: number;
  dataRev: number;
  reason: 'online' | 'ip_changed' | 'rev_changed' | string;
}

interface PeerOfflineEvent {
  deviceId: string;
}

interface IncomingActivityEvent {
  peerDeviceId: string;
  phase: 'exchange' | 'file_in' | 'file_out' | string;
  path: string | null;
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

export async function loadAutoSyncEnabled(): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'sync_auto_enabled'"
  );
  if (!rows[0]) return true;
  return rows[0].value !== 'false';
}

export async function saveAutoSyncEnabled(enabled: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ('sync_auto_enabled', $1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [enabled ? 'true' : 'false']
  );
}

export async function computeLocalDataRev(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ max_ts: number | null }[]>(
    `SELECT MAX(ts) AS max_ts FROM (
       SELECT MAX(COALESCE(updated_at, 0)) AS ts FROM books
       UNION ALL
       SELECT MAX(COALESCE(progress_updated_at, 0)) AS ts FROM books
       UNION ALL
       SELECT MAX(COALESCE(updated_at, 0)) AS ts FROM anchors
       UNION ALL
       SELECT MAX(COALESCE(updated_at, 0)) AS ts FROM cards
       UNION ALL
       SELECT MAX(COALESCE(layout_updated_at, 0)) AS ts FROM cards
       UNION ALL
       SELECT MAX(COALESCE(updated_at, 0)) AS ts FROM edges
     )`
  );
  return Number(rows[0]?.max_ts ?? 0) || 0;
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
  void refreshSyncPeerListAndTrigger(peer.deviceId, peer.ip, peer.port);
}

export async function deleteSyncPeer(deviceId: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM sync_peers WHERE device_id = $1', [deviceId]);
  await invoke('sync_unregister_peer_secret', { peerDeviceId: deviceId }).catch(() => {});
  void refreshSyncPeerListAndTrigger();
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
  updatedBooks: RemoteBookUpdate[];
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
  const bookUpdates = new Map<string, RemoteBookUpdate>();
  const touchBook = (bookId: string): RemoteBookUpdate => {
    let entry = bookUpdates.get(bookId);
    if (!entry) {
      entry = { bookId, annotationsChanged: false, progressChanged: false };
      bookUpdates.set(bookId, entry);
    }
    return entry;
  };

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
        if (remoteNewerProgress && rb.deleted_at === null) {
          const u = touchBook(rb.id);
          u.progressChanged = true;
          u.progress = rb.progress;
          u.locator = rb.progress_locator;
        }
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
      touchBook(ra.book_id).annotationsChanged = true;
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
      touchBook(ra.book_id).annotationsChanged = true;
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
      touchBook(rc.book_id).annotationsChanged = true;
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
        touchBook(rc.book_id).annotationsChanged = true;
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
      touchBook(re.book_id).annotationsChanged = true;
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
      touchBook(re.book_id).annotationsChanged = true;
    }
  }

  return {
    booksMerged,
    anchorsMerged,
    cardsMerged,
    edgesMerged,
    updatedBooks: Array.from(bookUpdates.values()),
  };
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

function formatSyncSummary(
  peerName: string,
  res: {
    booksMerged: number;
    anchorsMerged: number;
    cardsMerged: number;
    edgesMerged: number;
    filesPulled: number;
    filesPushed: number;
  }
): string {
  const parts: string[] = [];
  const metaChanges =
    res.booksMerged + res.anchorsMerged + res.cardsMerged + res.edgesMerged;
  if (metaChanges > 0) parts.push(`${metaChanges} 项更新`);
  if (res.filesPulled > 0) parts.push(`拉取 ${res.filesPulled} 个文件`);
  if (res.filesPushed > 0) parts.push(`推送 ${res.filesPushed} 个文件`);
  if (parts.length === 0) return `已与 ${peerName} 保持一致`;
  return `与 ${peerName} 同步：${parts.join('，')}`;
}

export async function syncWithPeer(
  peer: SyncPeerRecord,
  ip: string,
  port: number,
  onStatus?: (msg: string) => void
): Promise<SyncResultSummary> {
  onStatus?.('正在导出本地数据…');
  const localPayload = await exportSyncPayload();

  onStatus?.(`正在与 ${peer.deviceName} 交换数据…`);
  const remoteJson = await invoke<string>('sync_exchange_with_peer', {
    ip,
    port,
    pairingSecret: peer.pairingSecret,
    localPayloadJson: JSON.stringify(localPayload),
  });
  const remotePayload = JSON.parse(remoteJson) as SyncPayload;

  onStatus?.('正在合并双向变更…');
  const merged = await mergeSyncPayload(remotePayload);

  // Pull missing files referenced by remote
  const remoteFiles = collectReferencedFiles(remotePayload);
  let filesPulled = 0;
  for (let i = 0; i < remoteFiles.length; i += 1) {
    const relPath = remoteFiles[i];
    onStatus?.(`检查文件 (${i + 1}/${remoteFiles.length})…`);
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
    onStatus?.(`推送文件 (${i + 1}/${localOnlyFiles.length})…`);
    const uploaded = await invoke<boolean>('sync_push_file', {
      ip,
      port,
      pairingSecret: peer.pairingSecret,
      relPath,
    }).catch(() => false);
    if (uploaded) filesPushed += 1;
  }

  await updatePeerSyncMeta(peer.deviceId, ip, port);
  const nextRev = await computeLocalDataRev();
  await invoke('sync_set_data_rev', { dataRev: nextRev }).catch(() => {});

  return {
    booksCount: remotePayload.books.length,
    anchorsCount: remotePayload.anchors.length,
    cardsCount: remotePayload.cards.length,
    edgesCount: remotePayload.edges.length,
    booksMerged: merged.booksMerged,
    anchorsMerged: merged.anchorsMerged,
    cardsMerged: merged.cardsMerged,
    edgesMerged: merged.edgesMerged,
    filesPulled,
    filesPushed,
    updatedBooks: merged.updatedBooks,
  };
}

// ---------------------------------------------------------------------------
// Event-Driven Active Sync Runtime Controller
// ---------------------------------------------------------------------------

interface OnlinePeerInfo {
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  dataRev: number;
}

type RuntimeListener = (snapshot: SyncRuntimeSnapshot) => void;
type RemoteUpdateListener = (updates: RemoteBookUpdate[]) => void;

const runtimeListeners = new Set<RuntimeListener>();
const remoteUpdateListeners = new Set<RemoteUpdateListener>();

let myDeviceId = '';
let autoSyncEnabled = true;
let pairedPeers: SyncPeerRecord[] = [];
const onlinePeers = new Map<string, OnlinePeerInfo>();
const lastSyncedPeerRev = new Map<string, number>();

let localDataRev = 0;
let pendingLocalChanges = false;
let localChangeSeq = 0;
let syncingCount = 0;
let incomingActive = false;
let activePeerName: string | null = null;
let detailMsg: string | null = null;
let lastSyncAt: number | null = null;
let lastSummary: string | null = null;
let lastError: string | null = null;

let debounceTimer: number | null = null;
let debounceTargetAt = 0;
let retryTimer: number | null = null;
let hasRetriedOnce = false;
let incomingSettleTimer: number | null = null;
let peerDelayTimers = new Map<string, number>();
let lastForegroundProbeAt = 0;

let inFlight: Promise<void> | null = null;
let resyncAfterFlight = false;
let libraryChangedCallback: (() => void) | null = null;

function computePhase(): SyncPhase {
  if (syncingCount > 0 || incomingActive) return 'syncing';
  if (pairedPeers.length === 0) return 'unpaired';
  if (lastError) return 'error';
  if (pendingLocalChanges) return 'pending';
  if (onlinePeers.size === 0) return 'offline';
  return 'synced';
}

export function getSyncRuntimeSnapshot(): SyncRuntimeSnapshot {
  const onlineList = Array.from(onlinePeers.values());
  return {
    phase: computePhase(),
    autoSyncEnabled,
    pairedCount: pairedPeers.length,
    onlinePeerIds: onlineList.map((p) => p.deviceId),
    onlinePeerNames: onlineList.map((p) => p.deviceName),
    activePeerName,
    detail: detailMsg,
    lastSyncAt,
    lastSummary,
    lastError,
    pendingLocalChanges,
  };
}

function emitRuntimeSnapshot(): void {
  const snap = getSyncRuntimeSnapshot();
  for (const listener of runtimeListeners) {
    try {
      listener(snap);
    } catch {
      // ignore
    }
  }
}

function emitRemoteUpdates(updates: RemoteBookUpdate[]): void {
  if (updates.length === 0) return;
  for (const listener of remoteUpdateListeners) {
    try {
      listener(updates);
    } catch {
      // ignore
    }
  }
}

export function subscribeSyncRuntime(listener: RuntimeListener): () => void {
  runtimeListeners.add(listener);
  listener(getSyncRuntimeSnapshot());
  return () => {
    runtimeListeners.delete(listener);
  };
}

export function subscribeRemoteSyncUpdates(listener: RemoteUpdateListener): () => void {
  remoteUpdateListeners.add(listener);
  return () => {
    remoteUpdateListeners.delete(listener);
  };
}

export async function setAutoSyncEnabled(enabled: boolean): Promise<void> {
  autoSyncEnabled = enabled;
  await saveAutoSyncEnabled(enabled);
  if (!enabled) {
    clearDebounceTimer();
    clearRetryTimer();
    for (const t of peerDelayTimers.values()) window.clearTimeout(t);
    peerDelayTimers.clear();
  } else if (pendingLocalChanges && onlinePeers.size > 0) {
    scheduleDebouncedSync(300);
  }
  emitRuntimeSnapshot();
}

function clearDebounceTimer(): void {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    debounceTargetAt = 0;
  }
}

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleDebouncedSync(delayMs: number): void {
  if (!autoSyncEnabled || pairedPeers.length === 0) return;
  const now = Date.now();
  const targetAt = now + delayMs;
  // If an earlier deadline is already scheduled (e.g. content change before a later progress change), keep the earlier one.
  if (debounceTimer !== null && debounceTargetAt <= targetAt) {
    return;
  }
  clearDebounceTimer();
  debounceTargetAt = targetAt;
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    debounceTargetAt = 0;
    void syncAllOnlinePeers('local_change');
  }, delayMs);
}

async function refreshSyncPeerListAndTrigger(
  justPairedId?: string,
  justPairedIp?: string,
  justPairedPort?: number
): Promise<void> {
  pairedPeers = await listSyncPeers();
  const pairedSet = new Set(pairedPeers.map((p) => p.deviceId));
  for (const id of Array.from(onlinePeers.keys())) {
    if (!pairedSet.has(id)) onlinePeers.delete(id);
  }
  const latestSync = pairedPeers.reduce(
    (max, p) => (p.lastSyncAt > max ? p.lastSyncAt : max),
    0
  );
  if (latestSync > 0 && (!lastSyncAt || latestSync > lastSyncAt)) {
    lastSyncAt = latestSync;
  }

  if (justPairedId && justPairedIp && justPairedPort) {
    const peer = pairedPeers.find((p) => p.deviceId === justPairedId);
    if (peer) {
      onlinePeers.set(peer.deviceId, {
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        ip: justPairedIp,
        port: justPairedPort,
        dataRev: 0,
      });
    }
  }
  emitRuntimeSnapshot();

  if (justPairedId && autoSyncEnabled) {
    scheduleDebouncedSync(300);
  }
}

async function runSinglePeerSync(
  peer: SyncPeerRecord,
  ip: string,
  port: number,
  reason: string
): Promise<SyncResultSummary> {
  const startSeq = localChangeSeq;
  syncingCount += 1;
  activePeerName = peer.deviceName;
  detailMsg = `正在与 ${peer.deviceName} 同步…`;
  lastError = null;
  emitRuntimeSnapshot();

  try {
    const res = await syncWithPeer(peer, ip, port, (msg) => {
      detailMsg = msg;
      emitRuntimeSnapshot();
    });
    localDataRev = await computeLocalDataRev();
    const online = onlinePeers.get(peer.deviceId);
    if (online) {
      online.dataRev = localDataRev;
    }
    lastSyncedPeerRev.set(peer.deviceId, localDataRev);
    if (localChangeSeq === startSeq) {
      pendingLocalChanges = false;
    }
    lastSyncAt = Date.now();
    lastSummary = formatSyncSummary(peer.deviceName, res);
    lastError = null;
    hasRetriedOnce = false;
    clearRetryTimer();

    if (
      res.booksMerged > 0 ||
      res.anchorsMerged > 0 ||
      res.cardsMerged > 0 ||
      res.edgesMerged > 0 ||
      res.filesPulled > 0
    ) {
      libraryChangedCallback?.();
      emitRemoteUpdates(res.updatedBooks);
    }
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastError = msg;
    // One-shot short backoff retry for transient network hiccups, then wait for next online signal
    if (reason !== 'manual' && autoSyncEnabled && !hasRetriedOnce && onlinePeers.has(peer.deviceId)) {
      hasRetriedOnce = true;
      clearRetryTimer();
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void syncAllOnlinePeers('retry');
      }, ERROR_RETRY_DELAY_MS);
    }
    throw err;
  } finally {
    syncingCount = Math.max(0, syncingCount - 1);
    if (syncingCount === 0) {
      activePeerName = null;
      detailMsg = null;
    }
    emitRuntimeSnapshot();
  }
}

export async function triggerManualSyncPeer(
  peer: SyncPeerRecord,
  ip: string,
  port: number
): Promise<SyncResultSummary> {
  clearDebounceTimer();
  clearRetryTimer();
  const res = await runSinglePeerSync(peer, ip, port, 'manual');
  pairedPeers = await listSyncPeers();
  emitRuntimeSnapshot();
  return res;
}

async function syncAllOnlinePeers(reason: string, targetPeerId?: string): Promise<void> {
  if (inFlight) {
    resyncAfterFlight = true;
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const candidates = pairedPeers.filter((p) => {
        if (targetPeerId && p.deviceId !== targetPeerId) return false;
        return onlinePeers.has(p.deviceId);
      });
      if (candidates.length === 0) {
        emitRuntimeSnapshot();
        return;
      }

      for (const peer of candidates) {
        const online = onlinePeers.get(peer.deviceId);
        if (!online) continue;
        try {
          await runSinglePeerSync(peer, online.ip, online.port, reason);
        } catch {
          // error state already recorded inside runSinglePeerSync
        }
      }
      pairedPeers = await listSyncPeers();
      emitRuntimeSnapshot();
    } finally {
      inFlight = null;
      if (resyncAfterFlight && autoSyncEnabled && onlinePeers.size > 0) {
        resyncAfterFlight = false;
        scheduleDebouncedSync(400);
      }
    }
  })();

  return inFlight;
}

export function flushPendingSyncNow(): void {
  if (!autoSyncEnabled || !pendingLocalChanges) return;
  clearDebounceTimer();
  if (onlinePeers.size > 0) {
    void syncAllOnlinePeers('flush');
  }
}

export async function probeOnForeground(): Promise<void> {
  const now = Date.now();
  if (now - lastForegroundProbeAt < 2500) return;
  lastForegroundProbeAt = now;

  // Wake UDP broadcaster immediately so peers learn we are back
  await invoke('sync_announce_now').catch(() => {});

  if (!autoSyncEnabled || pairedPeers.length === 0) return;

  // Also refresh current discovered peers from Rust & ping last known IP if UDP hasn't arrived yet
  try {
    const st = await invoke<SyncStatus>('sync_get_status');
    for (const d of st.discoveredPeers) {
      if (pairedPeers.some((p) => p.deviceId === d.deviceId)) {
        onlinePeers.set(d.deviceId, {
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          ip: d.ip,
          port: d.httpPort,
          dataRev: d.dataRev ?? 0,
        });
      }
    }

    // For paired peers not yet in UDP cache, do a single lightweight ping to lastIp
    await Promise.all(
      pairedPeers.map(async (p) => {
        if (onlinePeers.has(p.deviceId) || !p.lastIp) return;
        const port = p.lastPort ?? 45889;
        const ok = await invoke<boolean>('sync_ping_peer', {
          ip: p.lastIp,
          port,
        }).catch(() => false);
        if (ok) {
          onlinePeers.set(p.deviceId, {
            deviceId: p.deviceId,
            deviceName: p.deviceName,
            ip: p.lastIp,
            port,
            dataRev: 0,
          });
        }
      })
    );

    emitRuntimeSnapshot();

    if (onlinePeers.size > 0) {
      const needsSync =
        pendingLocalChanges ||
        Array.from(onlinePeers.values()).some(
          (p) =>
            p.dataRev !== localDataRev ||
            lastSyncedPeerRev.get(p.deviceId) === undefined
        );
      if (needsSync) {
        void syncAllOnlinePeers('foreground');
      }
    }
  } catch {
    // ignore transient probe errors
  }
}

function handleLocalChange(kind: LocalDataChangeKind): void {
  localChangeSeq += 1;
  pendingLocalChanges = true;
  lastError = null;
  hasRetriedOnce = false;
  emitRuntimeSnapshot();

  void computeLocalDataRev()
    .then((rev) => {
      localDataRev = rev;
      return invoke('sync_set_data_rev', { dataRev: rev });
    })
    .catch(() => {});

  if (!autoSyncEnabled || pairedPeers.length === 0) return;
  if (onlinePeers.size > 0) {
    const delay = kind === 'content' ? CONTENT_DEBOUNCE_MS : LIGHT_DEBOUNCE_MS;
    scheduleDebouncedSync(delay);
  }
}

function handlePeerSignal(ev: PeerSignalEvent): void {
  const peer = pairedPeers.find((p) => p.deviceId === ev.deviceId);
  if (!peer) return;

  onlinePeers.set(ev.deviceId, {
    deviceId: ev.deviceId,
    deviceName: ev.deviceName || peer.deviceName,
    ip: ev.ip,
    port: ev.httpPort,
    dataRev: ev.dataRev ?? 0,
  });

  if (ev.reason === 'online' || ev.reason === 'ip_changed') {
    hasRetriedOnce = false;
  }
  emitRuntimeSnapshot();

  if (!autoSyncEnabled) return;

  const knownRev = lastSyncedPeerRev.get(ev.deviceId);
  const revDiff = ev.dataRev !== localDataRev;
  const firstSeen = knownRev === undefined;

  if (!pendingLocalChanges && !revDiff && !firstSeen) {
    return;
  }

  // Cancel any earlier pending timer for this peer
  const prevTimer = peerDelayTimers.get(ev.deviceId);
  if (prevTimer !== undefined) {
    window.clearTimeout(prevTimer);
    peerDelayTimers.delete(ev.deviceId);
  }

  // Tie-breaker to prevent simultaneous mutual pushes:
  // - If we have local dirty changes -> we push quickly (300ms)
  // - If peer's rev changed -> give peer a 1200ms head start to push to us; pull if still behind
  // - If peer just came online -> higher deviceId initiates quickly (350ms), lower waits 1600ms as fallback
  let delayMs = 350;
  if (pendingLocalChanges) {
    delayMs = 300;
  } else if (ev.reason === 'rev_changed') {
    delayMs = 1200;
  } else if (myDeviceId < ev.deviceId) {
    delayMs = 1600;
  }

  const timerId = window.setTimeout(() => {
    peerDelayTimers.delete(ev.deviceId);
    const currentOnline = onlinePeers.get(ev.deviceId);
    if (!currentOnline || !autoSyncEnabled) return;
    // Re-check if already converged via an incoming sync during the grace window
    if (
      !pendingLocalChanges &&
      currentOnline.dataRev === localDataRev &&
      lastSyncedPeerRev.get(ev.deviceId) === localDataRev
    ) {
      return;
    }
    void syncAllOnlinePeers(`signal:${ev.reason}`, ev.deviceId);
  }, delayMs);
  peerDelayTimers.set(ev.deviceId, timerId);
}

function handlePeerOffline(ev: PeerOfflineEvent): void {
  if (onlinePeers.delete(ev.deviceId)) {
    const prevTimer = peerDelayTimers.get(ev.deviceId);
    if (prevTimer !== undefined) {
      window.clearTimeout(prevTimer);
      peerDelayTimers.delete(ev.deviceId);
    }
    emitRuntimeSnapshot();
  }
}

function markIncomingActivity(ev: IncomingActivityEvent): void {
  const peer = pairedPeers.find((p) => p.deviceId === ev.peerDeviceId);
  const name = peer?.deviceName ?? '配对设备';
  incomingActive = true;
  activePeerName = name;
  if (ev.phase === 'exchange') {
    detailMsg = `正在接收 ${name} 的同步…`;
  } else if (ev.phase === 'file_in') {
    detailMsg = `正在接收文件…`;
  } else if (ev.phase === 'file_out') {
    detailMsg = `正在向 ${name} 发送文件…`;
  }
  lastError = null;
  emitRuntimeSnapshot();

  if (incomingSettleTimer !== null) window.clearTimeout(incomingSettleTimer);
  incomingSettleTimer = window.setTimeout(() => {
    incomingSettleTimer = null;
    incomingActive = false;
    if (syncingCount === 0) {
      activePeerName = null;
      detailMsg = null;
    }
    emitRuntimeSnapshot();
  }, INCOMING_SETTLE_MS);
}

export async function initSyncHost(
  onLibraryChanged: () => void
): Promise<() => void> {
  libraryChangedCallback = onLibraryChanged;
  const [{ deviceId, deviceName }, peers, autoEnabled, initialRev] = await Promise.all([
    getOrCreateDeviceIdentity(),
    listSyncPeers(),
    loadAutoSyncEnabled(),
    computeLocalDataRev(),
  ]);

  myDeviceId = deviceId;
  pairedPeers = peers;
  autoSyncEnabled = autoEnabled;
  localDataRev = initialRev;
  const latestSync = peers.reduce(
    (max, p) => (p.lastSyncAt > max ? p.lastSyncAt : max),
    0
  );
  if (latestSync > 0) lastSyncAt = latestSync;

  const knownPeers: [string, string][] = peers.map((p) => [
    p.deviceId,
    p.pairingSecret,
  ]);

  const initialStatus = await invoke<SyncStatus>('sync_start', {
    deviceId,
    deviceName,
    knownPeers,
    dataRev: initialRev,
  });

  for (const d of initialStatus.discoveredPeers) {
    if (pairedPeers.some((p) => p.deviceId === d.deviceId)) {
      onlinePeers.set(d.deviceId, {
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        ip: d.ip,
        port: d.httpPort,
        dataRev: d.dataRev ?? 0,
      });
    }
  }
  emitRuntimeSnapshot();

  const unlisteners: UnlistenFn[] = [];

  unlisteners.push(
    await listen<PairedPeerInfo>('sync-paired', (event) => {
      void upsertSyncPeer(event.payload).then(() => onLibraryChanged());
    })
  );

  unlisteners.push(
    await listen<PeerSignalEvent>('sync-peer-signal', (event) => {
      handlePeerSignal(event.payload);
    })
  );

  unlisteners.push(
    await listen<PeerOfflineEvent>('sync-peer-offline', (event) => {
      handlePeerOffline(event.payload);
    })
  );

  unlisteners.push(
    await listen<IncomingActivityEvent>('sync-incoming-activity', (event) => {
      markIncomingActivity(event.payload);
    })
  );

  unlisteners.push(
    await listen<{
      reqId: string;
      peerDeviceId: string;
      payloadJson: string;
    }>('sync-exchange-request', (event) => {
      void (async () => {
        const startSeq = localChangeSeq;
        try {
          const peer = pairedPeers.find(
            (p) => p.deviceId === event.payload.peerDeviceId
          );
          const peerName = peer?.deviceName ?? '配对设备';
          const localPayload = await exportSyncPayload();
          const remotePayload = JSON.parse(event.payload.payloadJson) as SyncPayload;
          const merged = await mergeSyncPayload(remotePayload);
          await invoke('sync_reply_exchange', {
            reqId: event.payload.reqId,
            responseJson: JSON.stringify(localPayload),
          });

          localDataRev = await computeLocalDataRev();
          await invoke('sync_set_data_rev', { dataRev: localDataRev }).catch(() => {});
          lastSyncedPeerRev.set(event.payload.peerDeviceId, localDataRev);
          const online = onlinePeers.get(event.payload.peerDeviceId);
          if (online) online.dataRev = localDataRev;
          if (localChangeSeq === startSeq) {
            pendingLocalChanges = false;
          }
          lastSyncAt = Date.now();
          lastSummary = formatSyncSummary(peerName, {
            ...merged,
            filesPulled: 0,
            filesPushed: 0,
          });
          lastError = null;
          emitRuntimeSnapshot();

          if (
            merged.booksMerged > 0 ||
            merged.anchorsMerged > 0 ||
            merged.cardsMerged > 0 ||
            merged.edgesMerged > 0
          ) {
            onLibraryChanged();
            emitRemoteUpdates(merged.updatedBooks);
          }
        } catch (err) {
          console.warn('处理局域网同步请求失败', err);
        }
      })();
    })
  );

  const unsubLocal = subscribeLocalDataChange((ev) => {
    handleLocalChange(ev.kind);
  });

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      flushPendingSyncNow();
    } else if (document.visibilityState === 'visible') {
      void probeOnForeground();
    }
  };
  const onFocus = () => {
    void probeOnForeground();
  };
  const onOnline = () => {
    void probeOnForeground();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);

  // Trigger an initial foreground probe shortly after startup
  const startupProbe = window.setTimeout(() => {
    void probeOnForeground();
  }, 800);

  return () => {
    window.clearTimeout(startupProbe);
    clearDebounceTimer();
    clearRetryTimer();
    if (incomingSettleTimer !== null) {
      window.clearTimeout(incomingSettleTimer);
      incomingSettleTimer = null;
    }
    for (const t of peerDelayTimers.values()) window.clearTimeout(t);
    peerDelayTimers.clear();
    unsubLocal();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
    for (const u of unlisteners) u();
  };
}
