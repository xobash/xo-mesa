use serde::Serialize;
use std::collections::{HashMap, HashSet};
#[cfg(not(target_os = "windows"))]
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTreeSample {
    pid: u32,
    sampled_at_ms: u64,
    process_count: usize,
    rss_bytes: u64,
    cpu_time_ms: Option<u64>,
    unsupported_reason: Option<String>,
    coverage: &'static str,
    process_ids: Vec<u32>,
}

#[derive(Debug, Clone)]
struct ProcessRow {
    pid: u32,
    ppid: u32,
    rss_bytes: u64,
    cpu_time_ms: Option<u64>,
}

#[tauri::command]
pub async fn diagnostics_process_tree() -> Result<ProcessTreeSample, String> {
    tauri::async_runtime::spawn_blocking(sample_process_tree)
        .await
        .map_err(|e| e.to_string())
}

fn sample_process_tree() -> ProcessTreeSample {
    let pid = std::process::id();
    let sampled_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0);
    match process_rows() {
        Ok(rows) => summarize_tree(pid, sampled_at_ms, &rows),
        Err(err) => ProcessTreeSample {
            pid,
            sampled_at_ms,
            process_count: 0,
            rss_bytes: 0,
            cpu_time_ms: None,
            unsupported_reason: Some(err),
            coverage: "descendants-only",
            process_ids: Vec::new(),
        },
    }
}

fn summarize_tree(pid: u32, sampled_at_ms: u64, rows: &[ProcessRow]) -> ProcessTreeSample {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut by_pid: HashMap<u32, &ProcessRow> = HashMap::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row.pid);
        by_pid.insert(row.pid, row);
    }

    let mut stack = vec![pid];
    let mut seen = HashSet::new();
    let mut process_count = 0;
    let mut rss_bytes = 0u64;
    let mut cpu_time_ms = Some(0u64);

    while let Some(next) = stack.pop() {
        if !seen.insert(next) {
            continue;
        }
        if let Some(row) = by_pid.get(&next) {
            process_count += 1;
            rss_bytes = rss_bytes.saturating_add(row.rss_bytes);
            match (cpu_time_ms, row.cpu_time_ms) {
                (Some(total), Some(value)) => cpu_time_ms = Some(total.saturating_add(value)),
                _ => cpu_time_ms = None,
            }
        }
        if let Some(child_pids) = children.get(&next) {
            stack.extend(child_pids.iter().copied());
        }
    }

    let unsupported_reason = if process_count == 0 {
        Some("Current process was not present in the OS process listing".to_string())
    } else {
        None
    };

    let mut process_ids: Vec<u32> = seen
        .into_iter()
        .filter(|pid| by_pid.contains_key(pid))
        .collect();
    process_ids.sort_unstable();
    ProcessTreeSample {
        coverage: "descendants-only",
        process_ids,
        pid,
        sampled_at_ms,
        process_count,
        rss_bytes,
        cpu_time_ms,
        unsupported_reason,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_rows() -> Result<Vec<ProcessRow>, String> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,time="])
        .output()
        .map_err(|err| format!("Could not run ps: {err}"))?;
    if !output.status.success() {
        return Err(format!("ps exited with status {}", output.status));
    }
    let text = String::from_utf8(output.stdout)
        .map_err(|err| format!("ps output was not UTF-8: {err}"))?;
    Ok(parse_unix_ps(&text))
}

#[cfg(windows)]
fn process_rows() -> Result<Vec<ProcessRow>, String> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_VM_READ,
    };

    // Toolhelp takes one kernel snapshot and does not start PowerShell or WMI.
    // A process can exit between the snapshot and its metric query; retain that
    // row with unknown CPU rather than making diagnostics unavailable.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Could not create the Windows process snapshot".to_string());
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut rows = Vec::new();
        let mut has_entry = Process32FirstW(snapshot, &mut entry) != 0;
        while has_entry {
            let pid = entry.th32ProcessID;
            let ppid = entry.th32ParentProcessID;
            let mut process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if process.is_null() {
                // Protected helpers may deny memory inspection. We can still
                // report their place in the tree and, when permitted, CPU time.
                process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            }
            let (rss_bytes, cpu_time_ms) = if process.is_null() {
                (0, None)
            } else {
                let mut memory = PROCESS_MEMORY_COUNTERS {
                    cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                    ..Default::default()
                };
                let memory_ok = GetProcessMemoryInfo(
                    process,
                    &mut memory,
                    size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                ) != 0;
                let mut creation = FILETIME::default();
                let mut exit = FILETIME::default();
                let mut kernel = FILETIME::default();
                let mut user = FILETIME::default();
                let cpu_ok =
                    GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
                let _ = CloseHandle(process);
                let cpu_time_ms = cpu_ok
                    .then(|| filetime_100ns(kernel).saturating_add(filetime_100ns(user)) / 10_000);
                (
                    if memory_ok {
                        memory.WorkingSetSize as u64
                    } else {
                        0
                    },
                    cpu_time_ms,
                )
            };
            rows.push(ProcessRow {
                pid,
                ppid,
                rss_bytes,
                cpu_time_ms,
            });
            entry = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            has_entry = Process32NextW(snapshot, &mut entry) != 0;
        }
        let _ = CloseHandle(snapshot);
        Ok(rows)
    }
}

#[cfg(windows)]
fn filetime_100ns(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn process_rows() -> Result<Vec<ProcessRow>, String> {
    Err("Process-tree diagnostics are not supported on this platform".to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn parse_unix_ps(text: &str) -> Vec<ProcessRow> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            let rss_kib: u64 = parts.next()?.parse().ok()?;
            let cpu_time_ms = parse_unix_cpu_time(parts.next()?)?;
            Some(ProcessRow {
                pid,
                ppid,
                rss_bytes: rss_kib.saturating_mul(1024),
                cpu_time_ms: Some(cpu_time_ms),
            })
        })
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn parse_unix_cpu_time(value: &str) -> Option<u64> {
    let (days, rest) = match value.split_once('-') {
        Some((days, rest)) => (days.parse::<u64>().ok()?, rest),
        None => (0, value),
    };
    let fields: Vec<&str> = rest.split(':').collect();
    let seconds = match fields.as_slice() {
        [minutes, seconds] => minutes
            .parse::<u64>()
            .ok()?
            .saturating_mul(60)
            .saturating_add(parse_seconds(seconds)?),
        [hours, minutes, seconds] => hours
            .parse::<u64>()
            .ok()?
            .saturating_mul(3600)
            .saturating_add(minutes.parse::<u64>().ok()?.saturating_mul(60))
            .saturating_add(parse_seconds(seconds)?),
        _ => return None,
    };
    let fractional_ms = fields
        .last()
        .and_then(|value| value.split_once('.').map(|(_, fraction)| fraction))
        .and_then(|fraction| {
            let digits: String = fraction.chars().take(3).collect();
            let value = digits.parse::<u64>().ok()?;
            Some(
                value
                    .saturating_mul(10u64.saturating_pow(3u32.saturating_sub(digits.len() as u32))),
            )
        })
        .unwrap_or(0);
    Some(
        days.saturating_mul(86_400_000)
            .saturating_add(seconds.saturating_mul(1000))
            .saturating_add(fractional_ms),
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn parse_seconds(value: &str) -> Option<u64> {
    value
        .split_once('.')
        .map_or_else(|| value.parse().ok(), |(whole, _)| whole.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_current_process_and_descendants_only() {
        let rows = vec![
            ProcessRow {
                pid: 1,
                ppid: 0,
                rss_bytes: 100,
                cpu_time_ms: Some(10),
            },
            ProcessRow {
                pid: 2,
                ppid: 1,
                rss_bytes: 200,
                cpu_time_ms: Some(20),
            },
            ProcessRow {
                pid: 3,
                ppid: 2,
                rss_bytes: 300,
                cpu_time_ms: Some(30),
            },
            ProcessRow {
                pid: 4,
                ppid: 1,
                rss_bytes: 400,
                cpu_time_ms: Some(40),
            },
        ];

        let sample = summarize_tree(2, 123, &rows);

        assert_eq!(sample.pid, 2);
        assert_eq!(sample.sampled_at_ms, 123);
        assert_eq!(sample.process_count, 2);
        assert_eq!(sample.rss_bytes, 500);
        assert_eq!(sample.cpu_time_ms, Some(50));
        assert!(sample.unsupported_reason.is_none());
    }

    #[test]
    fn keeps_cpu_unknown_when_any_process_lacks_cpu_time() {
        let rows = vec![
            ProcessRow {
                pid: 10,
                ppid: 0,
                rss_bytes: 100,
                cpu_time_ms: Some(10),
            },
            ProcessRow {
                pid: 11,
                ppid: 10,
                rss_bytes: 200,
                cpu_time_ms: None,
            },
        ];

        let sample = summarize_tree(10, 0, &rows);

        assert_eq!(sample.rss_bytes, 300);
        assert_eq!(sample.cpu_time_ms, None);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn parses_unix_ps_rows_and_elapsed_cpu_time() {
        let rows = parse_unix_ps(" 42  1  512 01:02:03\n 43 42 1024 2-03:04:05\n");

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pid, 42);
        assert_eq!(rows[0].rss_bytes, 512 * 1024);
        assert_eq!(rows[0].cpu_time_ms, Some(3_723_000));
        assert_eq!(rows[1].cpu_time_ms, Some(183_845_000));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn preserves_fractional_ps_cpu_seconds() {
        // macOS `ps time` commonly reports values such as `0:33.40`.  Losing
        // the whole row makes a valid process tree look unsupported.
        assert_eq!(parse_unix_cpu_time("0:33.40"), Some(33_400));
        assert_eq!(parse_unix_cpu_time("1-02:03:04.005"), Some(93_784_005));
    }
}
