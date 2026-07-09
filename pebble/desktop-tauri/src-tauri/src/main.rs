#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(commands::crash_reports::CrashReportsState::default())
        .manage(commands::runtime_process::RuntimeProcessState::default())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            commands::crash_reports::crash_reports_dismiss,
            commands::crash_reports::crash_reports_format,
            commands::crash_reports::crash_reports_get_latest_pending,
            commands::crash_reports::crash_reports_get_latest_report,
            commands::crash_reports::crash_reports_record_breadcrumb,
            commands::crash_reports::crash_reports_record_renderer_error,
            commands::crash_reports::crash_reports_submit,
            commands::deep_link::deep_link_initial_urls,
            commands::file_picker::pick_directory,
            commands::file_picker::pick_directories,
            commands::preflight::preflight_detect_commands,
            commands::runtime_environments::runtime_environments_add_from_pairing_code,
            commands::runtime_environments::runtime_environments_disconnect,
            commands::runtime_environments::runtime_environments_list,
            commands::runtime_environments::runtime_environments_remove,
            commands::runtime_environments::runtime_environments_resolve,
            commands::runtime_process::start_runtime_process,
            commands::runtime_process::stop_runtime_process,
            commands::runtime_process::runtime_process_status,
            commands::runtime_status::probe_runtime_status,
            commands::runtime_status::get_runtime_resource_json,
            commands::runtime_status::request_runtime_resource_json,
            commands::runtime_status::read_runtime_event_stream,
            commands::runtime_status::poll_native_actions,
            commands::runtime_status::update_native_action,
            commands::runtime_status::poll_browser_actions,
            commands::runtime_status::update_browser_action,
            commands::runtime_status::poll_emulator_actions,
            commands::runtime_status::update_emulator_action,
            commands::runtime_status::register_native_provider,
            commands::shell::shell_path_exists,
            commands::shell::shell_open_in_file_manager,
            commands::shell::shell_open_in_external_editor,
            commands::shell::shell_open_file_path,
            commands::shell::shell_open_url,
            commands::shell::shell_open_file_uri,
            commands::shell::shell_pick_file,
            commands::shell::shell_pick_directory,
            commands::shell::shell_pick_repo_icon_image,
            commands::shell::shell_copy_file,
            commands::updater::updater_check_latest_release
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Pebble Tauri desktop shell");

    app.run(|app_handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        if let tauri::RunEvent::Opened { urls } = event {
            commands::deep_link::emit_deep_links(
                app_handle,
                urls.into_iter().map(|url| url.to_string()),
            );
        }
    });
}
