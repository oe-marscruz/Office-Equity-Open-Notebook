use hyper::{Body, Request, Response, StatusCode, HeaderMap};
use hyper::header::{CONTENT_TYPE, CONTENT_LENGTH, CACHE_CONTROL};
use reqwest::Client;
use std::sync::Arc;
use futures_util::StreamExt;

pub const MAX_UPLOAD_SIZE_BYTES: u64 = 52_428_800; // 50 MB
pub const BACKEND_TARGET_URL: &str = "http://127.0.0.1:5055";

#[derive(Clone)]
pub struct ApiProxyService {
    client: Client,
    target_base: String,
}

impl ApiProxyService {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .tcp_nodelay(true)
                .build()
                .unwrap_or_default(),
            target_base: BACKEND_TARGET_URL.to_string(),
        }
    }

    /// Reverse proxies incoming HTTP requests to the loopback FastAPI backend.
    pub async fn handle_request(&self, req: Request<Body>) -> Result<Response<Body>, hyper::Error> {
        let path_and_query = req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("");
        let target_url = format!("{}{}", self.target_base, path_and_query);

        let method = req.method().clone();
        let headers = req.headers().clone();

        // 1. Enforce 50MB payload limit check on uploads
        if req.uri().path() == "/api/sources/upload" || method == hyper::Method::POST {
            if let Some(content_length_hdr) = headers.get(CONTENT_LENGTH) {
                if let Ok(len_str) = content_length_hdr.to_str() {
                    if let Ok(len) = len_str.parse::<u64>() {
                        if len > MAX_UPLOAD_SIZE_BYTES {
                            let json_err = serde_json::json!({
                                "error": format!("Payload Too Large: File size exceeds maximum limit of {} bytes", MAX_UPLOAD_SIZE_BYTES)
                            });
                            let res = Response::builder()
                                .status(StatusCode::PAYLOAD_TOO_LARGE)
                                .header(CONTENT_TYPE, "application/json")
                                .body(Body::from(json_err.to_string()))
                                .unwrap();
                            return Ok(res);
                        }
                    }
                }
            }
        }

        // 2. Prepare upstream request
        let body = req.into_body();
        let mut builder = self.client.request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            &target_url,
        );

        for (k, v) in headers.iter() {
            if k != hyper::header::HOST {
                builder = builder.header(k.as_str(), v.as_bytes());
            }
        }

        let body_stream = reqwest::Body::wrap_stream(body);
        builder = builder.body(body_stream);

        // 3. Dispatch upstream request
        match builder.send().await {
            Ok(upstream_res) => {
                let status = StatusCode::from_u16(upstream_res.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let mut res_builder = Response::builder().status(status);

                let is_sse = upstream_res.headers()
                    .get(CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.contains("text/event-stream"))
                    .unwrap_or(false);

                for (k, v) in upstream_res.headers().iter() {
                    res_builder = res_builder.header(k.as_str(), v.as_bytes());
                }

                if is_sse {
                    // Force unbuffered headers for SSE streams
                    res_builder = res_builder
                        .header(CACHE_CONTROL, "no-cache")
                        .header("X-Accel-Buffering", "no");

                    let stream = upstream_res.bytes_stream().map(|chunk_res| {
                        chunk_res.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
                    });

                    let body = Body::wrap_stream(stream);
                    Ok(res_builder.body(body).unwrap())
                } else {
                    let bytes = upstream_res.bytes().await.unwrap_or_default();
                    Ok(res_builder.body(Body::from(bytes)).unwrap())
                }
            }
            Err(_) => {
                let json_err = serde_json::json!({
                    "error": "UPSTREAM_CONNECTION_FAILED"
                });
                let res = Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(json_err.to_string()))
                    .unwrap();
                Ok(res)
            }
        }
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    use hyper::service::{make_service_fn, service_fn};
    use std::convert::Infallible;
    use std::net::TcpListener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const REQUEST_PATH: &str = "/api/search?query=SYNTHETIC_RECORD&token=SYNTHETIC_TOKEN";

    async fn request_through_proxy(target: std::net::SocketAddr) -> (StatusCode, String) {
        let proxy = ApiProxyService {
            client: Client::builder().no_proxy().timeout(std::time::Duration::from_secs(5)).build().unwrap(),
            target_base: format!("http://{}", target),
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = hyper::Server::from_tcp(listener).unwrap().serve(make_service_fn(move |_| {
            let proxy = proxy.clone();
            async move {
                Ok::<_, Infallible>(service_fn(move |request| {
                    let proxy = proxy.clone();
                    async move { proxy.handle_request(request).await }
                }))
            }
        }));
        let task = tokio::spawn(server);
        let response = Client::builder().no_proxy().timeout(std::time::Duration::from_secs(5)).build().unwrap()
            .get(format!("http://{}{}", address, REQUEST_PATH))
            .send().await.unwrap();
        let status = response.status();
        let body = response.text().await.unwrap();
        task.abort();
        (status, body)
    }

    fn assert_safe_failure(status: StatusCode, body: &str) {
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(!body.contains("SYNTHETIC"), "Request data escaped into a host-generated error");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({"error": "UPSTREAM_CONNECTION_FAILED"})
        );
    }

    #[tokio::test]
    async fn connection_failure_does_not_echo_request_url() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let (status, body) = request_through_proxy(address).await;
        assert_safe_failure(status, &body);
    }

    #[tokio::test]
    async fn malformed_upstream_does_not_echo_request_or_protocol_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            stream.write_all(b"SYNTHETIC_EXCEPTION invalid HTTP response\r\n\r\n").await.unwrap();
        });
        let (status, body) = request_through_proxy(address).await;
        upstream.await.unwrap();
        assert_safe_failure(status, &body);
    }

    #[tokio::test]
    async fn successful_backend_content_is_preserved() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = hyper::Server::from_tcp(listener).unwrap().serve(make_service_fn(|_| async {
            Ok::<_, Infallible>(service_fn(|request: Request<Body>| async move {
                assert_eq!(request.uri().path_and_query().unwrap().as_str(), REQUEST_PATH);
                Ok::<_, Infallible>(Response::builder()
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"result":"SYNTHETIC_RECORD"}"#)).unwrap())
            }))
        }));
        let upstream = tokio::spawn(server);
        let (status, body) = request_through_proxy(address).await;
        upstream.abort();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, r#"{"result":"SYNTHETIC_RECORD"}"#);
    }
}
