use hyper::{Body, Request, Response, StatusCode};
use hyper::header::{CONTENT_TYPE, CACHE_CONTROL};
use std::path::{Path, PathBuf};
use std::fs;

#[derive(Clone)]
pub struct StaticFileServer {
    root_dir: PathBuf,
}

impl StaticFileServer {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }

    /// Validates path traversal security for static asset requests.
    pub fn validate_path_traversal(root: &Path, requested_path: &str) -> Option<PathBuf> {
        let normalized_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());

        // Check 1: Explicit traversal sequences or null bytes
        if requested_path.contains("..") || requested_path.to_lowercase().contains("%2e%2e") || requested_path.contains('\0') {
            return None;
        }

        let clean_path = requested_path.split('?').next()?.split('#').next()?;
        let relative = if clean_path.starts_with('/') { &clean_path[1..] } else { clean_path };
        let target = normalized_root.join(relative);

        if let Ok(canonical) = fs::canonicalize(&target) {
            if canonical.starts_with(&normalized_root) {
                return Some(canonical);
            }
        } else {
            // For non-existent files, ensure path calculation stays inside root
            let resolved = normalized_root.join(relative);
            if resolved.starts_with(&normalized_root) {
                return Some(resolved);
            }
        }

        None
    }

    /// Resolves a request path to a file under `root`, honouring how a Next.js
    /// static export lays out its output:
    ///
    /// 1. exact file (`/_next/static/chunks/x.js`, `/config`, `/notebooks/index.txt`)
    /// 2. directory index (`/notebooks/` -> `notebooks/index.html`)
    /// 3. dynamic-route shell (`/notebooks/<id>/` -> `notebooks/_/index.html`)
    ///
    /// The export emits a single `_` placeholder document per dynamic segment
    /// and the client resolves the real id from `location.pathname`. Without
    /// step 3 a deep link would fall through to the root shell, which is the
    /// wrong route tree, so the app would render the wrong page.
    pub fn resolve_static_target(root: &Path, requested_path: &str) -> Option<PathBuf> {
        let root = &fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let target = Self::validate_path_traversal(root, requested_path)?;

        if target.is_file() {
            return Some(target);
        }

        let index = target.join("index.html");
        if index.is_file() {
            return Some(index);
        }

        let clean_path = requested_path.split('?').next()?.split('#').next()?;
        let segments: Vec<&str> = clean_path.split('/').filter(|s| !s.is_empty()).collect();
        if segments.is_empty() {
            return None;
        }

        // Depth-first walk matching each segment against the on-disk name or
        // the export's `_` placeholder, keeping the deepest directory that
        // contains an index.html.
        let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
        let mut best: Option<(usize, PathBuf)> = None;

        while let Some((dir, depth)) = stack.pop() {
            if depth > 0 {
                let index = dir.join("index.html");
                if index.is_file() && best.as_ref().map_or(true, |(d, _)| depth > *d) {
                    best = Some((depth, index));
                }
            }
            if depth == segments.len() {
                continue;
            }

            let segment = segments[depth];
            let literal = dir.join(segment);
            if literal.is_dir() {
                stack.push((literal, depth + 1));
            }
            let placeholder = dir.join("_");
            if !segment.is_empty() && segment != "_" && placeholder.is_dir() {
                stack.push((placeholder, depth + 1));
            }
        }

        best.map(|(_, path)| path)
    }

    /// Serves static asset or applies SPA route fallback (`try_files $uri /index.html`).
    pub async fn handle_request(&self, req: Request<Body>) -> Result<Response<Body>, hyper::Error> {
        let raw_path = req.uri().path();

        // 1. Path Traversal Security Check
        if Self::validate_path_traversal(&self.root_dir, raw_path).is_none() {
            let err_res = Response::builder()
                .status(StatusCode::FORBIDDEN)
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"error":"Forbidden: Path traversal sequence detected"}"#))
                .unwrap();
            return Ok(err_res);
        }

        // 2. Resolve to a real asset: exact file, directory index, or dynamic shell
        if let Some(target_path) = Self::resolve_static_target(&self.root_dir, raw_path) {
            if let Ok(contents) = fs::read(&target_path) {
                let mime = mime_guess::from_path(&target_path)
                    .first_raw()
                    .unwrap_or("application/octet-stream");

                let cache_ctrl = if mime.contains("html") {
                    "no-cache"
                } else {
                    "public, max-age=31536000, immutable"
                };

                let res = Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_TYPE, mime)
                    .header(CACHE_CONTROL, cache_ctrl)
                    .body(Body::from(contents))
                    .unwrap();
                return Ok(res);
            }
        }

        // 3. SPA Fallback to index.html for client dynamic routes
        let index_path = self.root_dir.join("index.html");
        let html_content = if index_path.is_file() {
            fs::read_to_string(&index_path).unwrap_or_else(|_| "<html><body>SPA Shell</body></html>".to_string())
        } else {
            "<!DOCTYPE html><html><body><div id=\"root\">SPA Shell</div></body></html>".to_string()
        };

        let res = Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/html; charset=utf-8")
            .header(CACHE_CONTROL, "no-cache, no-store, must-revalidate")
            .header("X-SPA-Fallback", "true")
            .body(Body::from(html_content))
            .unwrap();

        Ok(res)
    }
}
