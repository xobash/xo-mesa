use super::*;
use base64::Engine;

/// The minisign README's example public key, wrapped the way
/// `tauri signer generate` writes its `.pub` file (base64 of both lines).
fn example_pubkey() -> String {
    base64::engine::general_purpose::STANDARD.encode(
        "untrusted comment: minisign public key 6F2DF63DF40B91DD\n\
         RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n",
    )
}

fn config() -> serde_json::Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses")
}

#[test]
fn a_check_runs_through_download_to_ready() {
    let mut machine = Machine::default();
    assert!(machine.begin_check());
    assert_eq!(machine.phase, Phase::Checking);
    assert!(machine.found("0.2.0".into(), true, 7));
    assert_eq!(machine.checked_at, Some(7));
    assert_eq!(machine.progress(25, Some(100)), Some(Some(25)));
    assert_eq!(machine.progress(75, Some(100)), Some(Some(100)));
    assert!(matches!(
        machine.phase,
        Phase::Downloading {
            downloaded: 100,
            total: Some(100),
            percent: Some(100),
            ..
        }
    ));
    assert!(machine.staged());
    assert_eq!(
        machine.phase,
        Phase::Ready {
            version: "0.2.0".into()
        }
    );
    assert!(machine.is_ready());
}

#[test]
fn checks_never_overlap_a_check_a_download_or_a_ready_update() {
    let mut machine = Machine::default();
    assert!(machine.begin_check());
    assert!(!machine.begin_check(), "second check while checking");
    machine.found("0.2.0".into(), true, 1);
    assert!(!machine.begin_check(), "check while downloading");
    machine.staged();
    assert!(!machine.begin_check(), "check while ready");
    assert!(machine.is_ready());
}

#[test]
fn up_to_date_available_and_error_allow_a_new_check() {
    let mut machine = Machine::default();
    machine.begin_check();
    assert!(machine.up_to_date(9));
    assert_eq!(
        (machine.phase.clone(), machine.checked_at),
        (Phase::UpToDate, Some(9))
    );
    assert!(machine.begin_check());
    // Notify-only installs never download.
    assert!(machine.found("0.3.0".into(), false, 10));
    assert_eq!(
        machine.phase,
        Phase::Available {
            version: "0.3.0".into()
        }
    );
    assert_eq!(machine.progress(10, Some(10)), None);
    assert!(machine.begin_check());
    assert!(machine.fail("offline".into()));
    assert!(machine.begin_check());
}

#[test]
fn transitions_out_of_order_are_ignored() {
    let mut machine = Machine::default();
    assert!(!machine.up_to_date(1));
    assert!(!machine.found("1.0.0".into(), true, 1));
    assert!(!machine.staged());
    assert!(!machine.fail("x".into()), "nothing to fail while idle");
    assert_eq!(machine.progress(1, None), None);
    assert_eq!(machine.phase, Phase::Idle);
    machine.begin_check();
    machine.found("1.0.0".into(), true, 1);
    machine.staged();
    // A late failure (e.g. a stray chunk callback) cannot undo a ready update.
    assert!(!machine.fail("late".into()));
    assert!(machine.is_ready());
}

#[test]
fn unknown_or_zero_length_downloads_report_bytes_without_percent() {
    let mut machine = Machine::default();
    machine.begin_check();
    machine.found("1.0.0".into(), true, 1);
    assert_eq!(machine.progress(10, None), Some(None));
    assert_eq!(machine.progress(10, Some(0)), Some(None));
    assert!(matches!(
        machine.phase,
        Phase::Downloading {
            downloaded: 20,
            total: None,
            ..
        }
    ));
}

#[test]
fn percent_is_whole_clamped_and_overflow_safe() {
    assert_eq!(percent_of(0, 0), 0);
    assert_eq!(percent_of(1, 3), 33);
    assert_eq!(percent_of(5, 3), 100);
    assert_eq!(percent_of(u64::MAX - 1, u64::MAX), 99);
    assert_eq!(percent_of(u64::MAX, u64::MAX), 100);
}

#[test]
fn progress_events_are_throttled_by_time_and_whole_percent() {
    let start = Instant::now();
    let mut throttle = ProgressThrottle::default();
    assert!(throttle.admit(start, Some(0)), "first event");
    assert!(
        !throttle.admit(start + Duration::from_millis(50), Some(5)),
        "too soon"
    );
    assert!(
        !throttle.admit(start + Duration::from_millis(150), Some(0)),
        "same percent"
    );
    assert!(throttle.admit(start + Duration::from_millis(150), Some(6)));
    assert!(
        throttle.admit(start + Duration::from_millis(151), Some(100)),
        "completion is never held back"
    );
    assert!(
        !throttle.admit(start + Duration::from_secs(5), Some(100)),
        "100% once"
    );
}

#[test]
fn unknown_totals_report_at_most_once_a_second() {
    let start = Instant::now();
    let mut throttle = ProgressThrottle::default();
    assert!(throttle.admit(start, None));
    assert!(!throttle.admit(start + Duration::from_millis(500), None));
    assert!(throttle.admit(start + UNKNOWN_TOTAL_INTERVAL, None));
}

/// A 100 MB download in 16 KiB chunks over ten seconds emits at most one
/// event per whole percent, instead of one per chunk (Windows IPC cost).
#[test]
fn a_whole_download_emits_a_bounded_number_of_events() {
    let start = Instant::now();
    let total: u64 = 100 * 1024 * 1024;
    let chunk: u64 = 16 * 1024;
    let chunks = total / chunk;
    let mut machine = Machine::default();
    machine.begin_check();
    machine.found("1.0.0".into(), true, 1);
    let mut throttle = ProgressThrottle::default();
    let mut emitted = 0;
    for index in 0..chunks {
        let percent = machine.progress(chunk, Some(total)).expect("downloading");
        let now = start + Duration::from_millis(index * 10_000 / chunks);
        if throttle.admit(now, percent) {
            emitted += 1;
        }
    }
    assert!(emitted <= 101, "{emitted} events for {chunks} chunks");
    assert!(emitted >= 50, "progress still moves visibly: {emitted}");
    assert_eq!(throttle.last.map(|(_, percent)| percent), Some(Some(100)));
}

#[test]
fn restart_needs_a_ready_update_and_no_running_pi() {
    assert_eq!(restart_admission(false, false), Err(NOT_READY.into()));
    assert_eq!(restart_admission(false, true), Err(NOT_READY.into()));
    assert_eq!(restart_admission(true, true), Err(PI_RUNNING.into()));
    assert_eq!(restart_admission(true, false), Ok(()));
}

#[test]
fn only_a_minisign_public_key_is_usable() {
    assert!(pubkey_usable(&example_pubkey()));
    assert!(!pubkey_usable(PLACEHOLDER_PUBKEY));
    assert!(!pubkey_usable(""));
    assert!(!pubkey_usable("not base64 !"));
    // Valid base64 that is not a key.
    assert!(!pubkey_usable(
        &base64::engine::general_purpose::STANDARD.encode("untrusted comment: x\nAAAA\n")
    ));
}

/// Fails safe: the shipped key is either the placeholder (no update traffic,
/// nothing installed) or a real minisign key, never something in between.
#[test]
fn shipped_updater_config_is_the_official_signed_feed() {
    let config = config();
    let updater = &config["plugins"]["updater"];
    let key = updater["pubkey"].as_str().expect("pubkey string");
    assert!(
        key == PLACEHOLDER_PUBKEY || pubkey_usable(key),
        "unusable updater key"
    );
    assert_eq!(
        updater["endpoints"],
        serde_json::json!([
            "https://github.com/xobash/xo-mesa/releases/latest/download/latest.json"
        ]),
        "update traffic goes only to the official release feed, with no identifiers"
    );
    assert_eq!(updater["requireSignedVersion"], true);
    // Quiet, not passive: passive shows an installer progress window.
    assert_eq!(updater["windows"]["installMode"], "quiet");
    for unsafe_switch in [
        "dangerousInsecureTransportProtocol",
        "dangerousAcceptInvalidCerts",
        "dangerousAcceptInvalidHostnames",
        "allowDowngrades",
    ] {
        assert!(updater.get(unsafe_switch).is_none(), "{unsafe_switch}");
    }
    // Updater artifacts are a release-only build option (signing key needed).
    assert!(config["bundle"].get("createUpdaterArtifacts").is_none());
}

#[test]
fn no_window_is_granted_the_plugin_commands() {
    let capabilities = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    for entry in std::fs::read_dir(capabilities).expect("capabilities folder") {
        let text = std::fs::read_to_string(entry.expect("entry").path()).expect("capability");
        assert!(!text.contains("updater:"), "renderer updater grant");
    }
}

#[test]
fn status_serializes_in_the_shape_the_renderer_reads() {
    let status = UpdateStatus {
        seq: 7,
        current_version: "0.1.0".into(),
        support: Support::Automatic,
        phase: Phase::Downloading {
            version: "0.2.0".into(),
            downloaded: 5,
            total: Some(10),
            percent: Some(50),
        },
        checked_at: Some(3),
        last_failure: Some(FailedAttempt {
            version: "0.2.0".into(),
            kind: FailureKind::Signature,
            at_ms: 2,
        }),
    };
    assert_eq!(
        serde_json::to_value(status).unwrap(),
        serde_json::json!({
            "seq": 7,
            "lastFailure": { "version": "0.2.0", "kind": "signature", "atMs": 2 },
            "currentVersion": "0.1.0",
            "support": { "kind": "automatic" },
            "state": "downloading",
            "version": "0.2.0",
            "downloaded": 5,
            "total": 10,
            "percent": 50,
            "checkedAt": 3
        })
    );
    let notify = serde_json::to_value(Support::NotifyOnly { reason: "r".into() }).unwrap();
    assert_eq!(
        notify,
        serde_json::json!({ "kind": "notifyOnly", "reason": "r" })
    );
    assert_eq!(
        serde_json::to_value(Phase::UpToDate).unwrap(),
        serde_json::json!({ "state": "upToDate" })
    );
}

#[test]
fn errors_become_short_plain_messages() {
    use tauri_plugin_updater::Error as E;
    let signature = plain_message(&E::SignedVersionMismatch {
        signed: "0.1.0".into(),
        announced: "9.9.9".into(),
    });
    assert!(
        signature.contains("signature did not verify"),
        "{signature}"
    );
    assert_eq!(plain_message(&E::MissingSignedVersion), signature);
    assert_eq!(
        plain_message(&E::ReleaseNotFound),
        "No published update was found."
    );
    assert!(plain_message(&E::Network("x".into())).contains("Couldn't reach"));
    let fallback = plain_message(&E::TempDirNotFound);
    assert!(
        fallback.len() <= 120 && !fallback.contains("TempDir"),
        "{fallback}"
    );
}

#[test]
fn every_applied_transition_raises_the_sequence_and_refusals_do_not() {
    let mut machine = Machine::default();
    let mut last = machine.seq;
    let mut step = |machine: &mut Machine, applied: bool| {
        assert_eq!(machine.seq > last, applied, "{:?}", machine.phase);
        last = machine.seq;
    };
    let applied = machine.begin_check();
    step(&mut machine, applied);
    let refused = machine.begin_check();
    step(&mut machine, refused);
    let applied = machine.found("0.2.0".into(), true, 1);
    step(&mut machine, applied);
    assert!(machine.progress(1, Some(2)).is_some());
    step(&mut machine, true);
    let applied = machine.staged();
    step(&mut machine, applied);
    let refused = machine.fail("late".into());
    step(&mut machine, refused);
    let applied = machine.install_failed("refused".into());
    step(&mut machine, applied);
    assert_eq!(
        machine.phase,
        Phase::Error {
            message: "refused".into()
        }
    );
}

#[test]
fn check_only_finds_then_downloads_on_request_and_cancel_returns_to_available() {
    let mut machine = Machine::default();
    machine.begin_check();
    assert!(machine.found("0.2.0".into(), false, 1));
    assert_eq!(
        machine.phase,
        Phase::Available {
            version: "0.2.0".into()
        }
    );
    assert!(machine.begin_download());
    assert!(matches!(&machine.phase, Phase::Downloading { version, .. } if version == "0.2.0"));
    assert!(!machine.begin_download(), "one download at a time");
    machine.progress(5, Some(10));
    assert!(machine.cancel_download());
    assert_eq!(
        machine.phase,
        Phase::Available {
            version: "0.2.0".into()
        }
    );
    assert!(!machine.cancel_download());
    assert!(!machine.install_failed("x".into()), "nothing staged");
}

#[test]
fn a_missing_feed_reads_as_up_to_date_not_an_error() {
    use tauri_plugin_updater::Error as E;
    assert_eq!(
        check_outcome::<()>(Err(E::ReleaseNotFound)),
        CheckOutcome::UpToDate
    );
    assert_eq!(check_outcome::<()>(Ok(None)), CheckOutcome::UpToDate);
    assert_eq!(check_outcome(Ok(Some(1))), CheckOutcome::Found(1));
    assert!(matches!(
        check_outcome::<()>(Err(E::Network("down".into()))),
        CheckOutcome::Failed(message) if message.contains("Couldn't reach")
    ));
}

#[test]
fn a_failed_version_is_downloaded_automatically_at_most_once_a_day() {
    let failed = FailedAttempt {
        version: "0.2.0".into(),
        kind: FailureKind::Signature,
        at_ms: 1_000,
    };
    assert!(download_allowed(None, "0.2.0", 1_000));
    assert!(!download_allowed(Some(&failed), "0.2.0", 1_000));
    assert!(!download_allowed(
        Some(&failed),
        "0.2.0",
        1_000 + RETRY_AFTER_MS - 1
    ));
    assert!(download_allowed(
        Some(&failed),
        "0.2.0",
        1_000 + RETRY_AFTER_MS
    ));
    // A newer version is not held back by an older failure.
    assert!(download_allowed(Some(&failed), "0.2.1", 1_000));
    // A clock that moved backwards never overflows into a retry storm.
    assert!(!download_allowed(Some(&failed), "0.2.0", 0));
}

#[test]
fn the_failure_record_is_one_bounded_entry_and_malformed_reads_as_none() {
    let dir = std::env::temp_dir().join(format!("mesa-update-failure-{}", std::process::id()));
    let path = dir.join("update-failure.json");
    let failed = FailedAttempt {
        version: "0.2.0".into(),
        kind: FailureKind::Install,
        at_ms: 9,
    };
    save_failure(&path, Some(&failed));
    assert_eq!(load_failure(&path), Some(failed));
    save_failure(&path, None);
    assert_eq!(load_failure(&path), None);
    std::fs::write(&path, b"{not json").unwrap();
    assert_eq!(load_failure(&path), None);
    std::fs::write(&path, vec![b' '; 8192]).unwrap();
    assert_eq!(load_failure(&path), None, "oversized");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn failures_are_classified_by_kind() {
    use tauri_plugin_updater::Error as E;
    assert_eq!(
        failure_kind(&E::MissingSignedVersion),
        FailureKind::Signature
    );
    assert_eq!(failure_kind(&E::Network("x".into())), FailureKind::Download);
    assert_eq!(failure_kind(&E::TempDirNotFound), FailureKind::Install);
}
