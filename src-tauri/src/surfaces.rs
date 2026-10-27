//! Narrow secondary-window creation; callers cannot mint a privileged label.
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceRequest {
    label: String,
    url: String,
    title: String,
    width: f64,
    height: f64,
    min_width: Option<f64>,
    min_height: Option<f64>,
    x: Option<f64>,
    y: Option<f64>,
    dark: bool,
    overlay: bool,
    background: Option<[u8; 3]>,
}
fn validate_route(label: &str, route: &str) -> Result<url::Url, String> {
    if label.len() > 128
        || !label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || !route.starts_with("index.html?")
        || route.len() > 32 * 1024
    {
        return Err("Invalid secondary window".into());
    }
    let url = url::Url::parse("https://mesa.example/")
        .unwrap()
        .join(route)
        .map_err(|_| "Invalid secondary window route")?;
    if url.path() != "/index.html" || url.fragment().is_some() {
        return Err("Invalid secondary window route".into());
    }
    let mut fields = std::collections::HashMap::new();
    for (key, value) in url.query_pairs() {
        if !matches!(
            key.as_ref(),
            "doc"
                | "panel"
                | "research"
                | "researchLabel"
                | "vault"
                | "theme"
                | "sel"
                | "graphBootstrap"
        ) || fields
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("Invalid secondary window route".into());
        }
    }
    let doc = fields.get("doc");
    let panel = fields.get("panel");
    let research = fields.get("research");
    let valid = if label.starts_with("doc-") {
        doc.is_some_and(|rel| crate::sync_core::is_peer_rel(rel))
            && panel.is_none()
            && research.is_none()
    } else if label.starts_with("panel-") {
        panel.is_some_and(|p| matches!(p.as_str(), "graph" | "preview" | "tasks"))
            && doc.is_none()
            && research.is_none()
    } else if label.starts_with("research-") {
        research.is_some_and(|value| value == "1")
            && fields
                .get("researchLabel")
                .is_some_and(|value| value == label)
            && doc.is_none()
            && panel.is_none()
    } else {
        false
    };
    if !valid {
        return Err("Invalid secondary window route".into());
    }
    Ok(url)
}
#[tauri::command(async)]
pub fn workspace_open_surface(
    app: tauri::AppHandle,
    request: SurfaceRequest,
) -> Result<(), String> {
    let url = validate_route(&request.label, &request.url)?;
    let root = url
        .query_pairs()
        .find(|(key, _)| key == "vault")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    if !root.is_empty() && root != "mesa://demo" {
        crate::vaultscope::require_approved(&app, &root)?;
    }
    for size in [
        Some(request.width),
        Some(request.height),
        request.min_width,
        request.min_height,
    ]
    .into_iter()
    .flatten()
    {
        if !size.is_finite() || !(200.0..=8192.0).contains(&size) {
            return Err("Invalid secondary window size".into());
        }
    }
    for position in [request.x, request.y].into_iter().flatten() {
        if !position.is_finite() || position.abs() > 100_000.0 {
            return Err("Invalid secondary window position".into());
        }
    }
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &request.label,
        tauri::WebviewUrl::App(request.url.into()),
    )
    .title(
        request
            .title
            .chars()
            .filter(|ch| !ch.is_control())
            .take(128)
            .collect::<String>(),
    )
    .inner_size(request.width, request.height)
    .resizable(true)
    .decorations(true)
    .visible(true);
    if let (Some(width), Some(height)) = (request.min_width, request.min_height) {
        builder = builder.min_inner_size(width, height);
    }
    if let (Some(x), Some(y)) = (request.x, request.y) {
        builder = builder.position(x, y);
    }
    if request.dark {
        builder = builder.theme(Some(tauri::Theme::Dark));
    }
    if let Some([red, green, blue]) = request.background {
        builder = builder.background_color(tauri::utils::config::Color(red, green, blue, 255));
    }
    #[cfg(target_os = "macos")]
    if request.overlay {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = request.overlay;
    builder
        .build()
        .map_err(|_| "Cannot open secondary window")?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_document_panel_and_read_only_research_routes_can_be_created() {
        assert!(validate_route("doc-one", "index.html?doc=note.md&vault=synthetic").is_ok());
        assert!(validate_route("panel-one", "index.html?panel=graph&vault=synthetic").is_ok());
        assert!(validate_route(
            "research-one",
            "index.html?research=1&researchLabel=research-one"
        )
        .is_ok());
        for (label, route) in [
            ("main", "index.html?doc=note.md"),
            ("agent-one", "index.html?doc=note.md"),
            ("doc-one", "index.html?doc=note.md&agent=1"),
            ("doc-one", "index.html?doc=../outside.md"),
            ("doc-one", "https://example.com/?doc=note.md"),
            ("doc-one", "index.html?doc=note.md&doc=second.md"),
            ("panel-one", "index.html?panel=agent"),
            ("research-one", "index.html?research=1&researchLabel=main"),
        ] {
            assert!(validate_route(label, route).is_err(), "{label}: {route}");
        }
    }
}
