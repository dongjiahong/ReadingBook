use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

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

/// Size of a book file, used by the range reader to seek the zip directory.
#[tauri::command]
fn book_file_size(app: AppHandle, path: String) -> Result<u64, String> {
  let file = resolve_library_path(&app, &path)?;
  std::fs::metadata(file)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let migrations = vec![Migration {
    version: 1,
    description: "create books, annotations and settings tables",
    sql: include_str!("../migrations/0001_init.sql"),
    kind: MigrationKind::Up,
  }];

  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:readingbook.db", migrations)
        .build(),
    )
    .invoke_handler(tauri::generate_handler![book_file_size, read_book_range])
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
