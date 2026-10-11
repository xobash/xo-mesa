fn identity_test_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "mesa-identity-{label}-{}-{}",
        std::process::id(),
        sync_core::now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn identity_recovers_interruption_at_every_publication_boundary() {
    for stop in 1..=3 {
        let dir = identity_test_dir(&format!("crash-{stop}"));
        assert!(load_identity(&dir, Some(stop)).is_err());
        let published = dir.join("identity.json");
        let before = if published.exists() {
            Some(std::fs::read(&published).unwrap())
        } else {
            None
        };
        let recovered = load_identity(&dir, None).unwrap();
        sync_server_config(&recovered).unwrap();
        let reopened = load_identity(&dir, None).unwrap();
        assert_eq!(recovered.fingerprint, reopened.fingerprint);
        if let Some(before) = before {
            assert_eq!(before, std::fs::read(&published).unwrap());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn identity_recovers_with_a_new_nested_configuration_directory() {
    let root = identity_test_dir("new-parents");
    let dir = root
        .join("new-config")
        .join("new-app")
        .join("sync-identity");
    assert!(load_identity(&dir, Some(2)).is_err());
    let id = load_identity(&dir, None).unwrap();
    assert_eq!(
        load_identity(&dir, None).unwrap().fingerprint,
        id.fingerprint
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn identity_migrates_complete_legacy_pair_without_rotating() {
    let dir = identity_test_dir("migrate");
    protect_identity_directory(&dir).unwrap();
    let CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let cert_pem = cert.pem();
    let key_pem = signing_key.serialize_pem();
    std::fs::write(dir.join("cert.pem"), &cert_pem).unwrap();
    persist_identity_key(&dir.join("key.pem"), key_pem.as_bytes()).unwrap();
    let id = load_identity(&dir, None).unwrap();
    assert_eq!(id.cert_pem, cert_pem);
    assert_eq!(id.key_pem, key_pem);
    assert_eq!(id.fingerprint, sha256_hex(cert.der().as_ref()));
    assert_eq!(
        load_identity(&dir, None).unwrap().fingerprint,
        id.fingerprint
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn identity_recovers_legacy_certificate_only_and_preserves_original() {
    let dir = identity_test_dir("certificate-only");
    protect_identity_directory(&dir).unwrap();
    std::fs::write(dir.join("cert.pem"), "interrupted certificate").unwrap();
    let id = load_identity(&dir, None).unwrap();
    sync_server_config(&id).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("cert.pem")).unwrap(),
        "interrupted certificate"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn identity_never_rotates_key_only_or_corrupt_published_bundle() {
    let dir = identity_test_dir("invalid");
    protect_identity_directory(&dir).unwrap();
    persist_identity_key(&dir.join("key.pem"), b"retained key").unwrap();
    assert!(load_identity(&dir, None).is_err());
    assert!(!dir.join("identity.json").exists());
    assert_eq!(std::fs::read(dir.join("key.pem")).unwrap(), b"retained key");
    std::fs::remove_file(dir.join("key.pem")).unwrap();
    load_identity(&dir, None).unwrap();
    std::fs::write(dir.join("identity.json"), b"broken bundle").unwrap();
    assert!(load_identity(&dir, None).is_err());
    assert_eq!(
        std::fs::read(dir.join("identity.json")).unwrap(),
        b"broken bundle"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn identity_bundle_permissions_are_repaired_without_rotating() {
    let dir = identity_test_dir("bundle-permissions");
    let id = load_identity(&dir, None).unwrap();
    let bundle = dir.join("identity.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&bundle).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::set_permissions(&bundle, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    #[cfg(windows)]
    assert!(std::process::Command::new("icacls.exe")
        .arg(&bundle)
        .args(["/grant", "*S-1-1-0:R", "/Q"])
        .status()
        .unwrap()
        .success());
    assert_eq!(
        load_identity(&dir, None).unwrap().fingerprint,
        id.fingerprint
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&bundle).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn identity_bundle_rejects_symlink_without_changing_target() {
    let dir = identity_test_dir("symlink");
    let outside = dir.join("outside");
    std::fs::write(&outside, b"retained").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("identity.json")).unwrap();
    assert!(load_identity(&dir, None).is_err());
    assert_eq!(std::fs::read(&outside).unwrap(), b"retained");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn identity_bundle_rejects_mismatched_legacy_pair() {
    let dir = identity_test_dir("mismatch");
    protect_identity_directory(&dir).unwrap();
    let first = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let second = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    std::fs::write(dir.join("cert.pem"), first.cert.pem()).unwrap();
    persist_identity_key(
        &dir.join("key.pem"),
        second.signing_key.serialize_pem().as_bytes(),
    )
    .unwrap();
    assert!(load_identity(&dir, None).is_err());
    assert!(!dir.join("identity.json").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(windows)]
#[test]
fn identity_acl_repairs_explicit_broad_key_access() {
    let dir = std::env::temp_dir().join(format!("mesa-identity-acl-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    super::protect_identity_directory(&dir).unwrap();
    let key = dir.join("key.pem");
    super::persist_identity_key(&key, b"synthetic identity").unwrap();
    let status = std::process::Command::new("icacls.exe")
        .arg(&key)
        .args(["/grant", "*S-1-1-0:R", "/Q"])
        .status()
        .unwrap();
    assert!(status.success());
    // The production verifier reads the effective ACL after resetting it.
    super::protect_identity_directory(&dir).unwrap();
    assert_eq!(std::fs::read(&key).unwrap(), b"synthetic identity");
    std::fs::remove_dir_all(dir).unwrap();
}
#[cfg(unix)]
#[test]
fn identity_permissions_are_private_and_repaired() {
    use std::os::unix::fs::PermissionsExt;
    let dir =
        std::env::temp_dir().join(format!("mesa-identity-permissions-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    super::protect_identity_directory(&dir).unwrap();
    let key = dir.join("key.pem");
    super::persist_identity_key(&key, b"synthetic identity").unwrap();
    assert_eq!(
        std::fs::metadata(&key).unwrap().permissions().mode() & 0o777,
        0o600
    );
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    super::protect_identity_directory(&dir).unwrap();
    assert_eq!(
        std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&key).unwrap().permissions().mode() & 0o777,
        0o600
    );
    std::fs::remove_dir_all(dir).unwrap();
}

use super::*;
use std::sync::atomic::AtomicUsize;

async fn proof_server(
    key: &'static str,
) -> (
    String,
    String,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let identity = Identity {
        cert_pem: cert.pem(),
        key_pem: signing_key.serialize_pem(),
        fingerprint: sha256_hex(cert.der().as_ref()),
    };
    let fingerprint = identity.fingerprint.clone();
    let acceptor = TlsAcceptor::from(sync_server_config(&identity).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("https://{}", listener.local_addr().unwrap());
    let transfers = Arc::new(AtomicUsize::new(0));
    let counts = transfers.clone();
    let task = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let acceptor = acceptor.clone();
            let identity = identity.clone();
            let counts = counts.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(stream).await else {
                    return;
                };
                let service = service_fn(move |req: HyperRequest<Incoming>| {
                    let identity = identity.clone();
                    let counts = counts.clone();
                    async move {
                        let path = req.uri().path();
                        let body = if path == "/sync/identity" {
                            let (message, challenge) =
                                parse_identity_request(req.uri().query().unwrap()).unwrap();
                            serde_json::to_string(
                                &make_identity_proof(
                                    key,
                                    &message,
                                    &challenge,
                                    &identity.fingerprint,
                                )
                                .unwrap(),
                            )
                            .unwrap()
                        } else if path == "/sync/manifest" {
                            "{\"journalVersion\":2,\"syncProtocolVersion\":3,\"files\":[]}"
                                .to_string()
                        } else {
                            if req.method() == HyperMethod::PUT {
                                counts.fetch_add(1, Ordering::SeqCst);
                            }
                            "ok".to_string()
                        };
                        Ok::<_, std::convert::Infallible>(HyperResponse::new(Full::new(
                            Bytes::from(body),
                        )))
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tls), service)
                    .await;
            });
        }
    });
    (base, fingerprint, transfers, task)
}

#[tokio::test]
async fn unknown_key_refuses_peer_before_any_transfer() {
    let (base, _, transfers, task) = proof_server("peer-key").await;
    let result = establish_sync_credential(&base, "local-key", None).await;
    assert!(result
        .err()
        .unwrap()
        .contains("Peer does not know this sync key"));
    assert_eq!(transfers.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
async fn proved_peer_can_fetch_manifest_and_wrong_pin_is_refused() {
    let (base, fingerprint, transfers, task) = proof_server("shared-key").await;
    let (client, credential, observed) = establish_sync_credential(&base, "shared-key", None)
        .await
        .unwrap();
    assert_eq!(observed, fingerprint);
    assert!(fetch_manifest_with(&client, &base, &credential)
        .await
        .unwrap()
        .files
        .is_empty());
    let wrong_pin = establish_sync_credential(&base, "shared-key", Some("0".repeat(64)))
        .await
        .err()
        .unwrap();
    assert!(wrong_pin.contains("security certificate changed"));
    assert_eq!(transfers.load(Ordering::SeqCst), 0);
    task.abort();
}

#[test]
fn pake_proof_is_session_nonce_and_certificate_bound() {
    let challenge = [7u8; 32];
    let fingerprint = "a".repeat(64);
    let (client, outbound) = Spake2::<Ed25519Group>::start_a(
        &Password::new(b"shared"),
        &PakeIdentity::new(b"mesa-sync-client-v3"),
        &PakeIdentity::new(b"mesa-sync-server-v3"),
    );
    let proof = make_identity_proof("shared", &outbound, &challenge, &fingerprint).unwrap();
    let reply: Vec<u8> = (0..33)
        .map(|i| u8::from_str_radix(&proof.message[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    let session = hex_bytes(&client.finish(&reply).unwrap());
    assert!(verify_server_proof(
        &session,
        &challenge,
        &fingerprint,
        &parse_hex::<32>(&proof.proof).unwrap()
    ));
    assert!(!verify_server_proof(
        "shared",
        &challenge,
        &fingerprint,
        &parse_hex::<32>(&proof.proof).unwrap()
    ));
    assert!(!verify_server_proof(
        &session,
        &[8u8; 32],
        &fingerprint,
        &parse_hex::<32>(&proof.proof).unwrap()
    ));
    assert!(!verify_server_proof(
        &session,
        &challenge,
        &"b".repeat(64),
        &parse_hex::<32>(&proof.proof).unwrap()
    ));
    let (other, _) = Spake2::<Ed25519Group>::start_a(
        &Password::new(b"shared"),
        &PakeIdentity::new(b"mesa-sync-client-v3"),
        &PakeIdentity::new(b"mesa-sync-server-v3"),
    );
    let other_session = hex_bytes(&other.finish(&reply).unwrap());
    assert!(!verify_server_proof(
        &other_session,
        &challenge,
        &fingerprint,
        &parse_hex::<32>(&proof.proof).unwrap()
    ));
}

#[test]
fn hmac_matches_rfc_4231_case_2() {
    let key = hmac::Key::new(hmac::HMAC_SHA256, b"Jefe");
    assert_eq!(
        hex_bytes(hmac::sign(&key, b"what do ya want for nothing?").as_ref()),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
}

#[test]
fn identity_proof_requires_key_challenge_and_certificate() {
    let challenge = [7u8; 32];
    let proof = server_proof("correct-key", &challenge, &"a".repeat(64));
    assert!(verify_server_proof(
        "correct-key",
        &challenge,
        &"a".repeat(64),
        proof.as_ref()
    ));
    assert!(!verify_server_proof(
        "wrong-key",
        &challenge,
        &"a".repeat(64),
        proof.as_ref()
    ));
    assert!(!verify_server_proof(
        "correct-key",
        &[8u8; 32],
        &"a".repeat(64),
        proof.as_ref()
    ));
    assert!(!verify_server_proof(
        "correct-key",
        &challenge,
        &"b".repeat(64),
        proof.as_ref()
    ));
}

#[test]
fn first_contact_credential_is_certificate_bound() {
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let credential = scoped_sync_credential("shared-key", &a);
    assert_eq!(
        credential,
        "ac654ee552735fed477f1871b9e9d0cfbcec7e44267f4a640d9ab94e359c43c8"
    );
    assert_ne!(credential, scoped_sync_credential("shared-key", &b));
    assert_ne!(credential, "shared-key");
    assert_eq!(
        scoped_sync_credential(&"0123456789abcdef".repeat(4), &a),
        "7f7eb47de4883660fabc22d30deda7a71d5dcaf433e8997f79dde376ca90efb5"
    );
}

#[tokio::test]
async fn journal_fetch_errors_fail_closed_over_http() {
    let client = reqwest::Client::new();
    for status in [404, 405, 501, 401, 503, 200] {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let handle = std::thread::spawn(move || {
            server
                .recv()
                .unwrap()
                .respond(
                    tiny_http::Response::from_string("invalid journal").with_status_code(status),
                )
                .unwrap();
        });
        let result = fetch_journal_with(&client, &format!("http://{address}"), "test-key").await;
        assert!(result.is_err(), "status {status}");
        handle.join().unwrap();
    }
}

#[test]
fn manifest_requires_journal_version() {
    assert!(serde_json::from_str::<ManifestBody>(r#"{"files":[]}"#).is_err());
    let current: ManifestBody =
        serde_json::from_str(r#"{"files":[],"journalVersion":2,"syncProtocolVersion":3}"#).unwrap();
    assert_eq!(current.journal_version, sync_core::JOURNAL_VERSION);
}

#[tokio::test]
async fn journal_receive_accepts_more_than_old_one_mib_limit() {
    let mut bytes =
        br#"{"version":2,"device":"peer","next_sequence":1,"operations":[],"known":[]}"#.to_vec();
    bytes.extend(std::iter::repeat_n(b' ', 1024 * 1024 + 1));
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let handle = std::thread::spawn(move || {
        server
            .recv()
            .unwrap()
            .respond(tiny_http::Response::from_data(bytes))
            .unwrap();
    });
    let result = fetch_journal_with(
        &reqwest::Client::new(),
        &format!("http://{address}"),
        "test-key",
    )
    .await
    .unwrap();
    assert_eq!(result.device, "peer");
    handle.join().unwrap();
}

#[test]
fn transfer_reader_requires_explicit_eof_and_preserves_order() {
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    sender
        .blocking_send(TransferChunk::Data(b"abc".to_vec()))
        .unwrap();
    sender
        .blocking_send(TransferChunk::Data(b"def".to_vec()))
        .unwrap();
    sender.blocking_send(TransferChunk::End).unwrap();
    drop(sender);
    let mut reader = TransferReader {
        receiver,
        current: std::io::Cursor::new(Vec::new()),
        finished: false,
    };
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"abcdef");
    assert_eq!(reader.read(&mut [0u8; 1]).unwrap(), 0);
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    sender
        .blocking_send(TransferChunk::Data(b"partial".to_vec()))
        .unwrap();
    drop(sender);
    let mut reader = TransferReader {
        receiver,
        current: std::io::Cursor::new(Vec::new()),
        finished: false,
    };
    assert_eq!(
        reader.read_to_end(&mut Vec::new()).unwrap_err().kind(),
        std::io::ErrorKind::UnexpectedEof
    );
}

#[test]
fn upload_hashes_and_rewinds_same_handle_and_rejects_oversize() {
    let path = std::env::temp_dir().join(format!(
        "mesa-upload-{}-{}",
        std::process::id(),
        sync_core::now_ms()
    ));
    let bytes = vec![123u8; 170_003];
    std::fs::write(&path, &bytes).unwrap();
    let (mut file, size, hash) = open_upload(&path).unwrap();
    assert_eq!(size, bytes.len() as u64);
    assert_eq!(hash, sync_core::content_hash_hex(&bytes));
    let mut actual = Vec::new();
    file.read_to_end(&mut actual).unwrap();
    assert_eq!(actual, bytes);
    drop(file);
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(MAX_PUT_BYTES as u64 + 1).unwrap();
    drop(file);
    assert_eq!(
        open_upload(&path).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn upload_streams_same_open_file_over_real_http() {
    let path = std::env::temp_dir().join(format!(
        "mesa-http-upload-{}-{}",
        std::process::id(),
        sync_core::now_ms()
    ));
    let bytes: Vec<_> = (0..192 * 1024 + 17).map(|n| (n % 251) as u8).collect();
    std::fs::write(&path, &bytes).unwrap();
    let (file, size, hash) = open_upload(&path).unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let expected_hash = hash.clone();
    let handle = std::thread::spawn(move || {
        let mut request = server.recv().unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Put);
        assert_eq!(request.body_length(), Some(bytes.len()));
        assert!(request.url().ends_with(&format!("hash={expected_hash}")));
        let mut received = Vec::new();
        request.as_reader().read_to_end(&mut received).unwrap();
        assert_eq!(received, bytes);
        request
            .respond(tiny_http::Response::from_string("ok"))
            .unwrap();
    });
    let response = reqwest::Client::new()
        .put(format!("http://{address}/sync/file"))
        .query(&[("rel", "file.bin"), ("hash", hash.as_str())])
        .header(reqwest::header::CONTENT_LENGTH, size)
        .body(reqwest::Body::from(tokio::fs::File::from_std(file)))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    handle.join().unwrap();
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn receive_response_streams_and_verifies_real_http_body() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let bytes = vec![77u8; 192 * 1024 + 17];
    let expected_hash = sync_core::content_hash_hex(&bytes);
    let expected_size = bytes.len() as u64;
    let handle = std::thread::spawn(move || {
        let request = server.recv().unwrap();
        request
            .respond(tiny_http::Response::from_data(bytes))
            .unwrap();
    });
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://{address}/file"))
        .send()
        .await
        .unwrap();
    let target = std::env::temp_dir().join(format!(
        "mesa-http-receive-{}-{}",
        std::process::id(),
        sync_core::now_ms()
    ));
    let stage = receive_response(
        response,
        target.clone(),
        #[cfg(unix)]
        None,
        expected_size,
        expected_hash.clone(),
    )
    .await
    .unwrap();
    assert!(!target.exists());
    let commit_target = target.clone();
    tokio::task::spawn_blocking(move || stage.commit(&commit_target).unwrap())
        .await
        .unwrap();
    assert_eq!(
        sync_core::hash_file_streaming(&target).unwrap(),
        (expected_size, expected_hash)
    );
    std::fs::remove_file(target).unwrap();
    handle.join().unwrap();
}

fn line(msg: &str) -> SyncLogLine {
    SyncLogLine {
        ts: 0,
        level: "info".to_string(),
        msg: msg.to_string(),
    }
}

// The whole point on Windows: a full-vault sync stages thousands of console
// lines but the flusher drains them as ONE `sync://log` array event per
// window instead of one eval + forced repaint per file. The reduction is a
// property of the file count, not the OS notify backend, so it is pinned
// here rather than by a live event count. Mirrors `vaultwatch.rs`'s
// `git_storm_collapses_to_one_send`.
#[test]
fn storm_of_log_lines_drains_as_one_ordered_batch() {
    let mut outbox = SyncOutbox::new();
    for i in 0..3301 {
        outbox.logs.push(line(&format!("received file-{i}.md")));
    }
    assert!(outbox.has_pending());
    let (logs, progress) = outbox.drain();
    // 3,301 events → 1 batch.
    assert_eq!(logs.len(), 3301);
    assert_eq!(logs[0].msg, "received file-0.md");
    assert_eq!(logs[3300].msg, "received file-3300.md");
    assert!(progress.is_none());
    // Fully drained: nothing left to emit, no lines dropped.
    assert!(!outbox.has_pending());
    assert!(outbox.logs.is_empty());
}

// Progress is a bar + current-file label, so only the newest value matters;
// every intermediate update collapses to the latest within a window.
#[test]
fn progress_collapses_to_latest_within_a_window() {
    let mut outbox = SyncOutbox::new();
    for done in 1..=500usize {
        outbox.progress =
            Some(serde_json::json!({ "phase": "transfer", "done": done, "total": 500, "rel": "" }));
    }
    let (logs, progress) = outbox.drain();
    assert!(logs.is_empty());
    let progress = progress.expect("latest progress survives");
    assert_eq!(progress["done"], 500);
    assert_eq!(progress["phase"], "transfer");
}

// `flush_now` (set by `flush_sync_events` at sync end) is cleared by a drain,
// so it forces exactly one immediate emit and never leaves the flusher
// spinning.
#[test]
fn drain_clears_the_immediate_flush_request() {
    let mut outbox = SyncOutbox::new();
    outbox.flush_now = true;
    assert!(!outbox.has_pending()); // a bare flush request has nothing staged
    let (logs, progress) = outbox.drain();
    assert!(logs.is_empty());
    assert!(progress.is_none());
    assert!(!outbox.flush_now);
}

// The batched array element must serialize to the exact `{ ts, level, msg }`
// shape `SyncLogEntry` in `src/lib/sync.ts` (and `appendSyncLog`) expect —
// the only wire-shape change is object → array, not the object itself.
#[test]
fn log_line_matches_frontend_entry_shape() {
    let value = serde_json::to_value(SyncLogLine {
        ts: 1234,
        level: "warn".to_string(),
        msg: "hello".to_string(),
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "ts": 1234, "level": "warn", "msg": "hello" })
    );
}

#[test]
fn sync_responses_do_not_opt_into_browser_cross_origin_access() {
    let response = hyper_response(StatusCode::OK, "ok");
    for header in [
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-allow-private-network",
    ] {
        assert!(
            response.headers().get(header).is_none(),
            "unexpected {header}"
        );
    }
}

#[test]
fn sync_run_guard_rejects_overlap_and_releases_after_drop() {
    let first = SyncRunGuard::acquire().expect("first run acquires the guard");
    assert!(SyncRunGuard::acquire().is_err());
    drop(first);
    assert!(SyncRunGuard::acquire().is_ok());
    sync_running().store(false, Ordering::Release);
}

#[test]
fn retry_filter_admits_only_named_failed_paths() {
    assert!(retry_allows(None, "a.md"));
    let retry = std::collections::HashSet::from(["a.md".to_string(), "nested/b.pdf".to_string()]);
    assert!(retry_allows(Some(&retry), "a.md"));
    assert!(retry_allows(Some(&retry), "nested/b.pdf"));
    assert!(!retry_allows(Some(&retry), "other.md"));
}

async fn bounded_test_server(header_timeout: Duration) -> (std::net::SocketAddr, Arc<PeerSlots>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let slots = Arc::new(PeerSlots::default());
    let accept_slots = slots.clone();
    tokio::spawn(async move {
        loop {
            let (stream, peer) = listener.accept().await.unwrap();
            let Some(slot) = PeerSlots::acquire(&accept_slots, peer.ip()) else {
                continue;
            };
            tokio::spawn(async move {
                let _slot = slot;
                let service = service_fn(|req: HyperRequest<Incoming>| async move {
                    // Mirrors the identity route: hostile query bytes get 400.
                    let status = match req.uri().query().map(parse_identity_request) {
                        Some(None) => StatusCode::BAD_REQUEST,
                        _ => StatusCode::OK,
                    };
                    Ok::<_, hyper::Error>(hyper_response(status, "x"))
                });
                serve_bounded(TokioIo::new(stream), service, header_timeout).await;
            });
        }
    });
    (addr, slots)
}

async fn raw_exchange(addr: std::net::SocketAddr, request: &[u8]) -> Vec<u8> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        let mut buffer = [0u8; 256];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    response.extend_from_slice(&buffer[..n]);
                    if response.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
            }
        }
    })
    .await;
    response
}

#[tokio::test]
async fn stalled_connections_are_closed_and_real_clients_still_served() {
    use tokio::io::AsyncReadExt;
    let (addr, _slots) = bounded_test_server(Duration::from_millis(300)).await;
    let mut stalled = Vec::new();
    for _ in 0..PEER_CONNECTION_LIMIT {
        stalled.push(tokio::net::TcpStream::connect(addr).await.unwrap());
    }
    // Connections that send no request headers are closed by the server.
    for stream in &mut stalled {
        let mut byte = [0u8; 1];
        let closed = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
            .await
            .expect("server must close a silent connection");
        assert!(matches!(closed, Ok(0) | Err(_)));
    }
    let reply = raw_exchange(
        addr,
        b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(reply.starts_with(b"HTTP/1.1 200"), "{reply:?}");
}

#[tokio::test]
async fn one_address_cannot_take_every_connection_slot() {
    let (addr, slots) = bounded_test_server(Duration::from_secs(5)).await;
    let mut held = Vec::new();
    for _ in 0..PEER_CONNECTION_LIMIT + 3 {
        held.push(tokio::net::TcpStream::connect(addr).await.unwrap());
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let counts = slots.0.lock().unwrap();
    assert_eq!(counts.values().copied().max(), Some(PEER_CONNECTION_LIMIT));
}

#[tokio::test]
async fn non_ascii_identity_query_gets_400_and_server_keeps_serving() {
    let (addr, _slots) = bounded_test_server(Duration::from_secs(5)).await;
    let mut request = b"GET /sync/identity?pake=a".to_vec();
    request.extend_from_slice("€".as_bytes());
    request.extend_from_slice("0".repeat(62).as_bytes());
    request.extend_from_slice(
        format!(
            "&nonce={} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
            "0".repeat(64)
        )
        .as_bytes(),
    );
    let reply = raw_exchange(addr, &request).await;
    assert!(
        reply.starts_with(b"HTTP/1.1 400"),
        "{:?}",
        String::from_utf8_lossy(&reply)
    );
    let ok = raw_exchange(
        addr,
        b"GET /x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(ok.starts_with(b"HTTP/1.1 200"));
}

#[tokio::test]
async fn oversize_response_is_rejected_without_buffering_past_the_cap() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let handle = std::thread::spawn(move || {
        server
            .recv()
            .unwrap()
            .respond(tiny_http::Response::from_data(vec![b' '; 3 * 1024 * 1024]))
            .unwrap();
    });
    let response = reqwest::get(format!("http://{address}")).await.unwrap();
    let error = read_capped(response, 1024 * 1024, "Peer manifest")
        .await
        .unwrap_err();
    assert_eq!(error, "Peer manifest exceeds the 1 MiB exchange limit");
    // The runtime must stay free to close the abandoned socket, or the sender
    // blocks on its unread data.
    let _ = tokio::task::spawn_blocking(move || handle.join()).await;
}

#[tokio::test]
async fn chunked_manifest_without_length_stops_at_stream_cap() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let sender = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0; 1024];
        let count = socket.read(&mut request).unwrap();
        assert!(count > 0, "test client must send a request");
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        for _ in 0..3 {
            if socket
                .write_all(b"400\r\n")
                .and_then(|_| socket.write_all(&[b' '; 1024]))
                .and_then(|_| socket.write_all(b"\r\n"))
                .is_err()
            {
                return;
            }
        }
        let _ = socket.write_all(b"0\r\n\r\n");
    });
    let response = reqwest::get(format!("http://{addr}")).await.unwrap();
    assert!(response.content_length().is_none());
    assert!(read_capped(response, 1024, "Peer manifest")
        .await
        .unwrap_err()
        .contains("exchange limit"));
    tokio::task::spawn_blocking(move || sender.join().unwrap())
        .await
        .unwrap();
}
#[test]
fn remote_manifest_rejects_invalid_fields_duplicates_and_count() {
    let entry = ManifestEntry {
        rel: "note.md".into(),
        size: 7,
        hash: "a".repeat(64),
    };
    assert!(validate_remote_manifest(std::slice::from_ref(&entry)).is_ok());
    assert!(validate_remote_manifest(&[entry.clone(), entry.clone()]).is_err());
    for rel in [
        "../outside".into(),
        ".hidden/note.md".into(),
        "x".repeat(MAX_MANIFEST_REL_BYTES + 1),
    ] {
        let mut bad = entry.clone();
        bad.rel = rel;
        assert!(validate_remote_manifest(&[bad]).is_err());
    }
    for hash in ["a".repeat(65), "g".repeat(64), "A".repeat(64)] {
        let mut bad = entry.clone();
        bad.hash = hash;
        assert!(validate_remote_manifest(&[bad]).is_err());
    }
    assert!(validate_remote_manifest(&vec![entry; MAX_MANIFEST_FILES + 1]).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn private_directory_clears_inherited_acl_grants_before_storage() {
    let dir = identity_test_dir("private-acl");
    std::fs::create_dir_all(&dir).unwrap();
    assert!(std::process::Command::new("chmod")
        .args([
            "+a",
            "everyone allow read,search,file_inherit,directory_inherit"
        ])
        .arg(&dir)
        .status()
        .unwrap()
        .success());
    std::fs::write(dir.join("private.json"), b"synthetic").unwrap();
    protect_private_directory(&dir, &["private.json"]).unwrap();
    for path in [&dir, &dir.join("private.json")] {
        let listing = std::process::Command::new("ls")
            .arg("-lde")
            .arg(path)
            .output()
            .unwrap();
        assert!(listing.status.success());
        assert!(!String::from_utf8_lossy(&listing.stdout).contains("everyone allow"));
    }
    std::fs::remove_dir_all(dir).unwrap();
}
