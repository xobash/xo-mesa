// Read one bounded slice of a vault file, so viewers can page through
// multi-GB files without loading them whole. Read-only.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Largest slice one call returns. The hex view asks for one window per
/// scroll settle; WebView2 charges every IPC response to the UI thread.
pub(crate) const MAX_RANGE_BYTES: u64 = 1024 * 1024;
/// `u64` size + `u64` modification time in nanoseconds, little-endian.
const HEADER_BYTES: usize = 16;

/// Size and modification time of one open handle. Two reads with equal
/// stamps saw the same file version, within mtime resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    size: u64,
    mtime_ns: u64,
}

fn stamp_of(file: &std::fs::File) -> Result<Stamp, String> {
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("path is not a regular file".into());
    }
    // A time before 1970 or unavailable reads as 0; the size still changes.
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));
    Ok(Stamp {
        size: meta.len(),
        mtime_ns,
    })
}

/// Response body: header (size, mtime) then at most `len` bytes from
/// `offset`. `src/lib/vaultByteRead.ts` `decodeRangeResponse` is the other half.
pub(crate) fn read_range(root: &Path, rel: &str, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    if len > MAX_RANGE_BYTES {
        return Err("range read exceeds 1 MiB".into());
    }
    crate::vaultread::with_visible_file(root, rel, |mut file| {
        let before = stamp_of(&file)?;
        if offset > before.size {
            return Err("offset is past the end of the file".into());
        }
        let take = len.min(before.size - offset);
        let mut out = Vec::with_capacity(HEADER_BYTES + take as usize);
        out.extend_from_slice(&before.size.to_le_bytes());
        out.extend_from_slice(&before.mtime_ns.to_le_bytes());
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        (&mut file)
            .take(take)
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
        // A writer between the two stats would mix versions in one slice.
        if stamp_of(&file)? != before || out.len() != HEADER_BYTES + take as usize {
            return Err("file changed while reading".into());
        }
        Ok(out)
    })
}

/// Bounded slice of a visible vault file plus its size and mtime, so the
/// renderer can tell when the file changed between two reads.
#[tauri::command]
pub async fn vault_read_range(
    app: tauri::AppHandle,
    path: String,
    offset: u64,
    len: u64,
) -> Result<tauri::ipc::Response, String> {
    if len > MAX_RANGE_BYTES {
        return Err("range read exceeds 1 MiB".into());
    }
    let (root, rel) = crate::vaultscope::approved_path(&app, &path)?;
    let access = crate::vaulttransaction::access(&root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        read_range(&root, &rel, offset, len).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "vaultrange_tests.rs"]
mod tests;
