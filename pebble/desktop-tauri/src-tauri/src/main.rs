#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod window_chrome;

use tauri::Manager;

fn main() {
    run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(commands::crash_reports::CrashReportsState::default())
        .manage(commands::diagnostics::DiagnosticsState::default())
        .manage(commands::filesystem_watch::FsWatcherState::default())
        .manage(commands::terminal_artifacts::TerminalArtifactsState::default())
        .manage(commands::runtime_environments::RuntimeEnvironmentSubscriptionsState::default())
        .setup(|app| {
            // Anti-flash background + macOS traffic-light parity with the
            // Electron shell; runs before the webview first paints.
            if let Some(window) = app.get_webview_window("main") {
                window_chrome::apply_window_chrome(&window);
            }
            Ok(())
        })
        .manage(commands::runtime_process::RuntimeProcessState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::browser_detection::browser_detect_installed_browsers,
            commands::computer_permissions::computer_permissions_open,
            commands::computer_permissions::computer_permissions_reset,
            commands::computer_permissions::computer_permissions_status,
            commands::crash_reports::crash_reports_dismiss,
            commands::crash_reports::crash_reports_format,
            commands::crash_reports::crash_reports_get_latest_pending,
            commands::crash_reports::crash_reports_get_latest_report,
            commands::crash_reports::crash_reports_record_breadcrumb,
            commands::crash_reports::crash_reports_record_renderer_error,
            commands::crash_reports::crash_reports_submit,
            commands::deep_link::deep_link_initial_urls,
            commands::diagnostics::diagnostics_collect_bundle,
            commands::diagnostics::diagnostics_delete_bundle,
            commands::diagnostics::diagnostics_discard_bundle_preview,
            commands::diagnostics::diagnostics_get_status,
            commands::diagnostics::diagnostics_open_bundle_preview,
            commands::diagnostics::diagnostics_upload_bundle,
            commands::file_picker::pick_directory,
            commands::file_picker::pick_directories,
            commands::filesystem_watch::fs_unwatch_worktree,
            commands::filesystem_watch::fs_watch_worktree,
            commands::git_refs::git_get_base_ref_default,
            commands::git_refs::git_resolve_mr_start_point,
            commands::git_refs::git_resolve_pr_start_point,
            commands::git_refs::git_search_base_ref_details,
            commands::hooks::hooks_create_issue_command_runner,
            commands::preflight::preflight_detect_commands,
            commands::preflight::preflight_probe_auth,
            commands::preflight::preflight_hydrate_shell_path,
            commands::runtime_environments::runtime_environments_add_from_pairing_code,
            commands::runtime_environments::runtime_environments_call,
            commands::runtime_environments::runtime_environments_disconnect,
            commands::runtime_environments::runtime_environments_list,
            commands::runtime_environments::runtime_environments_remove,
            commands::runtime_environments::runtime_environments_resolve,
            commands::runtime_environments::runtime_environments_send_subscription_binary,
            commands::runtime_environments::runtime_environments_subscribe,
            commands::runtime_environments::runtime_environments_unsubscribe,
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
            commands::settings_store::read_settings_document,
            commands::settings_store::write_settings_document,
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
            commands::terminal_artifacts::terminal_artifact_grant,
            commands::terminal_artifacts::terminal_artifact_preview,
            commands::terminal_artifacts::terminal_artifact_read,
            commands::terminal_artifacts::terminal_artifact_write,
            commands::updater::updater_check_latest_release,
            commands::updater::updater_fetch_changelog_entries
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
