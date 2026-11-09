use std::path::{Path, PathBuf};
use std::fs;
use std::time::Duration;
use tokio::time::sleep;
use std::net::TcpStream;
use sysinfo::{System, SystemExt};
use std::env;
use crate::service_diagnostics::{spawn_logged_child, Service};
use crate::credentials;

pub fn resolve_runtime_path() -> PathBuf {
    let mut exe_dir = env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    exe_dir.pop();

    let prod_path = exe_dir.join("resources").join("runtime");
    if prod_path.exists() {
        return prod_path;
    }

    PathBuf::from("../resources/runtime")
}

pub fn check_missing_files(runtime_path: &Path) -> Result<(), Vec<PathBuf>> {
    let required = vec![
        "surreal/surreal.exe",
        "backend/open_notebook",
        "frontend/static",
    ];
    let mut missing = Vec::new();

    for req in required {
        let req_path = runtime_path.join(req);
        if !req_path.exists() {
            missing.push(req_path);
        }
    }

    if missing.is_empty() {
        Ok(())
    } else {
        Err(missing)
    }
}

fn is_port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&format!("127.0.0.1:{}", port).parse().unwrap(), Duration::from_secs(1)).is_ok()
}

async fn wait_for_port(port: u16, timeout_secs: u64) -> Result<(), String> {
    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(timeout_secs);
    while start.elapsed() < timeout {
        if is_port_open(port) {
            return Ok(());
        }
        sleep(Duration::from_millis(500)).await;
    }
    Err(format!("Timeout waiting for port {}", port))
}

pub async fn start_services(runtime_path: PathBuf) -> Result<(), String> {
    let ports = vec![8000, 5055, 8502];

    // Check port conflicts
    let mut sys = System::new_all();
    sys.refresh_all();

    for port in ports {
        if is_port_open(port) {
            return Err(format!("Port {} is already in use.", port));
        }
    }

    let data_dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join("OfficeEquityOpenNotebook");
    fs::create_dir_all(&data_dir).map_err(|_| "Could not create application data directory")?;

    // Resolve the per-install database credentials and the provider-API-key
    // encryption key. The credentials travel through the child environment
    // rather than the command line so they never appear in a process listing.
    let credentials = credentials::resolve_database_credentials(&data_dir)?;
    // A `LegacyUnmigrated` install has no password yet, so this refuses to
    // build an environment rather than starting SurrealDB with a default.
    let credential_env = credentials::build_credential_environment(&credentials)?;
    let encryption_key = credentials::ensure_encryption_key(&data_dir)?;

    let logs_dir = data_dir.join("logs");
    fs::create_dir_all(&logs_dir).unwrap_or_default();

    let backend_path = runtime_path.join("backend");

    // 1. SurrealDB
    let surreal_db_file = data_dir.join("surrealdb").join("mydatabase.db");
    fs::create_dir_all(data_dir.join("surrealdb")).unwrap_or_default();

    let mut surreal_cmd = std::process::Command::new(runtime_path.join("surreal").join("surreal.exe"));
    surreal_cmd.args(&["start", "--log", "info", "--bind", "127.0.0.1:8000", &format!("rocksdb:{}", surreal_db_file.display())]);
    for (name, value) in credential_env.as_pairs() {
        surreal_cmd.env(name, value);
    }
    spawn_service(Service::SurrealDb, surreal_cmd, &logs_dir)?;

    wait_for_port(8000, 60).await?;

    // 2. API
    let python_exe = runtime_path.join("python").join("python.exe");
    let mut api_cmd = std::process::Command::new(&python_exe);
    api_cmd.args(&["-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", "5055"])
           .current_dir(&backend_path);
    for (name, value) in credential_env.as_pairs() {
        api_cmd.env(name, value);
    }
    api_cmd.env("OPEN_NOTEBOOK_ENCRYPTION_KEY", &encryption_key);
    api_cmd.env("SURREAL_URL", "ws://127.0.0.1:8000/rpc");
    api_cmd.env("SURREAL_NAMESPACE", "open_notebook");
    api_cmd.env("SURREAL_DATABASE", "open_notebook");
    spawn_service(Service::Api, api_cmd, &logs_dir)?;

    wait_for_port(5055, 120).await?;

    // 3. Worker
    let mut worker_cmd = std::process::Command::new(&python_exe);
    worker_cmd.args(&["-m", "surreal_commands.cli.worker", "--import-modules", "commands", "--max-tasks", "5"])
              .current_dir(&backend_path);
    for (name, value) in credential_env.as_pairs() {
        worker_cmd.env(name, value);
    }
    worker_cmd.env("OPEN_NOTEBOOK_ENCRYPTION_KEY", &encryption_key);
    worker_cmd.env("SURREAL_URL", "ws://127.0.0.1:8000/rpc");
    worker_cmd.env("SURREAL_NAMESPACE", "open_notebook");
    worker_cmd.env("SURREAL_DATABASE", "open_notebook");
    spawn_service(Service::Worker, worker_cmd, &logs_dir)?;

    // 4. Native Embedded Static & API Reverse Proxy Server
    let static_dir = runtime_path.join("frontend").join("static");
    let static_dir_final = if static_dir.exists() {
        static_dir
    } else {
        PathBuf::from(".artifacts/static-client-poc")
    };

    tokio::spawn(async move {
        if crate::server::start_embedded_server(8502, static_dir_final).await.is_err() {
            eprintln!("NATIVE_HTTP_SERVER_FAILED");
        }
    });

    wait_for_port(8502, 120).await?;

    Ok(())
}

fn spawn_service(service: Service, mut command: std::process::Command, logs_dir: &Path) -> Result<(), String> {
    let mut child = spawn_logged_child(service, &mut command, logs_dir).map_err(str::to_owned)?;
    #[cfg(target_os = "windows")]
        {
            let handle = child.raw_handle() as winapi::um::winnt::HANDLE;
            let _ = crate::job_object::apply_job_object_to_process(handle);
        }
    tokio::spawn(async move {
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => sleep(Duration::from_millis(100)).await,
            }
        }
    });
    Ok(())
}
