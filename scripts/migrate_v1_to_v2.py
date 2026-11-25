#!/usr/bin/env python3
"""
Standalone one-time migration tool: ReadingBook SQLite v1 -> v2.

Converts the legacy per-book JSON snapshot table (`book_annotations`) into the
normalized v2 tables (`books`, `anchors`, `cards`, `edges`, `sync_peers`,
`settings`) without adding any legacy compatibility code into the app itself.

Usage:
  # Dry run on the default macOS app database
  python3 scripts/migrate_v1_to_v2.py --dry-run

  # Migrate the default macOS app database (creates a timestamped backup first)
  python3 scripts/migrate_v1_to_v2.py

  # Migrate a specific backup or custom path
  python3 scripts/migrate_v1_to_v2.py --db /path/to/readingbook.db
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

DEFAULT_APP_DIR = Path.home() / "Library" / "Application Support" / "com.readingbook.app"
DEFAULT_DB_PATH = DEFAULT_APP_DIR / "readingbook.db"

V2_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS books_v2 (
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
"""


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def is_readingbook_running() -> bool:
    try:
        res = subprocess.run(
            ["pgrep", "-x", "ReadingBook"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return res.returncode == 0
    except FileNotFoundError:
        return False


def get_table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {r[0] for r in rows}


def sanitize_images(images: Any, app_data_dir: Path | None) -> tuple[str, int]:
    if not isinstance(images, list) or not images:
        return "[]", 0
    cleaned: list[dict[str, Any]] = []
    for img in images:
        if not isinstance(img, dict):
            continue
        item: dict[str, Any] = {
            "id": str(img.get("id", "")),
            "thumbUrl": "",
            "width": img.get("width", 0),
            "height": img.get("height", 0),
        }
        if img.get("filePath"):
            item["filePath"] = img["filePath"]
            if app_data_dir:
                digest = sha256_file(app_data_dir / img["filePath"])
                if digest:
                    item["sha256"] = digest
        if img.get("thumbPath"):
            item["thumbPath"] = img["thumbPath"]
        if img.get("sha256") and "sha256" not in item:
            item["sha256"] = img["sha256"]
        cleaned.append(item)
    return json.dumps(cleaned, ensure_ascii=False), len(cleaned)


def backup_db(db_path: Path) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = db_path.parent / f"backup_v1_{stamp}"
    backup_dir.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        src = Path(f"{db_path}{suffix}")
        if src.is_file():
            shutil.copy2(src, backup_dir / src.name)
    return backup_dir


def migrate(db_path: Path, app_data_dir: Path | None, dry_run: bool, force: bool) -> int:
    if not db_path.is_file():
        print(f"[ERROR] Database not found: {db_path}", file=sys.stderr)
        return 1

    if not dry_run and not force and db_path.resolve() == DEFAULT_DB_PATH.resolve():
        if is_readingbook_running():
            print(
                "[ERROR] ReadingBook is currently running. Quit the app first "
                "(or pass --force if you are sure it is not using this DB).",
                file=sys.stderr,
            )
            return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    try:
        tables = get_table_names(conn)
        has_legacy = "book_annotations" in tables
        has_v2 = {"anchors", "cards", "edges"}.issubset(tables)

        if not has_legacy and has_v2:
            print(f"[OK] {db_path} is already on schema v2. Nothing to do.")
            return 0

        if not has_legacy:
            print(
                f"[ERROR] Neither legacy `book_annotations` nor v2 tables found in {db_path}.",
                file=sys.stderr,
            )
            return 1

        books = conn.execute("SELECT * FROM books").fetchall()
        ann_rows = conn.execute("SELECT * FROM book_annotations").fetchall()
        ann_by_book = {r["book_id"]: r for r in ann_rows}

        print(f"Target DB : {db_path}")
        print(f"App Data  : {app_data_dir if app_data_dir else '(not provided, skipping sha256)'}")
        print(f"Books     : {len(books)}")
        print(f"Annotated : {len(ann_rows)}")

        # Pre-parse and validate JSON before touching anything
        parsed_plan: list[dict[str, Any]] = []
        total_anchors = 0
        total_cards = 0
        total_edges = 0
        total_images = 0

        for row in ann_rows:
            anchors = json.loads(row["anchors_json"] or "[]")
            cards = json.loads(row["cards_json"] or "[]")
            edges = json.loads(row["edges_json"] or "[]")
            img_count = sum(
                len(c.get("images", []))
                for c in cards
                if isinstance(c, dict) and isinstance(c.get("images"), list)
            )
            total_anchors += len(anchors)
            total_cards += len(cards)
            total_edges += len(edges)
            total_images += img_count
            parsed_plan.append(
                {
                    "book_id": row["book_id"],
                    "updated_at": row["updated_at"] or int(time.time() * 1000),
                    "anchors": anchors,
                    "cards": cards,
                    "edges": edges,
                    "img_count": img_count,
                }
            )

        print(
            f"Records   : {total_anchors} anchors, {total_cards} cards "
            f"({total_images} images), {total_edges} edges"
        )

        if dry_run:
            print("[DRY-RUN] JSON parsing succeeded. No changes were written.")
            return 0

        # Checkpoint WAL cleanly before making backup
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()

        backup_dir = backup_db(db_path)
        print(f"[BACKUP] Saved v1 backup to: {backup_dir}")

        conn = sqlite3.connect(str(db_path), isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")

        try:
            for stmt in V2_SCHEMA_SQL.split(";"):
                stmt = stmt.strip()
                if stmt:
                    conn.execute(stmt)

            # 1. Migrate books into books_v2
            now_ms = int(time.time() * 1000)
            for b in books:
                ann_ts = ann_by_book[b["id"]]["updated_at"] if b["id"] in ann_by_book else 0
                updated_at = max(
                    b["added_at"] or 0,
                    b["last_opened_at"] or 0,
                    ann_ts or 0,
                ) or now_ms
                file_sha = sha256_file(app_data_dir / b["file_path"]) if app_data_dir and b["file_path"] else None
                cover_sha = sha256_file(app_data_dir / b["cover_path"]) if app_data_dir and b["cover_path"] else None
                progress_updated_at = b["last_opened_at"] if b["progress"] or b["progress_locator"] else None

                conn.execute(
                    """
                    INSERT INTO books_v2 (
                      id, title, author, format, file_path, file_sha256,
                      cover_path, cover_sha256, total_paragraphs, added_at,
                      last_opened_at, progress, progress_locator,
                      progress_updated_at, tts_locator, updated_at, deleted_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
                    """,
                    (
                        b["id"],
                        b["title"],
                        b["author"],
                        b["format"],
                        b["file_path"],
                        file_sha,
                        b["cover_path"],
                        cover_sha,
                        b["total_paragraphs"],
                        b["added_at"],
                        b["last_opened_at"],
                        b["progress"],
                        b["progress_locator"],
                        progress_updated_at,
                        updated_at,
                    ),
                )

            conn.execute("DROP TABLE books")
            conn.execute("ALTER TABLE books_v2 RENAME TO books")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_books_last_opened ON books(deleted_at, last_opened_at DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_books_updated ON books(updated_at)"
            )

            # 2. Migrate anchors, cards, edges
            migrated_images = 0
            for entry in parsed_plan:
                book_id = entry["book_id"]
                ts = entry["updated_at"]

                for a in entry["anchors"]:
                    pdf_rects = a.get("pdfRects")
                    pdf_rects_json = (
                        json.dumps(pdf_rects, ensure_ascii=False)
                        if isinstance(pdf_rects, list) and pdf_rects
                        else None
                    )
                    conn.execute(
                        """
                        INSERT INTO anchors (
                          id, book_id, doc_format, paragraph_id, epub_cfi, pdf_page,
                          pdf_rects_json, quote, start_offset, end_offset, style,
                          color, badge_number, kind, target_node_id,
                          created_at, updated_at, deleted_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                        """,
                        (
                            a["id"],
                            book_id,
                            a.get("docFormat"),
                            a.get("paragraphId", ""),
                            a.get("epubCfi"),
                            a.get("pdfPage"),
                            pdf_rects_json,
                            a.get("quote", ""),
                            int(a.get("startOffset", 0)),
                            int(a.get("endOffset", 0)),
                            a.get("style", "highlight"),
                            a.get("color"),
                            int(a.get("badgeNumber", 0)),
                            a.get("kind", "thought"),
                            a.get("targetNodeId"),
                            ts,
                            ts,
                        ),
                    )

                for c in entry["cards"]:
                    images_json, img_n = sanitize_images(c.get("images"), app_data_dir)
                    migrated_images += img_n
                    conn.execute(
                        """
                        INSERT INTO cards (
                          id, book_id, anchor_id, kind, badge_number, body,
                          images_json, status, collapsed, x, y, width,
                          anchor_offset_y, needs_layout, layout_updated_at,
                          created_at, updated_at, deleted_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL)
                        """,
                        (
                            c["id"],
                            book_id,
                            c.get("anchorId"),
                            c.get("kind", "thought"),
                            c.get("badgeNumber"),
                            c.get("body", ""),
                            images_json,
                            c.get("status"),
                            1 if c.get("collapsed") else 0,
                            float(c.get("x", 0)),
                            float(c.get("y", 0)),
                            c.get("width"),
                            c.get("anchorOffsetY"),
                            ts,
                            ts,
                            ts,
                        ),
                    )

                for e in entry["edges"]:
                    conn.execute(
                        """
                        INSERT INTO edges (
                          id, book_id, source_card_id, target_card_id, color,
                          created_at, updated_at, deleted_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                        """,
                        (
                            e["id"],
                            book_id,
                            e["source"],
                            e["target"],
                            e.get("color"),
                            ts,
                            ts,
                        ),
                    )

            # 3. Verify exact counts before dropping legacy table
            actual_books = conn.execute("SELECT COUNT(*) FROM books").fetchone()[0]
            actual_anchors = conn.execute("SELECT COUNT(*) FROM anchors").fetchone()[0]
            actual_cards = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
            actual_edges = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]

            assert actual_books == len(books), f"books mismatch: {actual_books} != {len(books)}"
            assert actual_anchors == total_anchors, f"anchors mismatch: {actual_anchors} != {total_anchors}"
            assert actual_cards == total_cards, f"cards mismatch: {actual_cards} != {total_cards}"
            assert actual_edges == total_edges, f"edges mismatch: {actual_edges} != {total_edges}"
            assert migrated_images == total_images, f"images mismatch: {migrated_images} != {total_images}"

            # 4. Drop legacy snapshot table & reset _sqlx_migrations so Tauri 2
            #    cleanly registers the new v2 0001_init.sql without checksum mismatch.
            conn.execute("DROP TABLE book_annotations")
            conn.execute("DROP TABLE IF EXISTS _sqlx_migrations")

            conn.execute("COMMIT")
            print(
                f"[SUCCESS] Migrated {actual_books} books, {actual_anchors} anchors, "
                f"{actual_cards} cards ({migrated_images} images), {actual_edges} edges."
            )
            return 0

        except Exception as exc:
            conn.execute("ROLLBACK")
            print(f"[ERROR] Migration failed and was rolled back: {exc}", file=sys.stderr)
            print(f"[INFO] Your v1 backup is safe at: {backup_dir}", file=sys.stderr)
            return 1

    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate ReadingBook SQLite DB from v1 to v2.")
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        help=f"Path to readingbook.db (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--app-data-dir",
        type=Path,
        default=None,
        help="App data directory containing books/covers/images for SHA-256 computation "
        "(defaults to parent directory of --db).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and print counts without modifying the database.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run even if ReadingBook process appears to be running.",
    )
    args = parser.parse_args()

    db_path = args.db.expanduser()
    app_data_dir = (
        args.app_data_dir.expanduser()
        if args.app_data_dir
        else db_path.parent
    )
    return migrate(db_path, app_data_dir, dry_run=args.dry_run, force=args.force)


if __name__ == "__main__":
    raise SystemExit(main())
