CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL,
  file_path TEXT NOT NULL,
  cover_path TEXT,
  total_paragraphs INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  progress REAL NOT NULL DEFAULT 0,
  progress_locator TEXT
);

CREATE INDEX IF NOT EXISTS idx_books_last_opened ON books(last_opened_at DESC);

CREATE TABLE IF NOT EXISTS book_annotations (
  book_id TEXT PRIMARY KEY,
  anchors_json TEXT NOT NULL DEFAULT '[]',
  cards_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
