#[test]
fn saved_html_opens_by_its_plain_path() {
    assert_eq!(
        super::opener_path(std::path::Path::new("/Data/me/Vault/page.html")),
        "/Data/me/Vault/page.html"
    );
    #[cfg(windows)]
    {
        assert_eq!(
            super::opener_path(std::path::Path::new(r"\\?\C:\Vault\page.html")),
            r"C:\Vault\page.html"
        );
        assert_eq!(
            super::opener_path(std::path::Path::new(r"\\?\UNC\nas\share\page.html")),
            r"\\nas\share\page.html"
        );
    }
}

#[test]
fn saved_html_opening_is_limited_to_document_surfaces() {
    for label in ["main", "doc-1", "panel-graph"] {
        assert!(crate::require_document_surface(label).is_ok(), "{label}");
    }
    for label in ["agent-x", "research-1", "graph", ""] {
        assert!(crate::require_document_surface(label).is_err(), "{label}");
    }
}

#[tokio::test]
async fn connection_error_classification_preserves_dns_rejection() {
    let error = super::client_for_agent(false)
        .unwrap()
        .get("http://localhost:1")
        .send()
        .await
        .unwrap_err();
    assert_eq!(
        super::fetch_error(error),
        "private network address is blocked"
    );
}

#[tokio::test]
async fn connection_failure_explains_direct_only_browsing() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let error = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{address}"))
        .send()
        .await
        .unwrap_err();
    let message = super::fetch_error(error);
    assert!(message.contains("Direct connection failed"));
    assert!(message.contains("does not use system proxies"));
    assert!(!message.contains(&address.to_string()));
}

use super::*;

#[test]
fn rejects_local_and_private_page_addresses() {
    for url in [
        "http://localhost/".to_string(),
        "https://notes.localhost/".to_string(),
        "http://127.0.0.1/".to_string(),
        "http://0177.0.0.1/".to_string(),
        format!("http://{}/", std::net::Ipv4Addr::new(10, 2, 3, 4)),
        "http://169.254.169.254/".to_string(),
        format!("http://{}/", std::net::Ipv4Addr::new(172, 19, 1, 2)),
        format!("http://{}/", std::net::Ipv4Addr::new(192, 168, 1, 1)),
        format!("http://{}/", std::net::Ipv4Addr::new(100, 100, 100, 100)),
        "http://[::1]/".to_string(),
        "http://[fc00::1]/".to_string(),
        "http://[::ffff:127.0.0.1]/".to_string(),
        "file:///etc/passwd".to_string(),
    ] {
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert!(public_url(&parsed).is_err(), "{url}");
    }
}

#[tokio::test]
async fn final_connection_resolver_rejects_local_dns_answers() {
    use std::str::FromStr;
    let result = PublicResolver
        .resolve(Name::from_str("localhost").unwrap())
        .await;
    assert!(result.is_err());
}

#[test]
fn allows_public_page_addresses() {
    for url in [
        "https://example.com/",
        "http://8.8.8.8/",
        "https://[2606:4700:4700::1111]/",
    ] {
        let parsed = reqwest::Url::parse(url).unwrap();
        assert!(public_url(&parsed).is_ok(), "{url}");
    }
    for url in [
        "http://192.1.1.1/",
        "http://192.0.1.1/",
        "http://192.0.3.1/",
    ] {
        let parsed = reqwest::Url::parse(url).unwrap();
        assert!(public_url(&parsed).is_ok(), "{url}");
    }
}

#[test]
fn rejects_only_special_purpose_192_0_subnets() {
    for url in ["http://192.0.0.1/", "http://192.0.2.1/"] {
        let parsed = reqwest::Url::parse(url).unwrap();
        assert!(public_url(&parsed).is_err(), "{url}");
    }
}

#[test]
fn decodes_the_declared_page_charset() {
    assert_eq!(
        decode_page_body(b"caf\xe9", "text/html; charset=windows-1252"),
        "café"
    );
    assert_eq!(decode_page_body("café".as_bytes(), "text/html"), "café");
}

#[test]
fn charset_prescan_obeys_headers_comments_and_scan_limit() {
    assert_eq!(
        decode_page_body(b"<meta charset='windows-1252'>caf\xe9", "text/html"),
        "<meta charset='windows-1252'>café"
    );
    let (bytes, _, _) = encoding_rs::SHIFT_JIS
        .encode("<meta http-equiv='content-type' content='text/html; charset=Shift_JIS'>日本語");
    assert!(decode_page_body(&bytes, "text/html").ends_with("日本語"));
    assert!(meta_charset(b"<!-- <meta charset=shift_jis> -->").is_none());
    assert!(
        meta_charset(format!("{}<meta charset=shift_jis>", " ".repeat(1024)).as_bytes()).is_none()
    );
    assert!(decode_page_body(
        "<meta charset=windows-1252>café".as_bytes(),
        "text/html; charset=utf-8"
    )
    .ends_with("café"));
}
#[tokio::test]
async fn resources_enforce_response_types_and_complete_byte_limits() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let base = format!("http://resource.example.com:{}/", address.port());
    let worker = std::thread::spawn(move || {
        for (mime, bytes) in [
            ("text/plain", b"p{color:teal}".to_vec()),
            (
                "application/octet-stream",
                b"<script>bad()</script>".to_vec(),
            ),
            ("image/png", vec![0; RESOURCE_LIMIT + 1]),
            ("application/octet-stream", b"wOF2fixture".to_vec()),
            (
                "text/css; charset=windows-1252",
                b".caf\xe9::before{content:'caf\xe9'}".to_vec(),
            ),
        ] {
            let request = server.recv().unwrap();
            let mut redirect = tiny_http::Response::empty(302);
            redirect.add_header(tiny_http::Header::from_bytes("Location", "/style.css").unwrap());
            redirect.add_header(
                tiny_http::Header::from_bytes("Set-Cookie", "redirect_cookie=private").unwrap(),
            );
            request.respond(redirect).unwrap();
            let request = server.recv().unwrap();
            assert_eq!(request.url(), "/style.css");
            let mut response = tiny_http::Response::from_data(bytes);
            response.add_header(tiny_http::Header::from_bytes("Content-Type", mime).unwrap());
            response.add_header(
                tiny_http::Header::from_bytes("Set-Cookie", "should_not_persist=yes").unwrap(),
            );
            assert!(!request
                .headers()
                .iter()
                .any(|h| h.field.equiv("Cookie") || h.field.equiv("Referer")));
            let _ = request.respond(response);
        }
    });
    let token = create_resource_token("resource-response-test").unwrap();
    // Override only the fixture hostname on the real production client builder.
    let client = resource_client_builder()
        .resolve("resource.example.com", address)
        .build()
        .unwrap();
    let response = client.get(&base).send().await.unwrap();
    assert_eq!(
        read_resource_response("resource-response-test", &token, response, true)
            .await
            .unwrap()
            .0,
        b"p{color:teal}"
    );
    let response = client.get(&base).send().await.unwrap();
    assert!(
        read_resource_response("resource-response-test", &token, response, false)
            .await
            .is_err()
    );
    let response = client.get(&base).send().await.unwrap();
    assert!(
        read_resource_response("resource-response-test", &token, response, false)
            .await
            .is_err()
    );
    let response = client.get(&base).send().await.unwrap();
    let resource = read_resource_response("resource-response-test", &token, response, false)
        .await
        .unwrap();
    assert_eq!(resource.1, "font/woff2");
    assert_eq!(resource.0, b"wOF2fixture");
    let response = client.get(&base).send().await.unwrap();
    let (body, content_type, _) =
        read_resource_response("resource-response-test", &token, response, true)
            .await
            .unwrap();
    assert_eq!(
        decode_page_body(&body, &content_type),
        ".café::before{content:'café'}"
    );
    worker.join().unwrap();
    revoke_resource_window("resource-response-test");
}

#[test]
fn resources_reject_invalid_tokens_owners_expiry_and_budget() {
    assert!(charge_resource("resource-budget-test", "unknown", 0, true).is_err());
    let token = create_resource_token("resource-budget-test").unwrap();
    assert!(charge_resource("doc-test", &token, 0, true).is_err());
    assert!(charge_resource("resource-budget-test", &token, VIEW_LIMIT + 1, false).is_err());
    for _ in 0..400 {
        charge_resource("resource-budget-test", &token, 0, true).unwrap();
    }
    assert!(charge_resource("resource-budget-test", &token, 0, true).is_err());
    let created = resource_tokens()
        .lock()
        .unwrap()
        .get(&token)
        .unwrap()
        .created;
    let expires_at = created + std::time::Duration::from_secs(600);
    assert!(charge_resource_at("resource-budget-test", &token, 0, false, expires_at).is_ok());
    let expired_at = created + std::time::Duration::from_secs(601);
    assert!(charge_resource_at("resource-budget-test", &token, 0, false, expired_at).is_err());
    revoke_resource_window("resource-budget-test");
    assert!(charge_resource("resource-budget-test", &token, 0, false).is_err());
}
#[tokio::test]
async fn resources_reject_private_addresses_and_non_get() {
    let token = create_resource_token("main").unwrap();
    assert!(
        fetch_resource("main", &token, "http://localhost/x.png", false)
            .await
            .is_err()
    );
    assert!(
        fetch_resource("main", &token, "http://127.0.0.1/x.css", true)
            .await
            .is_err()
    );
    let response = serve_subresource(
        "main",
        tauri::http::Request::builder()
            .uri("mesa-web://localhost/unknown?u=https%3A%2F%2Fexample.com")
            .body(Vec::new())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), 403);
    assert!(response.body().is_empty());
    let response = serve_subresource(
        "main",
        tauri::http::Request::builder()
            .method("POST")
            .uri("mesa-web://localhost/unknown")
            .body(Vec::new())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), 405);
    assert!(!allowed_resource_type("text/html"));
    assert!(!allowed_resource_type("application/javascript"));
    assert!(allowed_resource_type("font/woff2"));
    assert!(allowed_resource_type("image/svg+xml"));
    resource_tokens().lock().unwrap().remove(&token);
}

#[tokio::test]
async fn agent_fetch_does_not_receive_user_fetch_cookies() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr());
    let worker = std::thread::spawn(move || {
        for _ in 0..3 {
            let request = server.recv().unwrap();
            let cookie = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Cookie"))
                .map(|header| header.value.as_str().to_string())
                .unwrap_or_default();
            let mut response = tiny_http::Response::from_string(cookie);
            if request.url() == "/set" {
                response.add_header(
                    tiny_http::Header::from_bytes("Set-Cookie", "mesa_user=private; Path=/")
                        .unwrap(),
                );
            }
            request.respond(response).unwrap();
        }
    });
    client_for_agent(false)
        .unwrap()
        .get(format!("{base}/set"))
        .send()
        .await
        .unwrap();
    let agent = client_for_agent(true)
        .unwrap()
        .get(format!("{base}/echo"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let user = client_for_agent(false)
        .unwrap()
        .get(format!("{base}/echo"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    worker.join().unwrap();
    assert!(agent.is_empty());
    assert!(user.contains("mesa_user=private"));
}

#[tokio::test]
async fn bounded_page_read_reports_truncation() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}", server.server_addr());
    let worker = std::thread::spawn(move || {
        let request = server.recv().unwrap();
        request
            .respond(tiny_http::Response::from_data(vec![
                b'x';
                MAX_BODY_BYTES + 1
            ]))
            .unwrap();
    });
    let mut response = client_for_agent(false)
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap();
    let (body, truncated) = read_text_body(&mut response, "text/plain").await.unwrap();
    worker.join().unwrap();
    assert_eq!(body.len(), MAX_BODY_BYTES);
    assert!(truncated);
}
