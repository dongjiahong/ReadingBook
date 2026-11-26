mod sync;
mod tts;

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::ipc::Response;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Resolves a library-relative path inside the app data directory.
fn resolve_library_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
  if relative
    .split(['/', '\\'])
    .any(|segment| segment == ".." || segment.is_empty())
  {
    return Err("invalid library path".into());
  }
  let base = app.path().app_data_dir().map_err(|err| err.to_string())?;
  let candidate = base.join(relative);
  if !candidate.starts_with(&base) {
    return Err("path outside the library directory".into());
  }
  Ok(candidate)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
  if !src.exists() {
    return Ok(());
  }
  fs::create_dir_all(dst).map_err(|err| err.to_string())?;
  for entry in fs::read_dir(src).map_err(|err| err.to_string())? {
    let entry = entry.map_err(|err| err.to_string())?;
    let src_path = entry.path();
    let dst_path = dst.join(entry.file_name());
    if src_path.is_dir() {
      copy_dir_recursive(&src_path, &dst_path)?;
    } else if src_path.is_file() {
      fs::copy(&src_path, &dst_path).map_err(|err| err.to_string())?;
    }
  }
  Ok(())
}

/// Size of a book file, used by the range reader to seek the zip directory.
#[tauri::command]
fn book_file_size(app: AppHandle, path: String) -> Result<u64, String> {
  let file = resolve_library_path(&app, &path)?;
  fs::metadata(file)
    .map(|meta| meta.len())
    .map_err(|err| err.to_string())
}

/// Reads a byte range from a book file. Returning raw bytes keeps large EPUBs
/// out of the webview heap: zip.js only pulls the entries it needs.
#[tauri::command]
fn read_book_range(
  app: AppHandle,
  path: String,
  offset: u64,
  length: usize,
) -> Result<Response, String> {
  let path = resolve_library_path(&app, &path)?;
  let mut file = File::open(&path).map_err(|err| err.to_string())?;
  let total = file.metadata().map_err(|err| err.to_string())?.len();
  if offset >= total {
    return Ok(Response::new(Vec::new()));
  }
  let end = offset.saturating_add(length as u64).min(total);
  let mut buffer = vec![0u8; (end - offset) as usize];
  file
    .seek(SeekFrom::Start(offset))
    .map_err(|err| err.to_string())?;
  file
    .read_exact(&mut buffer)
    .map_err(|err| err.to_string())?;
  Ok(Response::new(buffer))
}

/// Exports a self-contained Markdown file together with an `assets/` folder
/// containing all referenced card images.
#[tauri::command]
fn export_markdown_bundle(
  app: AppHandle,
  target_dir: String,
  filename: String,
  markdown: String,
  image_rel_paths: Vec<String>,
) -> Result<u32, String> {
  let out_dir = PathBuf::from(&target_dir);
  fs::create_dir_all(&out_dir).map_err(|err| err.to_string())?;
  let md_path = out_dir.join(&filename);
  fs::write(&md_path, markdown.as_bytes()).map_err(|err| err.to_string())?;

  let mut copied: u32 = 0;
  if !image_rel_paths.is_empty() {
    let assets_dir = out_dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|err| err.to_string())?;
    for rel in image_rel_paths {
      if let Ok(src) = resolve_library_path(&app, &rel) {
        if src.is_file() {
          if let Some(name) = src.file_name() {
            fs::copy(&src, assets_dir.join(name)).map_err(|err| err.to_string())?;
            copied += 1;
          }
        }
      }
    }
  }
  Ok(copied)
}

/// Backs up the entire ReadingBook library (SQLite DB, books, covers, images, cache)
/// into a user-selected directory.
#[tauri::command]
fn export_library_backup(app: AppHandle, target_dir: String) -> Result<String, String> {
  let base = app.path().app_data_dir().map_err(|err| err.to_string())?;
  let dst = PathBuf::from(&target_dir);
  fs::create_dir_all(&dst).map_err(|err| err.to_string())?;

  for db_file in ["readingbook.db", "readingbook.db-wal", "readingbook.db-shm"] {
    let src = base.join(db_file);
    if src.is_file() {
      fs::copy(&src, dst.join(db_file)).map_err(|err| err.to_string())?;
    }
  }

  for folder in ["books", "covers", "images", "cache"] {
    copy_dir_recursive(&base.join(folder), &dst.join(folder))?;
  }

  Ok(dst.to_string_lossy().to_string())
}

/// Restores a previously backed-up ReadingBook library directory into app data.
#[tauri::command]
fn restore_library_backup(app: AppHandle, source_dir: String) -> Result<(), String> {
  let src = PathBuf::from(&source_dir);
  if !src.join("readingbook.db").is_file() {
    return Err("所选目录中未找到 readingbook.db 备份文件".into());
  }

  let base = app.path().app_data_dir().map_err(|err| err.to_string())?;
  fs::create_dir_all(&base).map_err(|err| err.to_string())?;

  // Remove stale WAL/SHM files before restoring so SQLite opens the restored DB cleanly.
  for stale in ["readingbook.db-wal", "readingbook.db-shm"] {
    let p = base.join(stale);
    if p.exists() {
      let _ = fs::remove_file(&p);
    }
  }

  for db_file in ["readingbook.db", "readingbook.db-wal", "readingbook.db-shm"] {
    let s = src.join(db_file);
    if s.is_file() {
      fs::copy(&s, base.join(db_file)).map_err(|err| err.to_string())?;
    }
  }

  for folder in ["books", "covers", "images", "cache"] {
    copy_dir_recursive(&src.join(folder), &base.join(folder))?;
  }

  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let migrations = vec![Migration {
    version: 1,
    description: "create books, annotations and settings tables",
    sql: include_str!("../migrations/0001_init.sql"),
    kind: MigrationKind::Up,
  }];

  tauri::Builder::default()
    .manage(sync::SyncState::default())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:readingbook.db", migrations)
        .build(),
    )
    .invoke_handler(tauri::generate_handler![
      book_file_size,
      read_book_range,
      export_markdown_bundle,
      export_library_backup,
      restore_library_backup,
      tts::tts_synthesize,
      sync::sync_start,
      sync::sync_get_status,
      sync::sync_set_data_rev,
      sync::sync_announce_now,
      sync::sync_register_peer_secret,
      sync::sync_unregister_peer_secret,
      sync::sync_generate_pairing_code,
      sync::sync_pair_with_peer,
      sync::sync_ping_peer,
      sync::sync_exchange_with_peer,
      sync::sync_reply_exchange,
      sync::sync_pull_file,
      sync::sync_push_file
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
