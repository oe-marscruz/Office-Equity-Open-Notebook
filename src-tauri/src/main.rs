#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod runner;
mod service_diagnostics;
mod security;
mod job_object;
mod proxy;
mod static_server;
mod server;
mod credentials;

use runner::{resolve_runtime_path, check_missing_files, start_services};

fn main() {
    let runtime_path = resolve_runtime_path();
    if let Err(missing) = check_missing_files(&runtime_path) {
        let msg = format!("The bundled runtime is incomplete. Please re-run `npm run prepare:runtime` and rebuild the app. Missing components: {}.", missing.len());
        eprintln!("Office of Equity Open Notebook — runtime not found");
        eprintln!("{}", msg);
        tauri::api::dialog::blocking::MessageDialogBuilder::new("Office of Equity Open Notebook — runtime not found", &msg)
            .kind(tauri::api::dialog::MessageDialogKind::Error)
            .show();
        std::process::exit(1);
    }

    // The window is created in `setup` so the navigation policy is installed before the
    // webview loads. Clear the config-declared windows so `tauri` does not also create one.
    let mut context = tauri::generate_context!();
    let window_config = context.config_mut().tauri.windows.pop();

    tauri::Builder::default()
        .setup(move |app| {
            // Start background services and embedded static/proxy server
            tauri::async_runtime::spawn(async move {
                if start_services(runtime_path.clone()).await.is_err() {
                    let msg = "SERVICE_STARTUP_FAILED: Review the service lifecycle diagnostics.".to_owned();
                    eprintln!("{}", msg);
                    tauri::api::dialog::blocking::MessageDialogBuilder::new("Office of Equity Open Notebook — failed to start", &msg)
                        .kind(tauri::api::dialog::MessageDialogKind::Error)
                        .show();
                    std::process::exit(1);
                }
            });

            // Create the main window with the navigation security policy applied
            let config = window_config.clone().unwrap_or_default();
            security::build_secured_window(app, config)?;

            Ok(())
        })
.run(context)
        .unwrap_or_else(|_| {
            eprintln!("NATIVE_HOST_FAILED");
            std::process::exit(1);
        });
}
