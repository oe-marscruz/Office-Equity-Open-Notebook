//! Route resolution for the Next.js static export served by the native host.
//!
//! A static export emits directory `index.html` documents plus one `_`
//! placeholder per dynamic segment. The host has to reproduce that mapping or
//! deep links land on the wrong route tree.

use std::fs;
use std::path::{Path, PathBuf};

#[path = "../src/static_server.rs"]
mod static_server;

use static_server::StaticFileServer;

fn fixture_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "oe-static-routes-{}-{}",
        name,
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);

    let files = [
        "index.html",
        "404.html",
        "config",
        "_next/static/chunks/app.js",
        "notebooks/index.html",
        "notebooks/index.txt",
        "notebooks/_/index.html",
        "notebooks/_/sources/_/index.html",
        "sources/index.html",
        "sources/_/index.html",
        "settings/index.html",
        "settings/models/index.html",
        "login/index.html",
    ];

    for file in files {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("<contents of {file}>")).unwrap();
    }

    root
}

fn resolve(root: &Path, request: &str) -> Option<String> {
    let canonical_root = fs::canonicalize(root).unwrap();
    StaticFileServer::resolve_static_target(root, request).map(|p| {
        let canonical = fs::canonicalize(&p).unwrap_or(p);
        canonical
            .strip_prefix(&canonical_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
    })
}

#[test]
fn serves_exact_assets() {
    let root = fixture_root("exact");
    assert_eq!(resolve(&root, "/config").as_deref(), Some("config"));
    assert_eq!(
        resolve(&root, "/_next/static/chunks/app.js").as_deref(),
        Some("_next/static/chunks/app.js")
    );
    // RSC payloads power soft navigation; they must be served as files.
    assert_eq!(
        resolve(&root, "/notebooks/index.txt").as_deref(),
        Some("notebooks/index.txt")
    );
}

#[test]
fn serves_directory_index_for_static_routes() {
    let root = fixture_root("dirs");
    assert_eq!(resolve(&root, "/notebooks/").as_deref(), Some("notebooks/index.html"));
    assert_eq!(resolve(&root, "/settings/").as_deref(), Some("settings/index.html"));
    assert_eq!(
        resolve(&root, "/settings/models/").as_deref(),
        Some("settings/models/index.html")
    );
}

#[test]
fn deep_links_resolve_to_the_dynamic_shell() {
    let root = fixture_root("deep");
    let shell = "notebooks/_/index.html";
    assert_eq!(
        resolve(&root, "/notebooks/6c1f0ce4-0000-4000-8000-000000000000/").as_deref(),
        Some(shell)
    );
    assert_eq!(
        resolve(&root, "/notebooks/6c1f0ce4-0000-4000-8000-000000000000").as_deref(),
        Some(shell)
    );
    assert_eq!(
        resolve(&root, "/sources/6c1f0ce4-0000-4000-8000-000000000000/").as_deref(),
        Some("sources/_/index.html")
    );
}

#[test]
fn nested_dynamic_routes_resolve_segment_by_segment() {
    let root = fixture_root("nested");
    assert_eq!(
        resolve(
            &root,
            "/notebooks/6c1f0ce4-0000-4000-8000-000000000000/sources/9a2b/chat/"
        )
        .as_deref(),
        Some("notebooks/_/sources/_/index.html")
    );
}

#[test]
fn unknown_paths_fall_through_to_the_root_shell() {
    let root = fixture_root("fallback");
    // No resolver match: handle_request then serves index.html as the app shell.
    assert_eq!(resolve(&root, "/no/such/route/at/all/"), None);
}

#[test]
fn traversal_attempts_are_rejected() {
    let root = fixture_root("traversal");
    assert_eq!(resolve(&root, "/../../etc/passwd"), None);
    assert_eq!(resolve(&root, "/%2e%2e/%2e%2e/etc/passwd"), None);
}
