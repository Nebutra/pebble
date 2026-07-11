#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod window_chrome;

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::Manager;

fn main() {
    run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(commands::browser_guest_find::BrowserGuestFindState::default())
        .manage(
            commands::browser_child_webview::NativeBrowserDownloadRegistry::default(),
        )
        .manage(commands::crash_reports::CrashReportsState::default())
        .manage(commands::diagnostics::DiagnosticsState::default())
        .manage(commands::filesystem_watch::FsWatcherState::default())
        .manage(commands::terminal_artifacts::TerminalArtifactsState::default())
        .manage(commands::runtime_environments::RuntimeEnvironmentSubscriptionsState::default())
        .manage(commands::runtime_event_stream::RuntimeEventStreamState::default())
        .manage(commands::computer_use_provider::ComputerUseProviderState::default())
        .manage(commands::source_control_text_generation::SourceControlTextGenerationState::default())
        .manage(commands::speech::SpeechState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Regular);

            if let Some(window) = app.get_webview_window("main") {
                apply_main_window_launch_parity(&window);
            }
            Ok(())
        })
        .manage(commands::runtime_process::RuntimeProcessState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::app_native::app_floating_markdown_directory,
            commands::app_native::app_pick_floating_workspace_directory,
            commands::app_native::app_pick_floating_markdown_document,
            commands::app_native::app_keyboard_input_source_id,
            commands::app_native::app_list_fonts,
            commands::agent_hooks::agent_hooks_claude_status,
            commands::agent_hooks::agent_hooks_openclaude_status,
            commands::agent_hooks::agent_hooks_apply_claude_compatible,
            commands::agent_hooks::agent_hooks_codex_status,
            commands::agent_hooks::agent_hooks_gemini_status,
            commands::agent_hooks::agent_hooks_apply_gemini,
            commands::agent_hooks::agent_hooks_antigravity_status,
            commands::agent_hooks::agent_hooks_amp_status,
            commands::agent_hooks::agent_hooks_apply_amp,
            commands::agent_hooks::agent_hooks_cursor_status,
            commands::agent_hooks::agent_hooks_apply_cursor,
            commands::agent_hooks::agent_hooks_droid_status,
            commands::agent_hooks::agent_hooks_apply_droid,
            commands::agent_hooks::agent_hooks_command_code_status,
            commands::agent_hooks::agent_hooks_apply_command_code,
            commands::agent_hooks::agent_hooks_grok_status,
            commands::agent_hooks::agent_hooks_apply_grok,
            commands::agent_hooks::agent_hooks_copilot_status,
            commands::agent_hooks::agent_hooks_hermes_status,
            commands::agent_hooks::agent_hooks_devin_status,
            commands::agent_hooks::agent_hooks_apply_devin,
            commands::agent_hooks::agent_hooks_kimi_status,
            commands::agent_hooks::agent_hooks_apply_kimi,
            commands::browser_detection::browser_detect_installed_browsers,
            commands::browser_annotation_overlay::browser_annotation_overlay_set,
            commands::browser_child_webview::browser_child_webview_create,
            commands::browser_child_webview::browser_child_webview_cancel_download,
            commands::browser_child_webview::browser_child_webview_screenshot,
            commands::browser_cookies::browser_guest_clear_cookies,
            commands::browser_cookies::browser_guest_import_cookie_file,
            commands::browser_cookies::browser_cookie_source_import::browser_guest_import_from_browser,
            commands::browser_guest_find::browser_guest_find,
            commands::browser_guest_find::browser_guest_stop_find,
            commands::browser_guest_evaluate::browser_guest_evaluate,
            commands::computer_permissions::computer_permissions_open,
            commands::computer_permissions::computer_permissions_reset,
            commands::computer_permissions::computer_permissions_status,
            commands::computer_use_provider::start_computer_use_provider,
            commands::computer_use_provider::stop_computer_use_provider,
            commands::crash_reports::crash_reports_dismiss,
            commands::crash_reports::crash_reports_format,
            commands::crash_reports::crash_reports_get_latest_pending,
            commands::crash_reports::crash_reports_get_latest_report,
            commands::crash_reports::crash_reports_record_breadcrumb,
            commands::crash_reports::crash_reports_record_renderer_error,
            commands::crash_reports::crash_reports_submit,
            commands::deep_link::deep_link_initial_urls,
            commands::developer_permissions::developer_permissions_status,
            commands::developer_permissions::developer_permissions_request,
            commands::developer_permissions::developer_permissions_open_settings,
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
            commands::runtime_event_stream::start_runtime_event_stream,
            commands::runtime_event_stream::stop_runtime_event_stream,
            commands::runtime_status::poll_native_actions,
            commands::runtime_status::update_native_action,
            commands::runtime_status::poll_browser_actions,
            commands::runtime_status::update_browser_action,
            commands::runtime_status::poll_emulator_actions,
            commands::runtime_status::update_emulator_action,
            commands::runtime_status::register_native_provider,
            commands::settings_store::read_settings_document,
            commands::settings_store::write_settings_document,
            commands::speech::speech_get_openai_key_status,
            commands::speech::speech_save_openai_key,
            commands::speech::speech_clear_openai_key,
            commands::speech::speech_get_model_states,
            commands::speech::speech_download_model,
            commands::speech::speech_cancel_download,
            commands::speech::speech_delete_model,
            commands::speech::speech_start_dictation,
            commands::speech::speech_feed_audio,
            commands::speech::speech_stop_dictation,
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
            commands::source_control_text_generation::source_control_text_generation_cancel,
            commands::source_control_text_generation::source_control_text_generation_commit_context,
            commands::source_control_text_generation::source_control_text_generation_execute_plan,
            commands::source_control_text_generation::source_control_text_generation_pull_request_context,
            commands::terminal_artifacts::terminal_artifact_grant,
            commands::terminal_artifacts::terminal_artifact_preview,
            commands::terminal_artifacts::terminal_artifact_read,
            commands::terminal_artifacts::terminal_artifact_write,
            commands::updater::updater_check_latest_release,
            commands::updater::updater_fetch_changelog_entries,
            commands::notifications::show_native_notification,
            commands::notifications::native_notification_permission,
            commands::notifications::request_native_notification_permission,
            commands::cli_registration::cli_install_status,
            commands::cli_registration::cli_install,
            commands::cli_registration::cli_remove,
            commands::cli_registration::cli_wsl_install_status,
            commands::cli_registration::cli_wsl_install,
            commands::cli_registration::cli_wsl_remove
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Pebble Tauri desktop shell");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::Ready => {
            #[cfg(target_os = "macos")]
            {
                let _ = app_handle.set_activation_policy(ActivationPolicy::Regular);
                let _ = app_handle.show();
            }

            if let Some(window) = app_handle.get_webview_window("main") {
                apply_main_window_launch_parity(&window);
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        tauri::RunEvent::Opened { urls } => {
            commands::deep_link::emit_deep_links(
                app_handle,
                urls.into_iter().map(|url| url.to_string()),
            );
        }
        _ => {}
    });
}

fn apply_main_window_launch_parity(window: &tauri::WebviewWindow) {
    // Anti-flash background + macOS traffic-light parity with the Electron
    // shell; setup applies it before first paint, Ready reapplies after AppKit.
    window_chrome::apply_window_chrome(window);
    window_chrome::promote_launch_window(window);

    // Dev runs the Tauri binary directly, so explicitly promote the main
    // window instead of relying on app-bundle activation.
    let _ = window.show();
    let _ = window.set_focus();
}
