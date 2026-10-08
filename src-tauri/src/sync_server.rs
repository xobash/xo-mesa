use super::*;

pub(super) type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub(super) type HyperBody = http_body_util::combinators::BoxBody<Bytes, BoxError>;

pub(super) fn hyper_response(code: StatusCode, body: impl Into<Bytes>) -> HyperResponse<HyperBody> {
    let body = Full::new(body.into())
        .map_err(|never| match never {})
        .boxed();
    let mut resp = HyperResponse::new(body);
    *resp.status_mut() = code;
    resp
}

pub(super) fn hyper_json(body: String) -> HyperResponse<HyperBody> {
    let mut resp = hyper_response(StatusCode::OK, body);
    resp.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    resp
}

pub(super) fn hyper_auth_ok(req: &HyperRequest<Incoming>, token: &str) -> bool {
    req.headers()
        .get(hyper::header::AUTHORIZATION)
        .is_some_and(|value| {
            value
                .to_str()
                .map(|value| crate::bearer::matches(value, token))
                .unwrap_or(false)
        })
}

// A credential is scoped to the server certificate. First contact may trust
// the wrong certificate, but it must never reveal the reusable shared key.
pub(super) fn scoped_sync_credential(key: &str, fingerprint: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    hex_bytes(hmac::sign(&key, format!("mesa-sync-cert-v1:{fingerprint}").as_bytes()).as_ref())
}

pub(super) fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn nonce() -> Result<[u8; 32], String> {
    let mut value = [0u8; 32];
    SystemRandom::new()
        .fill(&mut value)
        .map_err(|_| "Could not create sync challenge.".to_string())?;
    Ok(value)
}

pub(super) fn server_proof(key: &str, challenge: &[u8; 32], fingerprint: &str) -> hmac::Tag {
    let secret = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    let mut message = b"mesa-sync-server-v1:".to_vec();
    message.extend_from_slice(challenge);
    message.extend_from_slice(fingerprint.as_bytes());
    hmac::sign(&secret, &message)
}

pub(super) fn verify_server_proof(
    key: &str,
    challenge: &[u8; 32],
    fingerprint: &str,
    proof: &[u8],
) -> bool {
    let secret = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    let mut message = b"mesa-sync-server-v1:".to_vec();
    message.extend_from_slice(challenge);
    message.extend_from_slice(fingerprint.as_bytes());
    hmac::verify(&secret, &message, proof).is_ok()
}

pub(super) fn parse_identity_request(query: &str) -> Option<([u8; 33], [u8; 32])> {
    let (message, nonce) = query.strip_prefix("pake=")?.split_once("&nonce=")?;
    Some((parse_hex::<33>(message)?, parse_hex::<32>(nonce)?))
}
pub(super) fn make_identity_proof(
    key: &str,
    message: &[u8],
    challenge: &[u8; 32],
    fingerprint: &str,
) -> Result<IdentityProof, String> {
    let (state, reply) = Spake2::<Ed25519Group>::start_b(
        &Password::new(key.as_bytes()),
        &PakeIdentity::new(b"mesa-sync-client-v3"),
        &PakeIdentity::new(b"mesa-sync-server-v3"),
    );
    let session = state.finish(message).map_err(|_| "invalid key exchange")?;
    Ok(IdentityProof {
        message: hex_bytes(&reply),
        proof: hex_bytes(server_proof(&hex_bytes(&session), challenge, fingerprint).as_ref()),
    })
}

pub(super) fn parse_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 {
        return None;
    }
    let mut result = [0u8; N];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(result)
}

#[derive(Serialize, Deserialize)]
pub(super) struct IdentityProof {
    pub(super) message: String,
    pub(super) proof: String,
}

#[derive(Default)]
pub(super) struct AuthLimiter(Mutex<HashMap<IpAddr, (u8, Instant)>>);

impl AuthLimiter {
    pub(super) fn bucket(peer: IpAddr) -> IpAddr {
        match peer {
            IpAddr::V4(_) => peer,
            IpAddr::V6(address) => {
                let mut octets = address.octets();
                octets[8..].fill(0);
                IpAddr::V6(octets.into())
            }
        }
    }

    fn blocked_locked(attempts: &mut HashMap<IpAddr, (u8, Instant)>, peer: IpAddr) -> bool {
        match attempts.get(&peer).copied() {
            Some((count, since)) if count >= 5 && since.elapsed() < Duration::from_secs(60) => true,
            Some((_, since)) if since.elapsed() >= Duration::from_secs(60) => {
                attempts.remove(&peer);
                false
            }
            _ => false,
        }
    }

    fn blocked(&self, peer: IpAddr) -> bool {
        let Ok(mut attempts) = self.0.lock() else {
            return true;
        };
        Self::blocked_locked(&mut attempts, Self::bucket(peer))
    }

    fn record_locked(attempts: &mut HashMap<IpAddr, (u8, Instant)>, peer: IpAddr, valid: bool) {
        if valid {
            attempts.remove(&peer);
            return;
        }
        if attempts.len() >= 4096 && !attempts.contains_key(&peer) {
            attempts.retain(|_, (_, since)| since.elapsed() < Duration::from_secs(60));
            if attempts.len() >= 4096 {
                if let Some(oldest) = attempts
                    .iter()
                    .min_by_key(|(_, (_, since))| since)
                    .map(|(peer, _)| *peer)
                {
                    attempts.remove(&oldest);
                }
            }
        }
        let entry = attempts.entry(peer).or_insert((0, Instant::now()));
        entry.0 = entry.0.saturating_add(1);
    }

    fn record(&self, peer: IpAddr, valid: bool) {
        let Ok(mut attempts) = self.0.lock() else {
            return;
        };
        Self::record_locked(&mut attempts, Self::bucket(peer), valid);
    }

    fn admit_identity(&self, peer: IpAddr) -> bool {
        let Ok(mut attempts) = self.0.lock() else {
            return false;
        };
        let peer = Self::bucket(peer);
        if Self::blocked_locked(&mut attempts, peer) {
            return false;
        }
        Self::record_locked(&mut attempts, peer, false);
        true
    }
}

#[cfg(test)]
mod auth_limit_tests {
    use super::{require_sync_key, AuthLimiter};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn file_limit_is_safe_by_default_and_explicitly_bounded() {
        use super::parse_transfer_limit;
        assert_eq!(parse_transfer_limit(None).unwrap(), 64 * 1024 * 1024);
        assert_eq!(
            parse_transfer_limit(Some("256")).unwrap(),
            256 * 1024 * 1024
        );
        for value in ["0", "257", "-1", "", "no", "18446744073709551615"] {
            assert!(parse_transfer_limit(Some(value)).is_err());
        }
    }

    #[test]
    fn upload_bytes_are_bounded_across_concurrency_failure_and_ipv6_rotation() {
        use super::{UploadBudget, MAX_INFLIGHT_PUT_BYTES, PEER_UPLOAD_BYTES_PER_HOUR};
        use std::time::{Duration, Instant};
        let budget = UploadBudget::default();
        let now = Instant::now();
        let peer: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let rotated: IpAddr = "2001:db8:1:2::2".parse().unwrap();
        let reservation = budget.reserve(peer, MAX_INFLIGHT_PUT_BYTES, now).unwrap();
        assert!(budget.reserve(rotated, 1, now).is_err());
        drop(reservation);
        for _ in 1..(PEER_UPLOAD_BYTES_PER_HOUR / MAX_INFLIGHT_PUT_BYTES) {
            drop(
                budget
                    .reserve(rotated, MAX_INFLIGHT_PUT_BYTES, now)
                    .unwrap(),
            );
        }
        assert!(budget.reserve(peer, 1, now).is_err());
        drop(
            budget
                .reserve(peer, 1, now + Duration::from_secs(3600))
                .unwrap(),
        );
        assert_eq!(budget.state.lock().unwrap().inflight, 0);
    }

    #[test]
    fn five_failures_block_one_peer_without_blocking_others() {
        let limiter = AuthLimiter::default();
        let first = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
        let second = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2));
        for _ in 0..5 {
            assert!(!limiter.blocked(first));
            limiter.record(first, false);
        }
        assert!(limiter.blocked(first));
        assert!(!limiter.blocked(second));
        limiter.record(second, false);
        limiter.record(second, true);
        assert!(!limiter.blocked(second));
    }

    #[test]
    fn identity_probes_are_limited_and_ipv6_uses_a_shared_prefix() {
        let limiter = AuthLimiter::default();
        let first = IpAddr::V6("2001:db8:1:2::1".parse::<Ipv6Addr>().unwrap());
        let same_prefix = IpAddr::V6("2001:db8:1:2::2".parse::<Ipv6Addr>().unwrap());
        let other_prefix = IpAddr::V6("2001:db8:1:3::1".parse::<Ipv6Addr>().unwrap());
        for _ in 0..5 {
            assert!(limiter.admit_identity(first));
        }
        assert!(!limiter.admit_identity(same_prefix));
        assert!(limiter.admit_identity(other_prefix));
    }

    #[test]
    fn a_full_limiter_still_records_new_peers() {
        let limiter = AuthLimiter::default();
        for number in 0..4096u16 {
            limiter.record(
                IpAddr::V4(Ipv4Addr::new(198, 18, (number >> 8) as u8, number as u8)),
                false,
            );
        }
        let newest = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1));
        for _ in 0..5 {
            limiter.record(newest, false);
        }
        assert!(limiter.blocked(newest));
        assert_eq!(limiter.0.lock().unwrap().len(), 4096);
    }

    #[test]
    fn sync_key_requires_32_bytes_of_lowercase_hex() {
        assert!(require_sync_key(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        )
        .is_ok());
        assert!(require_sync_key(&"a".repeat(64)).is_err());
        assert!(require_sync_key(&"01234567".repeat(8)).is_err());
        for key in [
            "A".repeat(64),
            "g".repeat(64),
            "a".repeat(63),
            "a".repeat(65),
        ] {
            assert!(require_sync_key(&key).is_err());
        }
    }
}

pub(super) fn receive_error_status(error: &sync_core::ReceiveError) -> StatusCode {
    match error {
        sync_core::ReceiveError::TooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
        sync_core::ReceiveError::HashMismatch { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        sync_core::ReceiveError::Read(_) | sync_core::ReceiveError::SizeMismatch { .. } => {
            StatusCode::BAD_REQUEST
        }
        sync_core::ReceiveError::Write(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[cfg(not(unix))]
pub(super) fn open_sync_file_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    sync_core::open_file_no_follow(path)
}

pub(super) async fn handle_hyper(
    mut req: HyperRequest<Incoming>,
    root: Arc<PathBuf>,
    token: Arc<String>,
    app: tauri::AppHandle,
    peer: IpAddr,
    auth_limiter: Arc<AuthLimiter>,
) -> HyperResponse<HyperBody> {
    let method = req.method().clone();
    if method == HyperMethod::GET && req.uri().path() == "/sync/identity" {
        if !auth_limiter.admit_identity(peer) {
            return hyper_response(StatusCode::TOO_MANY_REQUESTS, "too many attempts");
        }
        let Some((message, challenge)) = parse_identity_request(req.uri().query().unwrap_or(""))
        else {
            return hyper_response(StatusCode::BAD_REQUEST, "invalid key exchange");
        };
        let identity = match get_identity(&app) {
            Ok(identity) => identity,
            Err(_) => {
                return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, "identity unavailable")
            }
        };
        return match make_identity_proof(&token, &message, &challenge, &identity.fingerprint) {
            Ok(proof) => hyper_json(serde_json::to_string(&proof).expect("serializable proof")),
            Err(_) => hyper_response(StatusCode::BAD_REQUEST, "invalid key exchange"),
        };
    }
    if auth_limiter.blocked(peer) {
        return hyper_response(StatusCode::TOO_MANY_REQUESTS, "too many attempts");
    }
    let fingerprint = match get_identity(&app) {
        Ok(identity) => identity.fingerprint,
        Err(_) => return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, "identity unavailable"),
    };
    let authorized = hyper_auth_ok(&req, &scoped_sync_credential(&token, &fingerprint));
    auth_limiter.record(peer, authorized);
    if !authorized {
        emit_log(
            &app,
            "warn",
            format!(
                "[serve] rejected {} {} — bad or missing sync key",
                method,
                req.uri()
            ),
        );
        return hyper_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if method == HyperMethod::OPTIONS {
        return hyper_response(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    let _access = match crate::vaulttransaction::access(&root).await {
        Ok(guard) => guard,
        Err(error) => return hyper_response(StatusCode::CONFLICT, error),
    };

    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();

    if path == "/activity" && method == HyperMethod::POST {
        let mut body = Vec::new();
        while let Some(frame) = req.body_mut().frame().await {
            let frame = match frame {
                Ok(frame) => frame,
                Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "read error"),
            };
            if let Some(bytes) = frame.data_ref() {
                if body.len().saturating_add(bytes.len()) > MAX_ACTIVITY_BYTES {
                    return hyper_response(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "activity body too large",
                    );
                }
                body.extend_from_slice(bytes);
            }
        }
        match String::from_utf8(body) {
            Ok(body) => {
                let _ = app.emit("activity", body);
                return hyper_response(StatusCode::OK, "ok");
            }
            Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "read error"),
        }
    }

    if path == "/sync/manifest" && method == HyperMethod::GET {
        let started = Instant::now();
        let manifest_root = root.as_ref().clone();
        let (entries, skipped) = match tokio::task::spawn_blocking(move || {
            let _scan_guard = manifest_lock()
                .lock()
                .map_err(|_| "manifest lock poisoned".to_string())?;
            Ok::<_, String>(sync_core::build_manifest(&manifest_root))
        })
        .await
        {
            Ok(Ok(manifest)) => manifest,
            Ok(Err(error)) => return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error),
            Err(error) => {
                return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            }
        };
        if !skipped.is_empty() {
            for (rel, err) in &skipped {
                emit_log(
                    &app,
                    "warn",
                    format!("[serve] manifest incomplete at {rel}: {err}"),
                );
            }
            // A partial manifest is not a safe sync baseline.  Returning an
            // explicit failure prevents both current and older peers from
            // interpreting omitted paths as deletion or rename intent.
            return hyper_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "vault scan incomplete; fix the listed path and retry",
            );
        }
        if let Err(error) = sync_core::reconcile_complete_journal(&root, &entries, &skipped) {
            emit_log(
                &app,
                "warn",
                format!("[serve] journal reconciliation failed: {error}"),
            );
        }
        emit_log(
            &app,
            "info",
            format!(
                "[serve] manifest served — {} files in {}ms",
                entries.len(),
                started.elapsed().as_millis()
            ),
        );
        return hyper_json(sync_core::manifest_to_json(&entries));
    }

    if path == "/sync/journal" && method == HyperMethod::GET {
        return match sync_core::load_journal(&root) {
            Ok(journal) => match sync_core::journal_wire_bytes(&journal)
                .map(|bytes| String::from_utf8(bytes).expect("JSON is UTF-8"))
            {
                Ok(body) => hyper_json(body),
                Err(error) => hyper_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("journal encode failed: {error}"),
                ),
            },
            Err(error) => hyper_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("journal unavailable: {error}"),
            ),
        };
    }

    if path == "/sync/journal" && method == HyperMethod::PUT {
        // The shared sync key authenticates incoming requests. This identity
        // associates their journal participant with the saved peer for retirement;
        // it is not a substitute for the client's TLS server pin.
        let sender_fingerprint = req
            .headers()
            .get("x-mesa-fingerprint")
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase);
        // Journal operations are control-plane data, not ordinary vault files.
        // Apply them while the receiver owns the request so an initiator's
        // delete cannot be immediately reintroduced by the receiver's stale
        // manifest during that same sync.
        let mut body = Vec::new();
        while let Some(frame) = req.body_mut().frame().await {
            let frame = match frame {
                Ok(frame) => frame,
                Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "could not read journal"),
            };
            if let Some(bytes) = frame.data_ref() {
                if body.len().saturating_add(bytes.len()) > sync_core::MAX_JOURNAL_WIRE_BYTES {
                    return hyper_response(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "journal exceeds the 32 MiB exchange limit",
                    );
                }
                body.extend_from_slice(bytes);
            }
        }
        let incoming: sync_core::SyncJournal = match serde_json::from_slice(&body) {
            Ok(journal) => journal,
            Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "invalid sync journal"),
        };
        let root_for_apply = root.as_ref().clone();
        let result = tokio::task::spawn_blocking(move || {
            sync_core::validate_journal(&incoming, "peer journal")
                .map_err(|error| error.to_string())?;
            if let Some(fingerprint) = sender_fingerprint {
                sync_core::bind_journal_peer(
                    &root_for_apply,
                    &fingerprint,
                    &incoming.device,
                    false,
                )
                .map_err(|error| error.to_string())?;
            }
            sync_core::apply_incoming_journal(&root_for_apply, &incoming)
                .map_err(|error| error.to_string())
        })
        .await;
        return match result {
            Ok(Ok((journal, outcomes))) => {
                for outcome in outcomes {
                    match outcome.result {
                        Ok(sync_core::JournalApply::Applied | sync_core::JournalApply::AlreadyApplied) => emit_log(&app, "info", format!("[serve] applied peer journal operation {}", outcome.operation.id)),
                        Ok(sync_core::JournalApply::Conflict) => emit_log(&app, "warn", format!("[serve] preserved local bytes for conflicting peer journal operation {}", outcome.operation.id)),
                        Err(error) => emit_log(&app, "warn", format!("[serve] peer journal operation {} failed: {error}", outcome.operation.id)),
                    }
                }
                sync_core::journal_wire_bytes(&journal)
                    .map(|bytes| String::from_utf8(bytes).expect("JSON is UTF-8"))
                    .map(hyper_json)
                    .unwrap_or_else(|error| {
                        hyper_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("journal encode failed: {error}"),
                        )
                    })
            }
            Ok(Err(error)) => hyper_response(StatusCode::CONFLICT, error),
            Err(error) => hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }

    if path == "/sync/base" && method == HyperMethod::PUT {
        let Some(sender) = req
            .headers()
            .get("x-mesa-fingerprint")
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase)
        else {
            return hyper_response(StatusCode::BAD_REQUEST, "missing peer identity");
        };
        let mut body = Vec::new();
        while let Some(frame) = req.body_mut().frame().await {
            let frame = match frame {
                Ok(frame) => frame,
                Err(_) => {
                    return hyper_response(StatusCode::BAD_REQUEST, "could not read sync base")
                }
            };
            if let Some(bytes) = frame.data_ref() {
                if body.len().saturating_add(bytes.len()) > sync_core::MAX_JOURNAL_WIRE_BYTES {
                    return hyper_response(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "sync base exceeds 32 MiB",
                    );
                }
                body.extend_from_slice(bytes);
            }
        }
        let offered: Vec<sync_core::JournalEntry> = match serde_json::from_slice(&body) {
            Ok(entries) => entries,
            Err(_) => return hyper_response(StatusCode::BAD_REQUEST, "invalid sync base"),
        };
        let base_root = root.as_ref().clone();
        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let _scan_guard = manifest_lock().lock().map_err(|error| error.to_string())?;
            let (current, skipped) = sync_core::build_manifest(&base_root);
            drop(_scan_guard);
            if !skipped.is_empty() {
                return Err("receiver scan is incomplete".into());
            }
            let offered: Vec<ManifestEntry> = offered
                .into_iter()
                .filter_map(|entry| {
                    sync_core::safe_join(&base_root, &entry.rel).map(|_| ManifestEntry {
                        rel: entry.rel,
                        size: entry.size,
                        hash: entry.hash,
                    })
                })
                .collect();
            let common = sync_core::common_baseline(&current, &offered);
            sync_core::save_peer_baseline(&base_root, &sender, common)
                .map_err(|error| error.to_string())
        })
        .await;
        return match result {
            Ok(Ok(())) => hyper_response(StatusCode::OK, "ok"),
            Ok(Err(error)) => hyper_response(StatusCode::CONFLICT, error),
            Err(error) => hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }

    if path == "/sync/file" {
        let Some(rel) = sync_core::query_param(&query, "rel") else {
            return hyper_response(StatusCode::BAD_REQUEST, "missing rel");
        };
        let Some(full) = sync_core::safe_join_confined(&root, &rel) else {
            emit_log(
                &app,
                "warn",
                format!("[serve] rejected unsafe path {rel:?}"),
            );
            return hyper_response(StatusCode::BAD_REQUEST, "bad path");
        };
        if method == HyperMethod::GET {
            #[cfg(not(unix))]
            let path = full.clone();
            #[cfg(unix)]
            let root_for_read = root.clone();
            #[cfg(unix)]
            let rel_for_read = rel.clone();
            let file = match tokio::task::spawn_blocking(move || {
                #[cfg(unix)]
                {
                    sync_core::RootedTarget::resolve(&root_for_read, &rel_for_read, false)?
                        .open_read()
                }
                #[cfg(not(unix))]
                {
                    open_sync_file_no_follow(&path)
                }
            })
            .await
            {
                Ok(Ok(file)) => tokio::fs::File::from_std(file),
                Ok(Err(_)) => return hyper_response(StatusCode::NOT_FOUND, "not found"),
                Err(_) => {
                    return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, "file open failed")
                }
            };
            let stream = ReaderStream::with_capacity(file, TRANSFER_CHUNK_BYTES).map(|chunk| {
                chunk
                    .map(Frame::data)
                    .map_err(|error| Box::new(error) as BoxError)
            });
            return HyperResponse::builder()
                .status(StatusCode::OK)
                .body(BodyExt::boxed(StreamBody::new(stream)))
                .unwrap_or_else(|_| {
                    hyper_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "response construction failed",
                    )
                });
        }
        if method == HyperMethod::PUT {
            let prior = match req.headers().get(hyper::header::IF_MATCH) {
                None => None,
                Some(value) => {
                    let parsed = value
                        .to_str()
                        .ok()
                        .and_then(|text| text.strip_prefix('"'))
                        .and_then(|text| text.strip_suffix('"'))
                        .and_then(|text| text.split_once(':'))
                        .and_then(|(size, hash)| {
                            if hash.len() != 64
                                || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                            {
                                return None;
                            }
                            Some((size.parse::<u64>().ok()?, hash.to_string()))
                        });
                    let Some(parsed) = parsed else {
                        return hyper_response(StatusCode::BAD_REQUEST, "invalid If-Match base");
                    };
                    Some(parsed)
                }
            };
            let expected_size = req
                .headers()
                .get(hyper::header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            let max_bytes = match transfer_limit() {
                Ok(limit) => limit,
                Err(error) => return hyper_response(StatusCode::SERVICE_UNAVAILABLE, error),
            };
            if expected_size.is_some_and(|size| size > max_bytes) {
                return hyper_response(StatusCode::PAYLOAD_TOO_LARGE, "too large");
            }
            static UPLOAD_BUDGET: OnceLock<UploadBudget> = OnceLock::new();
            let _reservation = match UPLOAD_BUDGET.get_or_init(UploadBudget::default).reserve(
                peer,
                expected_size.unwrap_or(max_bytes),
                Instant::now(),
            ) {
                Ok(reservation) => reservation,
                Err(error) => return hyper_response(StatusCode::TOO_MANY_REQUESTS, error),
            };
            let expected_hash = sync_core::query_param(&query, "hash");
            let (sender, receiver) = tokio::sync::mpsc::channel(2);
            #[cfg(not(unix))]
            let target = full.clone();
            #[cfg(unix)]
            let root_for_stage = root.clone();
            #[cfg(unix)]
            let rel_for_stage = rel.clone();
            let expected_hash_for_worker = expected_hash.clone();
            let worker = tokio::task::spawn_blocking(move || {
                #[cfg(unix)]
                let mut staged = sync_core::StagedFile::begin_rooted(
                    &root_for_stage,
                    &rel_for_stage,
                    max_bytes,
                    expected_size,
                    expected_hash_for_worker.as_deref(),
                )?;
                #[cfg(not(unix))]
                let mut staged = sync_core::StagedFile::begin(
                    &target,
                    max_bytes,
                    expected_size,
                    expected_hash_for_worker.as_deref(),
                )?;
                let mut reader = TransferReader {
                    receiver,
                    current: std::io::Cursor::new(Vec::new()),
                    finished: false,
                };
                let mut buffer = [0u8; TRANSFER_CHUNK_BYTES];
                loop {
                    let count = reader
                        .read(&mut buffer)
                        .map_err(sync_core::ReceiveError::Read)?;
                    if count == 0 {
                        break;
                    }
                    staged.write_chunk(&buffer[..count])?;
                }
                staged.finish()
            });
            let mut transfer_error = None;
            let mut received_bytes = 0u64;
            let admitted_bytes = expected_size.unwrap_or(max_bytes);
            let body_deadline = tokio::time::Instant::now() + transfer_timeout(admitted_bytes);
            loop {
                let Some(frame) = (match tokio::time::timeout_at(
                    body_deadline.min(tokio::time::Instant::now() + REQUEST_BODY_IDLE_TIMEOUT),
                    req.body_mut().frame(),
                )
                .await
                {
                    Ok(frame) => frame,
                    Err(_) => {
                        transfer_error = Some((
                            StatusCode::REQUEST_TIMEOUT,
                            "upload body timed out".to_string(),
                        ));
                        break;
                    }
                }) else {
                    break;
                };
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(error) => {
                        transfer_error = Some((
                            StatusCode::BAD_REQUEST,
                            format!("could not read upload body: {error}"),
                        ));
                        break;
                    }
                };
                if let Some(chunk) = frame.data_ref() {
                    if (chunk.len() as u64) > admitted_bytes.saturating_sub(received_bytes) {
                        transfer_error = Some((
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "upload exceeds admitted byte budget".to_string(),
                        ));
                        break;
                    }
                    received_bytes += chunk.len() as u64;
                    if sender
                        .send(TransferChunk::Data(chunk.to_vec()))
                        .await
                        .is_err()
                    {
                        transfer_error = Some((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "upload staging worker stopped".to_string(),
                        ));
                        break;
                    }
                }
            }
            if transfer_error.is_none() {
                let _ = sender.send(TransferChunk::End).await;
            }
            drop(sender);
            let worker_result = worker.await;
            if let Some((code, detail)) = transfer_error {
                emit_log(
                    &app,
                    "warn",
                    format!("[serve] PUT {rel} rejected — {detail}"),
                );
                return hyper_response(code, detail);
            }
            let staged = match worker_result {
                Ok(Ok(staged)) => staged,
                Ok(Err(error)) => {
                    let code = receive_error_status(&error);
                    return hyper_response(code, error.to_string());
                }
                Err(error) => {
                    return hyper_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                }
            };
            let size = staged.size;
            let commit_root = root.clone();
            let commit_rel = rel.clone();
            let commit_result = tokio::task::spawn_blocking(move || match prior {
                Some((prior_size, prior_hash)) => {
                    staged.commit_replace(&commit_root, &commit_rel, prior_size, &prior_hash)
                }
                None => staged.commit(&full),
            })
            .await;
            return match commit_result {
                Ok(Ok(outcome)) => {
                    emit_log(
                        &app,
                        "info",
                        format!("[serve] received {rel} ({size} bytes, {outcome:?})"),
                    );
                    hyper_response(StatusCode::OK, "ok")
                }
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    emit_log(
                        &app,
                        "warn",
                        format!("[serve] PUT {rel} rejected — destination has different content"),
                    );
                    hyper_response(
                        StatusCode::CONFLICT,
                        "destination exists with different content",
                    )
                }
                Ok(Err(e)) => hyper_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
                Err(e) => hyper_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
        }
        return hyper_response(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    hyper_response(StatusCode::NOT_FOUND, "not found")
}

pub(super) fn sync_server_config(id: &Identity) -> Result<Arc<rustls::ServerConfig>, String> {
    let certs = pem::parse_many(&id.cert_pem)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|block| block.tag() == "CERTIFICATE")
        .map(|block| CertificateDer::from(block.contents().to_vec()))
        .collect::<Vec<_>>();
    if certs.is_empty() {
        return Err("sync identity certificate missing".to_string());
    }
    let key = pem::parse_many(&id.key_pem)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|block| block.tag() == "PRIVATE KEY")
        .map(|block| PrivateKeyDer::from(PrivatePkcs8KeyDer::from(block.contents().to_vec())))
        .ok_or_else(|| "sync identity key missing".to_string())?;
    let provider = rustls::crypto::ring::default_provider();
    rustls::ServerConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map(Arc::new)
        .map_err(|e| e.to_string())
}

pub(super) fn ipv6_listener(
    ip: std::net::Ipv6Addr,
    port: u16,
) -> Result<std::net::TcpListener, String> {
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| format!("could not create IPv6 sync listener: {e}"))?;
    socket
        .set_only_v6(true)
        .map_err(|e| format!("could not configure IPv6 sync listener: {e}"))?;
    socket
        .bind(&SocketAddr::from((ip, port)).into())
        .map_err(|e| format!("could not bind IPv6 sync listener: {e}"))?;
    socket
        .listen(128)
        .map_err(|e| format!("could not listen on IPv6: {e}"))?;
    socket
        .set_nonblocking(true)
        .map_err(|e| format!("could not configure IPv6 sync listener: {e}"))?;
    Ok(socket.into())
}

#[tauri::command]
pub fn sync_start(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    vault: String,
    bind_address: String,
) -> Result<(), String> {
    let token = crate::secrets::resolve(&token)?;
    require_sync_key(&token)?;
    let bind_ip = listener_address(&bind_address)?;
    transfer_limit()?;
    let mut guard = state().lock().map_err(|e| e.to_string())?;
    let root = crate::vaultscope::require_approved(&app, &vault)?;
    if guard.as_ref().is_some_and(|server| {
        server.port == port
            && server.token == token
            && server.vault == root
            && server.bind_address == bind_ip
    }) {
        return Ok(());
    }
    if let Some(previous) = guard.take() {
        previous.running.store(false, Ordering::Relaxed);
        for handle in previous.handles {
            let _ = handle.join();
        }
    }
    let id = get_identity(&app)?;
    let tls_config = sync_server_config(&id)?;
    let addr = SocketAddr::new(bind_ip, port);
    let listener = match bind_ip {
        std::net::IpAddr::V6(ip) => ipv6_listener(ip, port)?,
        std::net::IpAddr::V4(_) => std::net::TcpListener::bind(addr)
            .map_err(|e| format!("could not start TLS sync server: {e}"))?,
    };
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("could not configure TLS sync server: {e}"))?;
    let running = Arc::new(AtomicBool::new(true));
    let served_root = Arc::new(root.clone());
    let served_token = Arc::new(token.clone());
    let app_for_thread = app.clone();
    let running_for_thread = running.clone();
    let handle = std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(SERVER_WORKERS)
            .thread_name("mesa-sync-server")
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                emit_log(
                    &app_for_thread,
                    "error",
                    format!("[serve] sync runtime failed: {error}"),
                );
                return;
            }
        };
        runtime.block_on(async move {
            let listener = match TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    emit_log(
                        &app_for_thread,
                        "error",
                        format!("[serve] sync listen failed: {error}"),
                    );
                    return;
                }
            };
            let acceptor = TlsAcceptor::from(tls_config);
            let connection_slots = Arc::new(tokio::sync::Semaphore::new(SERVER_CONNECTION_LIMIT));
            let auth_limiter = Arc::new(AuthLimiter::default());
            while running_for_thread.load(Ordering::Relaxed) {
                let accepted =
                    tokio::time::timeout(Duration::from_millis(250), listener.accept()).await;
                let Ok(Ok((stream, peer))) = accepted else {
                    continue;
                };
                let acceptor = acceptor.clone();
                let slot = match connection_slots.clone().try_acquire_owned() {
                    Ok(slot) => slot,
                    Err(_) => {
                        emit_log(
                            &app_for_thread,
                            "warn",
                            "[serve] connection limit reached; refused peer",
                        );
                        continue;
                    }
                };
                let root = served_root.clone();
                let token = served_token.clone();
                let app = app_for_thread.clone();
                let auth_limiter = auth_limiter.clone();
                tokio::spawn(async move {
                    let _slot = slot;
                    let tls =
                        match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream))
                            .await
                        {
                            Ok(Ok(tls)) => tls,
                            Err(_) => return,
                            Ok(Err(_)) => return,
                        };
                    let service = service_fn(move |req| {
                        let root = root.clone();
                        let token = token.clone();
                        let app = app.clone();
                        let auth_limiter = auth_limiter.clone();
                        async move {
                            Ok::<_, hyper::Error>(
                                handle_hyper(req, root, token, app, peer.ip(), auth_limiter).await,
                            )
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), service)
                        .await;
                });
            }
        });
    });
    *guard = Some(ServerState {
        running,
        handles: vec![handle],
        port,
        token,
        vault: root,
        bind_address: bind_ip,
    });
    Ok(())
}

/// Joins worker threads away from the webview event loop.
#[tauri::command]
pub async fn sync_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(stop_server)
        .await
        .map_err(|e| format!("sync_stop worker failed: {e}"))?
}

fn stop_server() -> Result<(), String> {
    let mut guard = state().lock().map_err(|e| e.to_string())?;
    if let Some(st) = guard.take() {
        st.running.store(false, Ordering::Relaxed);
        for h in st.handles {
            let _ = h.join();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn sync_status() -> bool {
    state().lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Best-effort discovery of this device's LAN IP, used to show its pairing
/// code. The UDP "connect" trick sends no packets — it just asks the OS which
/// local interface it would use to reach a public address, revealing our IP.
#[tauri::command]
pub fn sync_local_addr() -> Result<String, String> {
    local_lan_ip()
}
