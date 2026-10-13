use tauri::regex::Regex;
use tauri::utils::config::WindowConfig;
use tauri::{App, Manager, ShellScope, Window, WindowBuilder, WindowUrl};

/// The origin served by the embedded host server (`server::start_embedded_server`).
const LOCAL_HOST: &str = "127.0.0.1";
const LOCAL_PORT: u16 = 8502;

/// Validation regex used by `tauri::api::shell::open` for the `shell > open` allowlist.
/// Mirrors the default applied by tauri-codegen when `allowlist.shell.open` is `true`.
fn external_open_regex() -> Regex {
    Regex::new(r"^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+").expect("static regex is valid")
}

/// The action the navigation policy takes for a requested URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationAction {
    /// Let the webview navigate (the embedded app origin).
    Allow,
    /// Hand the URL to the system default browser and keep it out of the webview.
    External,
    /// Refuse the navigation entirely.
    Deny,
}

/// Pure navigation policy: decides what to do with `url` without performing side effects.
pub fn decide_navigation(url: &tauri::Url) -> NavigationAction {
    let is_local_origin = url.scheme() == "http"
        && url.host_str() == Some(LOCAL_HOST)
        && url.port() == Some(LOCAL_PORT)
        && url.username().is_empty()
        && url.password().is_none();

    if is_local_origin {
        return NavigationAction::Allow;
    }

    // Deny file URIs and other local schemes.
    if url.scheme() == "file" || url.as_str().starts_with("file://") {
        return NavigationAction::Deny;
    }

    // Delegate external http/https to the system browser. This intentionally covers every
    // non-local http(s) URL (other ports, `localhost` aliases, userinfo URLs), matching the
    // original policy: only the exact `127.0.0.1:8502` origin is trusted in the webview.
    if url.scheme() == "http" || url.scheme() == "https" {
        return NavigationAction::External;
    }

    NavigationAction::Deny
}

/// Creates the single application window and installs the navigation security policy on it.
///
/// The window is built from the `tauri.conf.json` window configuration so geometry and title
/// stay config-driven, with the startup URL forced to the embedded host origin.
pub fn build_secured_window(
    app: &mut App,
    mut config: WindowConfig,
) -> Result<Window, Box<dyn std::error::Error>> {
    config.url = WindowUrl::App("index.html".into());

    let shell_scope: ShellScope = app.shell_scope();

    let window = WindowBuilder::from_config(app, config)
        .on_navigation(move |url| match decide_navigation(&url) {
            NavigationAction::Allow => true,
            NavigationAction::External => {
                let _ = tauri::api::shell::open(&shell_scope, url.as_str(), None);
                false
            }
            NavigationAction::Deny => false,
        })
        .build()?;

    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        tauri::Url::parse(s).expect("test URL parses")
    }

    #[test]
    fn allows_embedded_app_origin() {
        assert_eq!(
            decide_navigation(&url("http://127.0.0.1:8502/dashboard")),
            NavigationAction::Allow
        );
    }

    #[test]
    fn allows_embedded_app_root() {
        assert_eq!(
            decide_navigation(&url("http://127.0.0.1:8502")),
            NavigationAction::Allow
        );
    }

    #[test]
    fn delegates_external_https_to_browser() {
        assert_eq!(
            decide_navigation(&url("https://github.com/office-equity/open-notebook")),
            NavigationAction::External
        );
    }

    #[test]
    fn delegates_external_http_to_browser() {
        assert_eq!(
            decide_navigation(&url("http://example.com/docs")),
            NavigationAction::External
        );
    }

    #[test]
    fn denies_file_uri() {
        assert_eq!(
            decide_navigation(&url("file:///C:/Windows/System32/cmd.exe")),
            NavigationAction::Deny
        );
    }

    #[test]
    fn denies_file_scheme_without_authority() {
        assert_eq!(decide_navigation(&url("file://")), NavigationAction::Deny);
    }

    #[test]
    fn local_origin_with_userinfo_is_not_trusted_and_goes_external() {
        assert_eq!(
            decide_navigation(&url("http://user:pass@127.0.0.1:8502/")),
            NavigationAction::External
        );
    }

    #[test]
    fn other_local_port_is_not_trusted_and_goes_external() {
        assert_eq!(
            decide_navigation(&url("http://127.0.0.1:8000/")),
            NavigationAction::External
        );
    }

    #[test]
    fn loopback_hostname_alias_is_not_trusted_and_goes_external() {
        assert_eq!(
            decide_navigation(&url("http://localhost:8502/")),
            NavigationAction::External
        );
    }

    #[test]
    fn denies_non_web_schemes() {
        assert_eq!(
            decide_navigation(&url("javascript:alert(1)")),
            NavigationAction::Deny
        );
        assert_eq!(
            decide_navigation(&url("data:text/html,<script>alert(1)</script>")),
            NavigationAction::Deny
        );
    }

    #[test]
    fn external_open_regex_matches_http_urls_and_rejects_flag_like_values() {
        let regex = external_open_regex();
        assert!(regex.is_match("https://github.com/office-equity/open-notebook"));
        assert!(!regex.is_match("/R"));
        assert!(!regex.is_match("--enable-debugging"));
    }
}
