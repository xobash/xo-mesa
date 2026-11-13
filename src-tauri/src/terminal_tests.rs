use super::*;

#[test]
fn cmd_shim_fallback_keeps_quoted_paths_and_skips_the_vault_folder() {
    let shim = Path::new(r"C:\Program Files\nodejs\pi.cmd");
    let cmd = cmd_shim_command(r"C:\Windows\System32\cmd.exe", shim);
    let argv: Vec<_> = cmd
        .get_argv()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        argv,
        [
            r"C:\Windows\System32\cmd.exe",
            "/d",
            "/c",
            "call",
            r"C:\Program Files\nodejs\pi.cmd"
        ]
    );
    assert_eq!(
        cmd.get_env("NoDefaultCurrentDirectoryInExePath"),
        Some(std::ffi::OsStr::new("1"))
    );
}

#[test]
fn deleted_cached_pi_is_resolved_again_and_failed_lookup_clears_cache() {
    let dir = std::env::temp_dir().join(format!("mesa-pi-cache-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let binary = dir.join("pi.exe");
    std::fs::write(&binary, b"fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let cache = Mutex::new(Some(binary.clone()));
    assert_eq!(
        resolve_cached_pi_binary(&cache, || panic!("valid cache searched")),
        Ok(binary.clone())
    );
    std::fs::remove_file(&binary).unwrap();
    let replacement = dir.join("replacement.exe");
    std::fs::write(&replacement, b"replacement").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert_eq!(
        resolve_cached_pi_binary(&cache, || Ok(replacement.clone())),
        Ok(replacement.clone())
    );
    assert_eq!(*cache.lock().unwrap(), Some(replacement.clone()));
    assert_eq!(
        resolve_cached_pi_binary(&cache, || panic!("replacement cache searched")),
        Ok(replacement.clone())
    );
    std::fs::remove_file(&replacement).unwrap();
    assert!(resolve_cached_pi_binary(&cache, || Err("not found".into())).is_err());
    assert!(cache.lock().unwrap().is_none());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn frontend_environment_cannot_supply_args_or_native_overrides() {
    let mut cmd = CommandBuilder::new("pi");
    let before = cmd.get_argv().to_vec();
    let envs = HashMap::from([
        ("MESA_CONTEXT".into(), "--extension malicious.js".into()),
        ("MESA_DEEP_RESEARCH_RUN_ID".into(), "run-1".into()),
        ("MESA_UNLISTED".into(), "injected".into()),
        ("MESA_ACTIVITY_TOKEN".into(), "injected".into()),
        ("PATH".into(), "injected".into()),
    ]);
    apply_frontend_env(&mut cmd, &envs);
    assert_eq!(cmd.get_argv(), &before);
    assert_eq!(
        cmd.get_env("MESA_CONTEXT"),
        Some(std::ffi::OsStr::new("--extension malicious.js"))
    );
    assert_eq!(
        cmd.get_env("MESA_DEEP_RESEARCH_RUN_ID"),
        Some(std::ffi::OsStr::new("run-1"))
    );
    for key in ["MESA_UNLISTED", "MESA_ACTIVITY_TOKEN", "PATH"] {
        assert_ne!(cmd.get_env(key), Some(std::ffi::OsStr::new("injected")));
    }
}

#[test]
fn terminal_ids_are_random_128_bit_identifiers() {
    let ids: HashSet<_> = (0..1024).map(|_| session_id().unwrap()).collect();
    assert_eq!(ids.len(), 1024);
    assert!(ids
        .iter()
        .all(|id| id.len() == 37 && id[5..].bytes().all(|b| b.is_ascii_hexdigit())));
}

#[test]
fn external_process_consent_prompts_only_without_a_saved_decision() {
    let gate = Mutex::new(());
    let saved = std::cell::Cell::new(false);
    let ask = |answer: bool| {
        approve_external_process(
            &gate,
            || saved.get(),
            || answer,
            || {
                saved.set(true);
                Ok(())
            },
        )
    };
    assert!(ask(false).is_err());
    assert!(!saved.get(), "denial is not saved");
    assert!(ask(true).is_ok());
    assert!(saved.get());
    assert!(approve_external_process(
        &gate,
        || true,
        || panic!("saved decision prompted again"),
        || panic!("saved decision written again"),
    )
    .is_ok());
    assert!(
        approve_external_process(&gate, || false, || true, || Err("disk full".into())).is_ok(),
        "a failed save still allows this launch"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_pi_launch_accepts_node_script_and_cmd_shim() {
    let dir = std::env::temp_dir().join(format!("mesa-pi-test-{}-script", std::process::id()));
    fs::create_dir_all(&dir).expect("temp dir");
    let script = dir.join("pi");
    let shim = dir.join("pi.cmd");
    let node = dir.join("node.exe");
    fs::write(&script, b"#!/usr/bin/env node\n").expect("script");
    fs::write(&shim, b"@echo off\r\n").expect("shim");
    fs::write(&node, b"MZ").expect("node stub");

    assert!(script_uses_node(&script));
    assert_eq!(
        sibling_script_path(&shim).as_deref(),
        Some(script.as_path())
    );
    assert_eq!(resolve_node_binary_for_script(&script).unwrap(), node);
    assert!(pi_command(&script).is_ok());
    assert!(pi_command(&shim).is_ok());
    assert!(!windows_launches_directly(&script));
    assert!(windows_launches_directly(&node));
    fs::remove_dir_all(dir).expect("cleanup");
}

#[cfg(target_os = "windows")]
#[test]
fn windows_node_lookup_requires_an_existing_sibling_and_reads_only_a_prefix() {
    let dir = std::env::temp_dir().join(format!("mesa-pi-test-{}-nonode", std::process::id()));
    fs::create_dir_all(&dir).expect("temp dir");
    let script = dir.join("pi");
    let mut bytes = b"#!/usr/bin/env node\n".to_vec();
    bytes.extend_from_slice(&[0xff; 4096]);
    fs::write(&script, &bytes).expect("script");
    assert!(
        script_uses_node(&script),
        "a binary tail must not hide the shebang"
    );
    if let Ok(node) = resolve_node_binary_for_script(&script) {
        assert_ne!(
            node,
            dir.join("node.exe"),
            "missing sibling node.exe was returned"
        );
        assert!(node.is_file());
    }
    let short = dir.join("short");
    fs::write(&short, b"M").expect("short");
    assert!(!file_starts_with_mz(&short));
    let image = dir.join("image");
    fs::write(&image, b"MZ\x90\x00").expect("image");
    assert!(file_starts_with_mz(&image));
    fs::remove_dir_all(dir).expect("cleanup");
}

/// The template npm's cmd-shim writes for a Node package binary.
const NPM_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@scope\\pi-agent\\dist\\cli.js\" %*\r\n";

#[test]
fn npm_cmd_shims_resolve_to_their_node_entry() {
    assert_eq!(
        npm_shim_node_entry(NPM_SHIM).as_deref(),
        Some(r"node_modules\@scope\pi-agent\dist\cli.js")
    );
    for rejected in [
        // Escapes the shim folder.
        NPM_SHIM.replace(r"node_modules\@scope", r"..\elsewhere"),
        // Not a Node program.
        NPM_SHIM.replace("SET \"_prog=node\"", "SET \"_prog=sh\""),
        // Not a script entry.
        NPM_SHIM.replace("cli.js", "cli.ps1"),
        // An expansion Mesa cannot reproduce.
        NPM_SHIM.replace(r"\dist\", r"\%PI_DIST%\"),
        "@echo off\r\n".to_string(),
    ] {
        assert_eq!(npm_shim_node_entry(&rejected), None, "{rejected}");
    }
}

#[test]
fn cmd_route_is_detected_and_refuses_network_working_folders() {
    let shim = cmd_shim_command(r"C:\Windows\System32\cmd.exe", Path::new(r"C:\npm\pi.cmd"));
    assert!(launches_through_cmd(&shim));
    assert!(!launches_through_cmd(&CommandBuilder::new(
        r"C:\nodejs\node.exe"
    )));
    for cwd in [r"C:\Data\Me\Vault", "D:/Vault", "/Data/me/Vault"] {
        assert!(cmd_accepts_cwd(Path::new(cwd)), "{cwd}");
    }
    for cwd in [
        r"\\server.example\share\Vault",
        "//server.example/share/Vault",
        r"\\?\C:\Vault",
    ] {
        assert!(!cmd_accepts_cwd(Path::new(cwd)), "{cwd}");
    }
}

#[test]
fn pi_keeps_the_opened_spelling_only_when_it_resolves_to_the_approved_root() {
    let base = std::env::temp_dir().join(format!("mesa-pi-cwd-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("vault")).unwrap();
    std::fs::create_dir_all(base.join("other")).unwrap();
    let canonical = std::fs::canonicalize(base.join("vault")).unwrap();
    #[cfg(unix)]
    {
        let alias = base.join("drive");
        std::os::unix::fs::symlink(base.join("vault"), &alias).unwrap();
        // A mapped-drive-like alias of the same folder keeps its spelling on Windows.
        let spelled = alias.to_str().unwrap();
        assert_eq!(launch_cwd(spelled, &canonical, true), alias);
        // Other platforms keep the canonical root, as before.
        assert_eq!(launch_cwd(spelled, &canonical, false), canonical);
    }
    // A spelling of another folder, a relative one or a traversal never wins.
    for spelled in [
        base.join("other").to_str().unwrap().to_string(),
        "vault".to_string(),
        format!("{}/other/../vault", base.display()),
    ] {
        assert_eq!(
            launch_cwd(&spelled, &canonical, true),
            crate::vaultscope::plain_path(&canonical),
            "{spelled}"
        );
    }
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn launch_extensions_prefer_native_images_and_cmd_shims() {
    assert_eq!(
        launch_extensions(Some(".PS1;.JS;.CMD;.EXE;.VBS")),
        [".EXE", ".COM", ".CMD", ".BAT", ".PS1", ".JS", ".VBS"]
    );
    assert_eq!(
        launch_extensions(Some(".com;.exe;.bat;.cmd;;  ;.js")),
        [".EXE", ".COM", ".CMD", ".BAT", ".js"]
    );
    assert_eq!(launch_extensions(None), [".EXE", ".COM", ".CMD", ".BAT"]);
}

#[cfg(target_os = "windows")]
#[test]
fn windows_npm_shim_starts_node_directly() {
    let dir = std::env::temp_dir().join(format!("mesa-pi-test-{}-npm", std::process::id()));
    let entry = dir.join(r"node_modules\@scope\pi-agent\dist");
    fs::create_dir_all(&entry).expect("temp dir");
    fs::write(entry.join("cli.js"), b"console.log(1)\n").expect("entry");
    fs::write(dir.join("node.exe"), b"MZ").expect("node stub");
    let shim = dir.join("pi.cmd");
    fs::write(&shim, NPM_SHIM).expect("shim");
    fs::write(dir.join("pi.ps1"), b"#!/usr/bin/env pwsh\n").expect("ps1");
    // PATHEXT supplies the extension's case (`pi.CMD`); NTFS names are
    // case-insensitive, so compare the found path that way.
    let found = executable_in_dir(&dir, "pi").expect("shim found");
    assert!(
        found
            .to_string_lossy()
            .eq_ignore_ascii_case(&shim.to_string_lossy()),
        "{found:?}"
    );
    let cmd = pi_command(&shim).expect("node command");
    assert!(!launches_through_cmd(&cmd));
    assert_eq!(
        cmd.get_argv(),
        &[
            dir.join("node.exe").into_os_string(),
            entry.join("cli.js").into_os_string()
        ]
    );
    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn merged_path_keeps_inherited_path_ahead_of_common_dirs() {
    let base = std::env::temp_dir().join(format!("mesa-path-order-{}", std::process::id()));
    let program = base.join("program");
    let user = base.join("user");
    let common = base.join("common");
    for dir in [&program, &user, &common] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let inherited = env::join_paths([user.clone(), common.clone()]).unwrap();
    let merged = merged_path(
        Some(&program),
        Some(inherited),
        std::slice::from_ref(&common),
    )
    .unwrap();
    assert_eq!(
        env::split_paths(&merged).collect::<Vec<_>>(),
        [program.clone(), user.clone(), common.clone()]
    );
    let merged = merged_path(
        Some(&program),
        Some(env::join_paths([user.clone()]).unwrap()),
        &[common.clone(), program.clone()],
    )
    .unwrap();
    assert_eq!(
        env::split_paths(&merged).collect::<Vec<_>>(),
        [program, user, common]
    );
    let _ = std::fs::remove_dir_all(base);
}

#[cfg(target_os = "windows")]
#[test]
fn windows_pi_launch_rejects_unrecognized_file() {
    let dir = std::env::temp_dir().join(format!("mesa-pi-test-{}-invalid", std::process::id()));
    fs::create_dir_all(&dir).expect("temp dir");
    let file = dir.join("pi.txt");
    fs::write(&file, b"plain text").expect("text");
    assert!(pi_command(&file).is_err());
    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn arbitrary_terminal_programs_are_rejected() {
    assert!(terminal_command(None).is_err());
    assert!(terminal_command(Some("sh")).is_err());
    assert!(terminal_command(Some(" pi ")).is_err());
}

#[test]
fn terminal_history_preserves_order_and_sequence() {
    let mut history = TerminalHistory::default();
    assert_eq!(history.push_resize(24, 80), 1);
    assert_eq!(history.push_output("one".into()), 2);
    assert_eq!(history.push_output(" two".into()), 3);
    assert_eq!(history.snapshot(), "one two");
    assert_eq!(history.seq, 3);
    let replay = history.replay();
    assert_eq!(replay.len(), 3);
    assert_eq!(replay[0].kind, "resize");
    assert_eq!(replay[0].rows, Some(24));
    assert_eq!(replay[1].kind, "output");
    assert_eq!(replay[1].data.as_deref(), Some("one"));
}

#[test]
fn terminal_history_is_bounded_without_dropping_the_latest_chunk() {
    let mut history = TerminalHistory::default();
    history.push_output("a".repeat(TERMINAL_HISTORY_MAX_BYTES));
    history.push_output("latest".into());
    assert_eq!(history.snapshot(), "latest");
}

/// Splitting a multi-byte character across PTY reads preserves its columns.
#[test]
fn split_multibyte_characters_survive_a_read_boundary() {
    // Box drawing, spinner, em dash, curly quotes — Pi's TUI vocabulary.
    let source = "─┤⋮├─ Mesa — “Local NSFW” ─┤⋮├─";
    let bytes = source.as_bytes();

    for split in 0..bytes.len() {
        let mut decoder = Utf8Stream::default();
        let mut decoded = decoder.push(&bytes[..split]);
        decoded.push_str(&decoder.push(&bytes[split..]));
        decoded.push_str(&decoder.flush());
        assert_eq!(decoded, source, "split at byte {split}");
    }
}

#[test]
fn every_read_boundary_of_a_stream_is_lossless() {
    let source = "⋮ Working…\r\n─────────\r\n17.8%/64k (auto)\r\n".repeat(4);
    let bytes = source.as_bytes();

    for chunk in 1..=bytes.len().min(24) {
        let mut decoder = Utf8Stream::default();
        let mut decoded = String::new();
        for window in bytes.chunks(chunk) {
            decoded.push_str(&decoder.push(window));
        }
        decoded.push_str(&decoder.flush());
        assert_eq!(decoded, source, "chunk size {chunk}");
    }
}

#[test]
fn invalid_bytes_still_become_replacement_characters() {
    let mut decoder = Utf8Stream::default();
    // 0xFF is never valid UTF-8 and is not a truncated prefix, so it must
    // be replaced immediately rather than held back forever.
    assert_eq!(decoder.push(b"a\xffb"), "a\u{fffd}b");
    assert!(decoder.carry.is_empty());
}

#[test]
fn a_truncated_tail_is_held_back_not_mangled() {
    let mut decoder = Utf8Stream::default();
    // First two bytes of "─" (E2 94 80).
    assert_eq!(decoder.push(b"ok\xe2\x94"), "ok");
    assert_eq!(decoder.carry, vec![0xe2, 0x94]);
    assert_eq!(decoder.push(b"\x80!"), "─!");
    assert!(decoder.carry.is_empty());
}

#[test]
fn eof_flushes_a_truncated_tail_once() {
    let mut decoder = Utf8Stream::default();
    assert_eq!(decoder.push(b"\xe2\x94"), "");
    assert_eq!(decoder.flush(), "\u{fffd}");
    assert_eq!(decoder.flush(), "");
}

#[test]
fn resize_markers_do_not_consume_output_history_budget() {
    let mut history = TerminalHistory::default();
    history.push_resize(24, 80);
    history.push_resize(30, 100);
    history.push_output("visible".into());
    assert_eq!(history.snapshot(), "visible");
    assert_eq!(history.replay().len(), 3);
}

/// The leading edge of a burst must not pay the coalescing delay: a single
/// keystroke's echo after a quiet stream is the latency users feel.
#[test]
fn the_first_chunk_after_a_quiet_stream_flushes_immediately() {
    let mut history = TerminalHistory::default();
    let start = Instant::now();
    assert_eq!(history.flush_delay(start), OUTPUT_FLUSH_INTERVAL); // nothing staged
    history.stage_output("x");
    assert_eq!(history.flush_delay(start), Duration::ZERO);
    assert!(history.commit_pending(start));
    assert_eq!(history.outbox.pop_front(), Some(("x".to_string(), 1)));

    // Inside the window a second chunk waits out the remainder…
    history.stage_output("y");
    let inside = start + Duration::from_millis(3);
    assert_eq!(
        history.flush_delay(inside),
        OUTPUT_FLUSH_INTERVAL - Duration::from_millis(3)
    );
    // …and once the stream has been quiet for a full interval it is a
    // leading edge again.
    assert_eq!(
        history.flush_delay(start + OUTPUT_FLUSH_INTERVAL),
        Duration::ZERO
    );
}

/// A batch may not grow into one enormous JS source string, however busy
/// the window is.
#[test]
fn an_oversized_batch_flushes_before_the_window_closes() {
    let mut history = TerminalHistory::default();
    let start = Instant::now();
    history.commit_pending(start); // no-op: nothing staged
    history.stage_output("seed");
    history.commit_pending(start);
    history.outbox.clear();

    history.stage_output(&"a".repeat(OUTPUT_FLUSH_MAX_BYTES - 1));
    assert!(history.flush_delay(start) > Duration::ZERO);
    history.stage_output("a");
    assert_eq!(history.flush_delay(start), Duration::ZERO);
}

/// A flusher that only gets scheduled once the reader is far ahead must
/// still emit capped events, and must not split a multi-byte character
/// across two of them.
#[test]
fn an_overrun_buffer_is_committed_in_capped_char_safe_slices() {
    let mut history = TerminalHistory::default();
    // "─" is 3 bytes, so the cap lands mid-character on most slices.
    let chunk = "─".repeat(OUTPUT_FLUSH_MAX_BYTES);
    history.stage_output(&chunk);

    let now = Instant::now();
    while history.commit_pending(now) {}
    assert!(history.pending.is_empty());

    let mut rejoined = String::new();
    for (data, _) in &history.outbox {
        assert!(data.len() <= OUTPUT_FLUSH_MAX_BYTES);
        rejoined.push_str(data);
    }
    assert_eq!(rejoined, chunk);
    // Backing up to a char boundary costs at most 3 bytes per slice, so the
    // count is the ideal split or a hair above it — never one giant event.
    let ideal = chunk.len().div_ceil(OUTPUT_FLUSH_MAX_BYTES);
    assert!((ideal..=ideal + 1).contains(&history.outbox.len()));
}

#[test]
fn staging_applies_lossless_backpressure_to_a_slow_consumer() {
    let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
    let (filled_tx, filled_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let producer_stream = Arc::clone(&stream);
    let producer = thread::spawn(move || {
        producer_stream.stage(&"x".repeat(OUTPUT_PENDING_MAX_BYTES));
        filled_tx.send(()).unwrap();
        producer_stream.stage("y");
        done_tx.send(()).unwrap();
    });

    filled_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("producer should fill the pending ceiling");
    assert!(
        done_rx.recv_timeout(Duration::from_millis(20)).is_err(),
        "producer must wait for the slow consumer instead of growing pending"
    );

    let batch = next_output_batch(&stream);
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].0.len(), OUTPUT_FLUSH_MAX_BYTES);
    done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("draining one event should release the producer");
    producer.join().unwrap();
}

#[test]
fn committing_nothing_neither_advances_seq_nor_queues_an_event() {
    let mut history = TerminalHistory::default();
    assert!(!history.commit_pending(Instant::now()));
    assert_eq!(history.seq, 0);
    assert!(history.outbox.is_empty());
    assert!(history.replay().is_empty());
}

/// Staged bytes are produced before a resize, so they must be committed
/// ahead of the marker. Replaying them at the post-resize width re-wraps
/// the lines Pi's cursor-up rewrites depend on.
#[test]
fn a_resize_commits_staged_bytes_ahead_of_its_own_marker() {
    let mut history = TerminalHistory::default();
    history.stage_output("before");
    assert_eq!(history.push_resize(30, 100), 2);
    history.stage_output("after");
    history.commit_pending(Instant::now());

    let replay = history.replay();
    assert_eq!(replay.len(), 3);
    assert_eq!(replay[0].kind, "output");
    assert_eq!(replay[0].data.as_deref(), Some("before"));
    assert_eq!(replay[1].kind, "resize");
    assert_eq!(replay[2].data.as_deref(), Some("after"));
    assert_eq!(
        history
            .outbox
            .iter()
            .map(|(_, seq)| *seq)
            .collect::<Vec<_>>(),
        vec![1, 3]
    );
}

/// Staged bytes must stay out of `snapshot`/`replay` until they are
/// committed, otherwise a detached window would receive them twice: once in
/// the snapshot and again as a live event whose `seq` exceeds
/// `snapshot.seq`.
#[test]
fn staged_bytes_are_invisible_until_committed() {
    let mut history = TerminalHistory::default();
    history.stage_output("in flight");
    assert_eq!(history.snapshot(), "");
    assert_eq!(history.seq, 0);
    history.commit_pending(Instant::now());
    assert_eq!(history.snapshot(), "in flight");
    assert_eq!(history.seq, 1);
}

/// A `Read` that hands back the measured real-PTY shape: 1,303 chunks
/// averaging 1,023 B, i.e. 1.3 MB of bulk Pi output.
struct BurstReader {
    remaining: usize,
}

impl Read for BurstReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let n = self.remaining.min(1023).min(buf.len());
        buf[..n].fill(b'x');
        self.remaining -= n;
        Ok(n)
    }
}

/// Every `terminal://output`
/// event costs a UI-thread script eval plus a forced repaint on Windows, so
/// the event COUNT — not the byte count — is what freezes the window.
#[test]
fn a_bulk_burst_is_coalesced_without_losing_or_reordering_bytes() {
    const TOTAL: usize = 1_303 * 1_023;
    let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
    spawn_reader(BurstReader { remaining: TOTAL }, Arc::clone(&stream));

    let mut events = 0usize;
    let mut bytes = 0usize;
    let mut last_seq = 0u64;
    loop {
        let batch = next_output_batch(&stream);
        if batch.is_empty() {
            break;
        }
        for (data, seq) in batch {
            assert!(seq > last_seq, "seq must be strictly increasing");
            last_seq = seq;
            assert!(data.bytes().all(|b| b == b'x'));
            assert!(
                data.len() <= OUTPUT_FLUSH_MAX_BYTES,
                "event exceeded the cap"
            );
            bytes += data.len();
            events += 1;
        }
    }

    assert_eq!(bytes, TOTAL, "coalescing must be byte-lossless");
    // One event per read would be 1,303. `OUTPUT_FLUSH_MAX_BYTES` is the
    // floor on the count (21 here) and the leading-edge rule adds a handful
    // of small events at the head of the burst, whose exact number depends
    // on when the scheduler first runs the flusher.
    let capped = TOTAL.div_ceil(OUTPUT_FLUSH_MAX_BYTES);
    assert!(
        (capped..capped + 8).contains(&events),
        "expected ~{capped} coalesced events, got {events}"
    );
    assert_eq!(
        stream.lock().snapshot().len(),
        TOTAL.min(TERMINAL_HISTORY_MAX_BYTES),
        "history must hold the same bytes it emitted, bounded by its budget"
    );
}

/// The same burst through a real PTY master rather than a synthetic
/// `Read`, so the read sizes, EOF, and blocking behaviour are the
/// platform's own. What matters is that the pump is byte-lossless and
/// order-preserving end to end: xterm's parser concatenates consecutive
/// `write()` calls, so identical bytes in identical order render
/// identically no matter how they were chunked.
#[cfg(unix)]
#[test]
fn a_real_pty_burst_survives_the_pump_byte_for_byte() {
    const LINES: usize = 20_000;
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("sh");
    cmd.arg("-c");
    // No newlines: a PTY in canonical mode rewrites "\n" as "\r\n", which
    // would make a byte-for-byte comparison test the tty discipline
    // instead of the pump.
    cmd.arg(format!(
        "for i in $(seq {LINES}); do printf 'mesa-terminal-'; done"
    ));
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    let reader = pair.master.try_clone_reader().expect("reader");
    drop(pair.slave);

    let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
    spawn_reader(reader, Arc::clone(&stream));

    let mut received = String::new();
    let mut last_seq = 0u64;
    loop {
        let batch = next_output_batch(&stream);
        if batch.is_empty() {
            break;
        }
        for (data, seq) in batch {
            assert!(seq > last_seq, "seq must be strictly increasing");
            last_seq = seq;
            assert!(data.len() <= OUTPUT_FLUSH_MAX_BYTES);
            received.push_str(&data);
        }
    }
    let _ = child.wait();

    assert_eq!(received, "mesa-terminal-".repeat(LINES));
    // The real PTY's read boundaries and scheduler timing vary by host.
    // The deterministic BurstReader test above owns the coalescing-count
    // contract; this integration test must stay focused on the native
    // PTY's byte-lossless/order-preserving behavior and the per-event cap.
    let minimum_events = received.len().div_ceil(OUTPUT_FLUSH_MAX_BYTES) as u64;
    assert!(last_seq >= minimum_events);
    assert!(last_seq <= received.len() as u64);
}

/// Quiet-then-single-chunk must not be delayed, and the flusher must exit
/// on EOF instead of leaking a thread per session.
#[test]
fn an_interactive_echo_is_emitted_immediately_and_eof_ends_the_pump() {
    let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
    stream.stage("a");
    let started = Instant::now();
    let batch = next_output_batch(&stream);
    assert_eq!(batch, vec![("a".to_string(), 1)]);
    assert!(started.elapsed() < OUTPUT_FLUSH_INTERVAL);

    stream.close("");
    assert!(next_output_batch(&stream).is_empty());
}

/// EOF with a truncated multi-byte tail still delivers the replacement
/// character rather than dropping it inside the pump.
#[test]
fn a_tail_staged_at_eof_is_still_emitted() {
    let stream = Arc::new(TerminalStream::new(TerminalHistory::default()));
    stream.close("\u{fffd}");
    assert_eq!(
        next_output_batch(&stream),
        vec![("\u{fffd}".to_string(), 1)]
    );
    assert!(next_output_batch(&stream).is_empty());
}

/// A writer that never returns, standing in for a Pi that stopped reading stdin.
#[cfg(unix)]
struct StuckWriter(mpsc::Receiver<()>);
#[cfg(unix)]
impl Write for StuckWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = self.0.recv();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(unix)]
pub(super) fn spawn_test_session(script: &str) -> TerminalSession {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("sh");
    cmd.arg("-c");
    cmd.arg(script);
    let child = pair.slave.spawn_command(cmd).expect("spawn");
    let input = spawn_input_writer(pair.master.take_writer().expect("writer"));
    drop(pair.slave);
    TerminalSession {
        child,
        master: pair.master,
        input,
        stream: Arc::new(TerminalStream::new(TerminalHistory::default())),
        resize_owner: "main".to_string(),
        access: SessionAccess::new("main"),
        subscribers: HashMap::new(),
        rows: 24,
        cols: 80,
    }
}

#[cfg(unix)]
#[test]
fn a_stuck_writer_does_not_block_other_session_commands() {
    let (release, stuck) = mpsc::channel();
    let sender = spawn_input_writer(StuckWriter(stuck));
    let mut stuck_session = spawn_test_session("sleep 30");
    stuck_session.input = sender;
    let sessions = Mutex::new(HashMap::from([
        ("a".to_string(), stuck_session),
        ("b".to_string(), spawn_test_session("sleep 30")),
    ]));

    let started = Instant::now();
    queue_input(&sessions, "a", "first".into(), "main").unwrap();
    // The writer thread is now blocked inside write_all. Fill the queue
    // and prove overflow is an error instead of a blocked IPC thread.
    let mut overflowed = false;
    for _ in 0..INPUT_QUEUE_CHUNKS + 8 {
        overflowed |= queue_input(&sessions, "a", "x".into(), "main").is_err();
    }
    assert!(overflowed);
    // Other commands still take the sessions lock and finish at once.
    assert!(sessions.lock().unwrap().get("b").unwrap().stream.lock().seq == 0);
    queue_input(&sessions, "b", "echo\n".into(), "main").unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    // Closing a PTY master can itself block on some hosts; clean up apart
    // from the assertions above.
    let leftover: Vec<_> = sessions.lock().unwrap().drain().collect();
    thread::spawn(move || {
        for (_, mut session) in leftover {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    });
    drop(release);
}

#[cfg(unix)]
#[test]
fn an_exited_child_is_retired_exactly_once_with_its_code() {
    let sessions = Mutex::new(HashMap::from([(
        "s".to_string(),
        spawn_test_session("exit 3"),
    )]));
    assert_eq!(retire_exited_session(&sessions, "s"), Some(Some(3)));
    assert!(sessions.lock().unwrap().is_empty());
    assert_eq!(retire_exited_session(&sessions, "s"), None);
    assert_eq!(
        queue_input(&sessions, "s", "late".into(), "main").unwrap_err(),
        "Terminal session not found"
    );
}
