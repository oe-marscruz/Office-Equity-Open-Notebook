use std::path::{Path, PathBuf};
use std::fs;
use std::time::Duration;
use tokio::time::sleep;
use std::net::TcpStream;
use sysinfo::{System, SystemExt};
use serde_json::Value;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use std::env;

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
    fs::create_dir_all(&data_dir).unwrap_or_default();

    let logs_dir = data_dir.join("logs");
    fs::create_dir_all(&logs_dir).unwrap_or_default();

    let backend_path = runtime_path.join("backend");

    // 1. SurrealDB
    let surreal_db_file = data_dir.join("surrealdb").join("mydatabase.db");
    fs::create_dir_all(data_dir.join("surrealdb")).unwrap_or_default();

    let mut surreal_cmd = tokio::process::Command::new(runtime_path.join("surreal").join("surreal.exe"));
    surreal_cmd.args(&["start", "--log", "info", "--user", "root", "--pass", "root", "--bind", "127.0.0.1:8000", &format!("rocksdb:{}", surreal_db_file.display())]);
    spawn_service("surrealdb", surreal_cmd, &logs_dir)?;

    wait_for_port(8000, 60).await?;

    // 2. API
    let python_exe = runtime_path.join("python").join("python.exe");
    let mut api_cmd = tokio::process::Command::new(&python_exe);
    api_cmd.args(&["-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", "5055"])
           .current_dir(&backend_path);
    spawn_service("api", api_cmd, &logs_dir)?;

    wait_for_port(5055, 120).await?;

    // 3. Worker
    let mut worker_cmd = tokio::process::Command::new(&python_exe);
    worker_cmd.args(&["-m", "surreal_commands.cli.worker", "--import-modules", "commands", "--max-tasks", "5"])
              .current_dir(&backend_path);
    spawn_service("worker", worker_cmd, &logs_dir)?;

    // 4. Native Embedded Static & API Reverse Proxy Server
    let static_dir = runtime_path.join("frontend").join("static");
    let static_dir_final = if static_dir.exists() {
        static_dir
    } else {
        PathBuf::from(".artifacts/static-client-poc")
    };

    tokio::spawn(async move {
        if let Err(err) = crate::server::start_embedded_server(8502, static_dir_final).await {
            eprintln!("CRITICAL: Native embedded HTTP server failed: {}", err);
        }
    });

    wait_for_port(8502, 120).await?;

    Ok(())
}

fn spawn_service(name: &'static str, mut cmd: tokio::process::Command, logs_dir: &Path) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn {}: {}", name, e))?;

    #[cfg(target_os = "windows")]
    {
        if let Some(handle) = child.raw_handle() {
            let _ = crate::job_object::apply_job_object_to_process(handle as winapi::um::winnt::HANDLE);
        }
    }

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let logs_dir_clone = logs_dir.to_path_buf();
    let name_clone = name.to_string();
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let log_file_path = logs_dir_clone.join(format!("{}.log", name_clone));
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&log_file_path).await.unwrap();

        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let line = line.trim();
            if !line.is_empty() {
                let log_entry = serde_json::json!({
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                    "name": name_clone,
                    "stream": "out",
                    "data": line
                });
                let mut log_str = log_entry.to_string();
                println!("{}", log_str);
                log_str.push('\n');
                let _ = file.write_all(log_str.as_bytes()).await;
            }
        }
    });

    let err_name = name.to_string();
    let logs_dir_err = logs_dir.to_path_buf();
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let log_file_path = logs_dir_err.join(format!("{}.log", err_name));
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&log_file_path).await.unwrap();

        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let line = line.trim();
            if !line.is_empty() {
                let log_entry = serde_json::json!({
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                    "name": err_name,
                    "stream": "err",
                    "data": line
                });
                let mut log_str = log_entry.to_string();
                eprintln!("{}", log_str);
                log_str.push('\n');
                let _ = file.write_all(log_str.as_bytes()).await;
            }
        }
    });

    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    Ok(())
}
