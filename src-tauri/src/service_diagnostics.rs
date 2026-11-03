use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy)]
pub enum Service {
    SurrealDb,
    Api,
    Worker,
}

impl Service {
    fn name(self) -> &'static str {
        match self {
            Self::SurrealDb => "surrealdb",
            Self::Api => "api",
            Self::Worker => "worker",
        }
    }
}

enum Event {
    Started,
    SpawnFailed,
    Exited,
    WaitFailed,
}
impl Event {
    fn name(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::SpawnFailed => "spawn_failed",
            Self::Exited => "exited",
            Self::WaitFailed => "wait_failed",
        }
    }
}

struct LifecycleLog {
    service: Service,
    file: File,
}
impl LifecycleLog {
    fn open(service: Service, directory: &Path) -> Result<Self, &'static str> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join(format!("{}.lifecycle.jsonl", service.name())))
            .map_err(|_| "SERVICE_DIAGNOSTIC_OPEN_FAILED")?;
        Ok(Self { service, file })
    }
    fn record(&mut self, event: Event, exit_code: Option<i32>) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let code = exit_code.map_or_else(|| "null".to_owned(), |value| value.to_string());
        let line = format!(
            "{{\"timestamp_ms\":{},\"service\":\"{}\",\"event\":\"{}\",\"exit_code\":{}}}\n",
            timestamp,
            self.service.name(),
            event.name(),
            code
        );
        if self.file.write_all(line.as_bytes()).is_err() {
            let _ = std::io::stderr().write_all(b"SERVICE_DIAGNOSTIC_WRITE_FAILED\n");
        }
        let _ = std::io::stdout().write_all(line.as_bytes());
    }
}

pub struct LoggedChild {
    child: Child,
    log: LifecycleLog,
    exit_reported: bool,
}
impl LoggedChild {
    #[cfg(target_os = "windows")]
    pub fn raw_handle(&self) -> std::os::windows::io::RawHandle {
        use std::os::windows::io::AsRawHandle;
        self.child.as_raw_handle()
    }
    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>, &'static str> {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                if !self.exit_reported {
                    self.log.record(Event::Exited, status.code());
                    self.exit_reported = true;
                }
                Ok(Some(status))
            }
            Ok(None) => Ok(None),
            Err(_) => {
                if !self.exit_reported {
                    self.log.record(Event::WaitFailed, None);
                    self.exit_reported = true;
                }
                Err("SERVICE_WAIT_FAILED")
            }
        }
    }
}

pub fn spawn_logged_child(
    service: Service,
    command: &mut Command,
    logs: &Path,
) -> Result<LoggedChild, &'static str> {
    let mut log = LifecycleLog::open(service, logs)?;
    // Discard arbitrary record text at the OS boundary, before any log or console sink.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    match command.spawn() {
        Ok(child) => {
            log.record(Event::Started, None);
            Ok(LoggedChild {
                child,
                log,
                exit_reported: false,
            })
        }
        Err(_) => {
            log.record(Event::SpawnFailed, None);
            Err("SERVICE_SPAWN_FAILED")
        }
    }
}
