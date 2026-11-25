CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_sha256 TEXT,
  cover_path TEXT,
  cover_sha256 TEXT,
  total_paragraphs INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  progress REAL NOT NULL DEFAULT 0,
  progress_locator TEXT,
  progress_updated_at INTEGER,
  tts_locator TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_books_last_opened
  ON books(deleted_at, last_opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_updated
  ON books(updated_at);

CREATE TABLE IF NOT EXISTS anchors (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  doc_format TEXT,
  paragraph_id TEXT NOT NULL,
  epub_cfi TEXT,
  pdf_page INTEGER,
  pdf_rects_json TEXT,
  quote TEXT NOT NULL DEFAULT '',
  start_offset INTEGER NOT NULL DEFAULT 0,
  end_offset INTEGER NOT NULL DEFAULT 0,
  style TEXT NOT NULL DEFAULT 'highlight',
  color TEXT,
  badge_number INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'thought',
  target_node_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_anchors_book
  ON anchors(book_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_anchors_updated
  ON anchors(updated_at);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  anchor_id TEXT,
  kind TEXT NOT NULL DEFAULT 'thought',
  badge_number INTEGER,
  body TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  status TEXT,
  collapsed INTEGER NOT NULL DEFAULT 0,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  width REAL,
  anchor_offset_y REAL,
  needs_layout INTEGER NOT NULL DEFAULT 0,
  layout_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cards_book
  ON cards(book_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_cards_updated
  ON cards(updated_at);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  source_card_id TEXT NOT NULL,
  target_card_id TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_edges_book
  ON edges(book_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_edges_updated
  ON edges(updated_at);

CREATE TABLE IF NOT EXISTS sync_peers (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  pairing_secret TEXT NOT NULL,
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  last_ip TEXT,
  last_port INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
