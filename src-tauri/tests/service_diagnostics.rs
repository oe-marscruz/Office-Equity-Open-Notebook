#[path = "../src/service_diagnostics.rs"]
mod service_diagnostics;

use service_diagnostics::{spawn_logged_child, Service};
use std::{env, fs, path::PathBuf, process::Command, sync::OnceLock};

fn root() -> &'static PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        env::var_os("OE_DIAGNOSTIC_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let unique = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default();
                env::temp_dir().join(format!(
                    "oe-service-diagnostics-test-{}-{}",
                    std::process::id(),
                    unique
                ))
            })
    })
}

/// Removes an auto-created test directory once the test finishes. A root supplied
/// through `OE_DIAGNOSTIC_TEST_ROOT` is owned by the caller, which may inspect the
/// generated records after the test binary exits, so it is left in place.
struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        if env::var_os("OE_DIAGNOSTIC_TEST_ROOT").is_none() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn directory(name: &str) -> PathBuf {
    let path = root().join(name);
    fs::create_dir_all(&path).unwrap();
    path
}
fn node() -> Command {
    Command::new(
        env::var_os("OE_DIAGNOSTIC_TEST_NODE").unwrap_or_else(|| "node".into()),
    )
}

#[test]
fn suppresses_child_records_and_exceptions() {
    let logs = directory("native_output");
    let _cleanup = Cleanup(logs.clone());
    for (service, name, throws) in [
        (Service::Api, "api", false),
        (Service::SurrealDb, "surrealdb", true),
        (Service::Worker, "worker", false),
    ] {
        let mut command = node();
        command.arg("-e").arg(format!(
            "process.stdout.write('NATIVE_SYNTHETIC_RECORD\\n'.repeat(100000)); process.stderr.write('NATIVE_SYNTHETIC_TOKEN'); {}",
            if throws { "throw new Error('NATIVE_SYNTHETIC_EXCEPTION');" } else { "process.exitCode=23;" }
        ));
        let mut child = spawn_logged_child(service, &mut command, &logs).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Test child did not exit"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(child.try_wait().unwrap(), Some(status));
        assert_eq!(status.code(), Some(if throws { 1 } else { 23 }));
        let contents = fs::read_to_string(logs.join(format!("{}.lifecycle.jsonl", name))).unwrap();
        assert_eq!(contents.lines().count(), 2);
        assert!(contents.contains("started") && contents.contains("exited"));
        assert!(!contents.contains("SYNTHETIC"));
    }
}

#[test]
fn spawn_errors_do_not_return_command_paths() {
    let logs = directory("native_missing");
    let _cleanup = Cleanup(logs.clone());
    let mut command = Command::new(logs.join("NATIVE_SYNTHETIC_MISSING.exe"));
    assert_eq!(
        spawn_logged_child(Service::Api, &mut command, &logs).err(),
        Some("SERVICE_SPAWN_FAILED")
    );
    let contents = fs::read_to_string(logs.join("api.lifecycle.jsonl")).unwrap();
    assert!(contents.contains("spawn_failed"));
    assert!(!contents.contains("SYNTHETIC"));
}

#[test]
fn diagnostic_open_failure_prevents_spawn() {
    let logs = directory("native_open_failure");
    let _cleanup = Cleanup(logs.clone());
    fs::create_dir(logs.join("api.lifecycle.jsonl")).unwrap();
    let marker = logs.join("NATIVE_SYNTHETIC_SHOULD_NOT_EXIST");
    let mut command = node();
    command
        .arg("-e")
        .arg("require('fs').writeFileSync(process.argv[1], 'started')")
        .arg(&marker);
    assert_eq!(
        spawn_logged_child(Service::Api, &mut command, &logs).err(),
        Some("SERVICE_DIAGNOSTIC_OPEN_FAILED")
    );
    assert!(!marker.exists());
}
