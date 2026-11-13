use super::*;

/// Idle workers block instead of polling, so a stop must wake them at
/// once, and a request that arrives first is still served.
#[test]
fn idle_workers_serve_a_request_and_exit_at_once_on_stop() {
    let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
    let port = server.server_addr().to_ip().unwrap().port();
    let running = Arc::new(AtomicBool::new(true));
    let handles: Vec<_> = (0..ACTIVITY_SERVER_WORKERS)
        .map(|_| {
            let server = server.clone();
            let running = running.clone();
            std::thread::spawn(move || {
                serve_until_stopped(&server, &running, |req| {
                    let _ = req.respond(Response::from_string("ok"));
                });
            })
        })
        .collect();

    use std::io::{Read, Write};
    let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    client
        .write_all(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut reply = String::new();
    client.read_to_string(&mut reply).unwrap();
    assert!(reply.ends_with("ok"), "{reply}");

    let started = std::time::Instant::now();
    stop_workers(&server, &running, handles.len());
    assert!(join_within(handles, Duration::from_secs(5)));
    assert!(
        started.elapsed() < Duration::from_millis(100),
        "workers waited for a poll interval: {:?}",
        started.elapsed()
    );
}

#[test]
fn stop_does_not_wait_for_a_worker_held_by_a_slow_client() {
    let quick = vec![std::thread::spawn(|| {})];
    assert!(join_within(quick, Duration::from_secs(5)));
    let stuck = vec![std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(3))
    })];
    let started = std::time::Instant::now();
    assert!(!join_within(stuck, Duration::from_millis(100)));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn stale_extensions_from_exited_process_are_removed() {
    #[cfg(unix)]
    let mut child = std::process::Command::new("sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    #[cfg(windows)]
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "exit 0"])
        .spawn()
        .unwrap();
    #[cfg(any(unix, windows))]
    {
        let pid = child.id();
        child.wait().unwrap();
        assert!(!process_alive(pid));
        let temp = std::env::temp_dir().join(format!(
            "mesa-exited-test-{}-{}",
            std::process::id(),
            nanos()
        ));
        create_extension_dir(&temp).unwrap();
        let stale = temp.join(format!("mesa-pi-{pid}-1"));
        create_extension_dir(&stale).unwrap();
        sweep_extensions_in(&temp, nanos(), process_alive).unwrap();
        assert!(!stale.exists());
        std::fs::remove_dir(temp).unwrap();
    }
}

#[test]
fn sweeps_only_old_dead_process_directories() {
    let temp = std::env::temp_dir().join(format!(
        "mesa-sweep-test-{}-{}",
        std::process::id(),
        nanos()
    ));
    std::fs::create_dir(&temp).unwrap();
    let now = 120_000_000_000_u128;
    for name in [
        "mesa-pi-123-1",
        "mesa-pi-124-119000000000",
        "mesa-pi-125-1",
        "mesa-pi-0-1",
        "mesa-pi-invalid-1",
        "other",
    ] {
        create_extension_dir(&temp.join(name)).unwrap();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(temp.join("mesa-pi-123-1"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        std::os::unix::fs::symlink(temp.join("other"), temp.join("mesa-pi-126-1")).unwrap();
    }
    sweep_extensions_in(&temp, now, |pid| pid == 125).unwrap();
    assert!(!temp.join("mesa-pi-123-1").exists());
    for name in [
        "mesa-pi-124-119000000000",
        "mesa-pi-125-1",
        "mesa-pi-0-1",
        "mesa-pi-invalid-1",
        "other",
    ] {
        assert!(temp.join(name).exists());
    }
    #[cfg(unix)]
    assert!(temp.join("mesa-pi-126-1").is_symlink());
    sweep_extensions_in(&temp, now + Duration::from_secs(60).as_nanos(), |pid| {
        pid == 125
    })
    .unwrap();
    assert!(!temp.join("mesa-pi-124-119000000000").exists());
    assert!(temp.join("mesa-pi-125-1").exists());
    assert!(process_alive(std::process::id()));
    std::fs::remove_dir_all(temp).unwrap();
}

#[test]
fn bounded_activity_and_browse_bodies_reject_oversize_payloads() {
    let mut body = std::io::Cursor::new(b"hello".to_vec());
    assert!(matches!(
        read_bounded_utf8(&mut body, Some(5), 4),
        Err(BodyError::TooLarge)
    ));
    let mut body = std::io::Cursor::new(b"hello".to_vec());
    assert!(matches!(
        read_bounded_utf8(&mut body, None, 4),
        Err(BodyError::TooLarge)
    ));
    let mut body = std::io::Cursor::new(b"hello".to_vec());
    assert_eq!(read_bounded_utf8(&mut body, None, 5).unwrap(), "hello");
    assert_eq!(body_error_status(BodyError::TooLarge), 413);
}

#[test]
fn research_bridge_rejects_declared_oversize_and_invalid_utf8_bodies() {
    use std::io::Write;
    let server = Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap();
    let status = |head: String, body: &[u8]| {
        let mut client = std::net::TcpStream::connect(addr).unwrap();
        client.write_all(head.as_bytes()).unwrap();
        client.write_all(body).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let mut req = server
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        read_research_body(&mut req).err()
    };
    let declared = ACTIVITY_BODY_CAP + 1;
    assert_eq!(
        status(
            format!("POST /deep-research HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {declared}\r\n\r\n"),
            b"{}",
        ),
        Some(413)
    );
    assert_eq!(
        status(
            "POST /deep-research HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n".into(),
            &[0xff, 0xfe],
        ),
        Some(400)
    );
}

#[test]
fn occupied_activity_port_is_rejected_before_extension_setup() {
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = occupied.local_addr().unwrap().port();
    assert!(bind_activity_server(port, port).is_err());
}

#[test]
fn bridge_tokens_are_fresh_256_bit_values() {
    let first = crate::hex::random_token().unwrap();
    let second = crate::hex::random_token().unwrap();
    assert_eq!(first.len(), 64);
    assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(first, second);
    for route in ["/browse", "/context", "/deep-research"] {
        assert!(
            !crate::bearer::matches(&format!("Bearer {second}"), &first),
            "{route}"
        );
    }
}

#[test]
fn bridge_rejects_dns_rebound_hostnames() {
    assert!(loopback_host_allowed("127.0.0.1:8788", 8788));
    assert!(loopback_host_allowed("localhost:8788", 8788));
    assert!(!loopback_host_allowed("evil.example:8788", 8788));
    assert!(!loopback_host_allowed("127.0.0.1:8789", 8788));
    assert!(!loopback_host_allowed("127.0.0.1", 8788));
}

#[test]
fn research_decisions_are_correlated_and_single_admission() {
    let replies = ResearchReplies::default();
    let wait = replies.begin("run".into(), "call".into()).unwrap();
    assert!(replies.begin("other".into(), "call".into()).is_err());
    let reply = ResearchReply {
        status: ResearchDecision::Rejected,
        message: "missing Findings".into(),
    };
    assert!(replies.respond("old-run", "call", reply.clone()).is_err());
    assert!(replies.respond("run", "old-call", reply.clone()).is_err());
    replies.respond("run", "call", reply.clone()).unwrap();
    assert!(replies.respond("run", "call", reply).is_err());
    let result = wait
        .wait(&AtomicBool::new(true), Duration::from_millis(100))
        .unwrap();
    assert_eq!(serde_json::to_value(result).unwrap()["status"], "rejected");
    assert!(replies
        .respond(
            "run",
            "call",
            ResearchReply {
                status: ResearchDecision::Accepted,
                message: "late duplicate".into(),
            }
        )
        .is_err());
    drop(wait);
    assert!(replies.begin("next".into(), "next-call".into()).is_ok());
}

#[test]
fn research_wait_shutdown_and_timeout_release_the_slot() {
    let replies = ResearchReplies::default();
    let wait = replies.begin("run".into(), "call".into()).unwrap();
    assert!(wait
        .wait(&AtomicBool::new(false), Duration::from_secs(30))
        .is_err());
    drop(wait);
    let wait = replies.begin("next".into(), "next-call".into()).unwrap();
    assert!(wait.wait(&AtomicBool::new(true), Duration::ZERO).is_err());
    drop(wait);
    let reply = ResearchReply {
        status: ResearchDecision::Accepted,
        message: "ready".into(),
    };
    assert!(replies.respond("next", "next-call", reply).is_err());
    assert!(replies.begin("last".into(), "last-call".into()).is_ok());
}

fn view_headers(id: &str, meta: &str, mime: &str) -> tauri::http::HeaderMap {
    let mut map = tauri::http::HeaderMap::new();
    map.insert("x-mesa-view-request", id.parse().unwrap());
    map.insert("x-mesa-view-meta", meta.parse().unwrap());
    map.insert("x-mesa-view-mime", mime.parse().unwrap());
    map
}

#[test]
fn view_replies_require_a_typed_bounded_capture() {
    let image = tauri::ipc::InvokeBody::Raw(vec![0xff, 0xd8, 0xff]);
    let empty = tauri::ipc::InvokeBody::Raw(Vec::new());
    let (id, reply) =
        parse_view_reply(&view_headers("id", "%7B%7D", "image/jpeg"), &image).unwrap();
    assert_eq!((id.as_str(), reply.bytes.len()), ("id", 3));
    assert!(parse_view_reply(&view_headers("id", "%7B%7D", "none"), &empty).is_ok());
    assert!(parse_view_reply(&view_headers("id", "%7B%7D", "none"), &image).is_err());
    assert!(parse_view_reply(&view_headers("id", "%7B%7D", "image/jpeg"), &empty).is_err());
    assert!(parse_view_reply(&view_headers("id", "%7B%7D", "text/html"), &image).is_err());
    assert!(parse_view_reply(&view_headers("id", "{ }", "image/jpeg"), &image).is_err());
    let oversized = tauri::ipc::InvokeBody::Raw(vec![0; VIEW_IMAGE_CAP + 1]);
    assert!(parse_view_reply(&view_headers("id", "%7B%7D", "image/png"), &oversized).is_err());
}

#[test]
fn view_captures_are_correlated_single_admission_and_released() {
    let replies = ViewReplies::default();
    let reply = || ViewReply {
        meta: "%7B%7D".into(),
        mime: "none".into(),
        bytes: Vec::new(),
    };
    let wait = replies.begin("first".into()).unwrap();
    assert!(replies.begin("second".into()).is_err());
    assert!(replies.respond("stale", reply()).is_err());
    replies.respond("first", reply()).unwrap();
    assert!(replies.respond("first", reply()).is_err());
    assert!(wait
        .wait(&AtomicBool::new(true), Duration::from_millis(100))
        .is_some());
    drop(wait);
    let wait = replies.begin("next".into()).unwrap();
    assert!(wait.wait(&AtomicBool::new(false), VIEW_WAIT).is_none());
    drop(wait);
    assert!(replies.respond("next", reply()).is_err());
    assert!(replies.begin("last".into()).is_ok());
}

#[test]
fn live_context_is_trimmed_and_bounded_on_utf8_boundaries() {
    assert_eq!(bounded_context("  active.md  ".into()), "active.md");
    let oversized = "é".repeat(CONTEXT_MAX_BYTES);
    let bounded = bounded_context(oversized);
    assert!(bounded.len() <= CONTEXT_MAX_BYTES);
    assert!(bounded.is_char_boundary(bounded.len()));
    assert!(bounded.ends_with('é'));
}

#[test]
fn browse_admission_is_single_and_reusable() {
    let active = AtomicBool::new(false);
    let first = BrowsePermit::try_acquire(&active).expect("first browse must be admitted");
    assert!(BrowsePermit::try_acquire(&active).is_none());
    drop(first);
    assert!(BrowsePermit::try_acquire(&active).is_some());
}

#[test]
fn pending_fallback_stops_with_the_server() {
    let running = Arc::new(AtomicBool::new(true));
    let stop = running.clone();
    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(0);
    let stopper = std::thread::spawn(move || {
        started_rx.recv().unwrap();
        stop.store(false, Ordering::Release);
    });
    let result = blocking_while_running(&running, "test-pending-fallback", move || {
        started_tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(250));
        "late result"
    });
    stopper.join().unwrap();
    assert_eq!(result.unwrap(), None);
}
