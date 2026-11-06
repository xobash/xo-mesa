//! WebView2 settings that Tauri does not expose, applied to every Mesa webview
//! (main, document, panel, Pi, Research and tray windows) as it is created.
//!
//! WebView2 enables browser accelerator keys (Ctrl+S Save page as, Ctrl+P
//! Print, Ctrl+R / F5 Reload, F7 caret browsing) and a browser context menu
//! (Back, Reload, Save as, Print, Inspect). A reload drops edits still inside
//! the autosave debounce. The accelerator keys are turned off; the context
//! menu keeps only its text-editing items so right-click Cut / Copy / Paste
//! still works in the editor and text fields. Mesa's own menus (file tree)
//! are DOM menus and are not affected. `src/lib/browserKeyGuard.ts` is the
//! renderer-side second layer for the keys.

/// Built-in context-menu items (`ICoreWebView2ContextMenuItem::Name`) that
/// only edit or copy. Everything else navigates, saves, prints, shares or
/// opens developer tools.
#[cfg_attr(not(windows), allow(dead_code))]
const EDITING_ITEMS: &[&str] = &[
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "pasteAndMatchStyle",
    "selectAll",
    "emoji",
    "copyLinkLocation",
    "copyImage",
];

/// One entry of the default context menu: `None` for a separator.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) type MenuEntry<'a> = Option<&'a str>;

/// Indices to remove from the default context menu, highest first, so that
/// removing them in order keeps the remaining indices valid. Separators stay
/// only between two kept items, never doubled, leading or trailing.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn context_menu_removals(entries: &[MenuEntry<'_>]) -> Vec<usize> {
    let mut keep = vec![false; entries.len()];
    let mut pending_separator = None;
    let mut kept_item = false;
    for (index, entry) in entries.iter().enumerate() {
        match entry {
            None => {
                if kept_item && pending_separator.is_none() {
                    pending_separator = Some(index);
                }
            }
            Some(name) if EDITING_ITEMS.contains(name) => {
                if let Some(separator) = pending_separator.take() {
                    keep[separator] = true;
                }
                keep[index] = true;
                kept_item = true;
            }
            Some(_) => {}
        }
    }
    (0..entries.len()).rev().filter(|&i| !keep[i]).collect()
}

#[cfg(windows)]
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("mesa-webview-settings")
        .on_webview_ready(|webview| {
            let label = webview.label().to_string();
            let applied = webview.with_webview(move |platform| {
                // SAFETY: the controller belongs to this live webview and the
                // closure runs on its UI thread.
                if let Err(err) = unsafe { native::apply(&platform.controller()) } {
                    eprintln!("Mesa could not apply WebView2 settings to {label}: {err}");
                }
            });
            if let Err(err) = applied {
                eprintln!("Mesa could not reach a new webview for its settings: {err}");
            }
        })
        .build()
}

#[cfg(windows)]
mod native {
    use super::{context_menu_removals, MenuEntry};
    use webview2_com::{
        take_pwstr, ContextMenuRequestedEventHandler, Microsoft::Web::WebView2::Win32::*,
    };
    use windows_core::{Interface, PWSTR};

    /// # Safety
    /// Call on the webview's UI thread with its live controller.
    pub(super) unsafe fn apply(controller: &ICoreWebView2Controller) -> windows_core::Result<()> {
        let webview = controller.CoreWebView2()?;
        let settings = webview.Settings()?;
        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            settings3.SetAreBrowserAcceleratorKeysEnabled(false)?;
        }
        // Filtering needs ICoreWebView2_11; an older runtime gets no browser
        // menu at all rather than the full one.
        let Ok(webview11) = webview.cast::<ICoreWebView2_11>() else {
            return settings.SetAreDefaultContextMenusEnabled(false);
        };
        let mut token = 0i64;
        webview11.add_ContextMenuRequested(
            &ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                filter(&args.MenuItems()?)?;
                // An empty menu would open as a blank box.
                let mut remaining = 0u32;
                args.MenuItems()?.Count(&mut remaining)?;
                if remaining == 0 {
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            &mut token,
        )
    }

    unsafe fn filter(items: &ICoreWebView2ContextMenuItemCollection) -> windows_core::Result<()> {
        let mut count = 0u32;
        items.Count(&mut count)?;
        let mut names = Vec::with_capacity(count as usize);
        for index in 0..count {
            let item = items.GetValueAtIndex(index)?;
            let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
            item.Kind(&mut kind)?;
            if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR {
                names.push(None);
            } else {
                let mut name = PWSTR::null();
                item.Name(&mut name)?;
                names.push(Some(take_pwstr(name)));
            }
        }
        let entries: Vec<MenuEntry<'_>> = names.iter().map(|name| name.as_deref()).collect();
        for index in context_menu_removals(&entries) {
            items.RemoveValueAtIndex(index as u32)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kept<'a>(entries: &[MenuEntry<'a>]) -> Vec<MenuEntry<'a>> {
        let removed = context_menu_removals(entries);
        assert!(removed.windows(2).all(|pair| pair[0] > pair[1]));
        (0..entries.len())
            .filter(|index| !removed.contains(index))
            .map(|index| entries[index])
            .collect()
    }

    #[test]
    fn page_menu_loses_every_browser_action() {
        // WebView2's menu on an empty part of a page.
        let page = [
            Some("back"),
            Some("forward"),
            Some("reload"),
            None,
            Some("saveAs"),
            Some("print"),
            None,
            Some("inspectElement"),
        ];
        assert_eq!(kept(&page), Vec::<MenuEntry>::new());
    }

    #[test]
    fn editor_menu_keeps_text_editing_without_stray_separators() {
        let editor = [
            Some("emoji"),
            None,
            Some("undo"),
            Some("redo"),
            None,
            Some("cut"),
            Some("copy"),
            Some("paste"),
            Some("pasteAndMatchStyle"),
            Some("selectAll"),
            None,
            Some("webCapture"),
            None,
            Some("inspectElement"),
        ];
        assert_eq!(
            kept(&editor),
            vec![
                Some("emoji"),
                None,
                Some("undo"),
                Some("redo"),
                None,
                Some("cut"),
                Some("copy"),
                Some("paste"),
                Some("pasteAndMatchStyle"),
                Some("selectAll"),
            ]
        );
    }

    #[test]
    fn link_and_selection_menus_keep_only_copy_items() {
        let link = [
            Some("openLinkInNewWindow"),
            Some("saveLinkAs"),
            Some("copyLinkLocation"),
            None,
            Some("copy"),
            None,
            Some("share"),
            Some("print"),
        ];
        assert_eq!(
            kept(&link),
            vec![Some("copyLinkLocation"), None, Some("copy")]
        );
    }
}
