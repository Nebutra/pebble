#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
#[cfg(target_os = "macos")]
mod macos_native_quit;
mod native_quit;
mod packaged_cli;
mod primary_window;
mod termination_signal;
mod window_chrome;
mod window_state;
mod windows_system_tray;
mod zig_system;

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::Manager;

fn main() {
    if let Some(exit_code) = packaged_cli::dispatch_if_requested() {
        std::process::exit(exit_code);
    }
    run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let browser_interception_state =
        commands::browser_navigation_interception::NativeBrowserNavigationInterceptionState::default();
    let fulfillment_protocol_state = browser_interception_state.clone();
    let builder = tauri::Builder::default()
        .register_uri_scheme_protocol(
            commands::browser_navigation_interception::FULFILLMENT_SCHEME,
            move |context, request| {
                fulfillment_protocol_state
                    .serve_top_level_fulfillment(context.webview_label(), request.uri().path())
            },
        )
        .plugin(tauri_plugin_notification::init())
        .manage(commands::browser_guest_find::BrowserGuestFindState::default())
        .manage(browser_interception_state)
        .manage(commands::browser_child_webview::NativeBrowserDownloadRegistry::default())
        .manage(commands::browser_child_webview::NativeBrowserPermissionOverrideRegistry::default())
        .manage(commands::browser_screencast::BrowserScreencastState::default())
        .manage(commands::browser_video_recording::BrowserVideoRecordingState::default())
        .manage(commands::crash_reports::CrashReportsState::default())
        .manage(commands::native_session_recovery::NativeSessionState::default())
        .manage(native_quit::NativeQuitState::default())
        .manage(commands::diagnostics::DiagnosticsState::default())
        .manage(commands::deep_link::DeepLinkState::default())
        .manage(commands::filesystem_watch::FsWatcherState::default())
        .manage(commands::native_chat_transcript::NativeChatWatcherState::default())
        .manage(commands::filesystem_download::DownloadedFileState::default())
        .manage(commands::terminal_artifacts::TerminalArtifactsState::default())
        .manage(commands::runtime_environments::RuntimeEnvironmentSubscriptionsState::default())
        .manage(commands::runtime_event_stream::RuntimeEventStreamState::default())
        .manage(commands::computer_use_provider::ComputerUseProviderState::default())
        .manage(commands::emulator_ios_provider::EmulatorIosProviderState::default())
        .manage(commands::emulator_android_provider::EmulatorAndroidProviderState::default())
        .manage(commands::emulator_android_permissions::EmulatorAndroidPermissionState::default())
        .manage(commands::emulator_ios_permissions::EmulatorIosPermissionState::default())
        .manage(commands::emulator_mjpeg_stream::EmulatorMjpegStreamState::default())
        .manage(commands::emulator_scrcpy_video::EmulatorScrcpyVideoState::default())
        .manage(primary_window::LaunchWindowReveal::default())
        .manage(window_chrome::WindowChromeState::default())
        .manage(
            commands::source_control_text_generation::SourceControlTextGenerationState::default(),
        )
        .manage(commands::speech::SpeechState::default())
        .manage(window_state::WindowStatePersistence::default());
    let builder = if std::env::var_os("PEBBLE_FUNCTIONAL_GATE_REPO_PATH").is_none() {
        // Why: Windows/Linux protocol activation launches another process;
        // forward its argv to the existing shell so deep links are never lost.
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            commands::deep_link::emit_deep_links(app, argv);
            if let Some(window) = primary_window::webview_window(app) {
                primary_window::restore_and_focus(&window);
            }
        }))
    } else {
        builder
    };
    let builder = builder
        .setup(|app| {
            // Why: ABI and window setup run before build returns; install the
            // host hook here so their panics still reach the crash journal.
            commands::crash_reports::install_native_panic_hook(app.handle().clone());
            // Why: Tauri invokes setup from AppKit's didFinishLaunching callback,
            // where an escaping Rust panic aborts because Objective-C cannot unwind it.
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                configure_native_setup(app)
            }))
            .is_err()
            {
                commands::crash_reports::record_native_startup_failure(
                    app.handle(),
                    "native-setup-panic",
                    "native setup panicked; see the paired Rust panic report",
                );
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    app_handle.exit(1);
                });
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            #[cfg(debug_assertions)]
            {
                install_page_load_probe(webview, payload.url().as_str());
                commands::renderer_parity_capture::schedule_from_environment(webview);
            }
            #[cfg(not(debug_assertions))]
            let _ = payload.url();

            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(window) = primary_window::webview_window(webview.app_handle()) {
                    // Why: parity runs capture the hidden WebView directly.
                    // Revealing each sample looks like a user-facing crash loop.
                    let parity_capture = cfg!(debug_assertions)
                        && std::env::var_os("PEBBLE_PARITY_CAPTURE_PATH").is_some();
                    if window.label() == webview.label() && !parity_capture {
                        let revealed = webview
                            .state::<primary_window::LaunchWindowReveal>()
                            .reveal_once(&window);
                        if revealed {
                            window_chrome::promote_launch_window(&window);
                        }
                    }
                }
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        commands::crash_reports::record_web_content_process_termination(webview);
    });
    let app = builder
        .on_window_event(|window, event| {
            window
                .state::<window_state::WindowStatePersistence>()
                .handle_event(window, event);
        })
        .manage(commands::runtime_process::RuntimeProcessState::default())
        .manage(commands::agent_awake::AgentAwakeState::default())
        .manage(commands::browser_request_control::NativeBrowserRequestControlState::default())
        .manage(commands::browser_native_input::BrowserNativeInputState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            #[cfg(debug_assertions)]
            commands::renderer_parity_capture::renderer_parity_record_settings_performance,
            #[cfg(debug_assertions)]
            commands::app_native::app_floating_markdown_directory,
            commands::app_native::app_floating_terminal_cwd,
            commands::app_native::app_pick_floating_workspace_directory,
            commands::app_native::app_pick_floating_markdown_document,
            commands::app_native::app_keyboard_input_source_id,
            commands::app_native::app_list_fonts,
            commands::app_native::app_platform_info,
            commands::app_native::app_linux_install_kind,
            commands::star_nag::star_nag_check,
            commands::star_nag::star_nag_star,
            commands::browser_upload_files::browser_read_upload_files,
            commands::browser_child_webview::browser_child_webview_resolve_dialog,
            commands::browser_native_input::browser_child_webview_input,
            commands::browser_navigation_interception::browser_navigation_interception_enable,
            commands::browser_navigation_interception::browser_navigation_interception_disable,
            commands::browser_navigation_interception::browser_navigation_interception_list,
            commands::browser_request_control::browser_request_control_resolve,
            commands::browser_request_control::browser_document_request_pause,
            commands::browser_full_page_screenshot::browser_stitch_full_page_screenshot,
            zig_system::zig_system_status,
            commands::agent_accounts::agent_account_auth_status,
            commands::agent_awake::agent_awake_sync,
            commands::agent_trust::agent_trust_mark_trusted,
            commands::managed_codex_accounts::managed_codex_account_prepare,
            commands::managed_codex_accounts::managed_codex_account_identity,
            commands::managed_codex_accounts::managed_codex_account_remove,
            commands::managed_claude_accounts::managed_claude_account_prepare,
            commands::managed_claude_accounts::managed_claude_account_capture,
            commands::managed_claude_accounts::managed_claude_account_activate,
            commands::managed_claude_accounts::managed_claude_account_remove,
            commands::rate_limits::rate_limits_fetch_claude,
            commands::rate_limits::rate_limits_fetch_claude_managed,
            commands::rate_limits::rate_limits_fetch_claude_wsl,
            commands::rate_limits::rate_limits_fetch_codex,
            commands::rate_limits::rate_limits_fetch_codex_wsl,
            commands::rate_limits::rate_limits_fetch_kimi,
            commands::rate_limits::rate_limits_opencode::rate_limits_fetch_opencode_go,
            commands::minimax_credentials::minimax_credentials_get_status,
            commands::minimax_credentials::minimax_credentials_save_cookie,
            commands::minimax_credentials::minimax_credentials_clear_cookie,
            commands::rate_limits::rate_limits_minimax::rate_limits_fetch_minimax,
            commands::rate_limits::rate_limits_gemini::rate_limits_fetch_gemini,
            commands::rate_limits::rate_limits_consume_codex_reset_credit,
            commands::rate_limits::rate_limits_consume_codex_reset_credit_wsl,
            commands::agent_hooks::agent_hooks_claude_status,
            commands::agent_hooks::agent_hooks_openclaude_status,
            commands::agent_hooks::agent_hooks_apply_claude_compatible,
            commands::agent_hooks::agent_hooks_codex_status,
            commands::agent_hooks::agent_hooks_apply_codex,
            commands::agent_hooks::agent_hooks_gemini_status,
            commands::agent_hooks::agent_hooks_apply_gemini,
            commands::agent_hooks::agent_hooks_antigravity_status,
            commands::agent_hooks::agent_hooks_apply_antigravity,
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
            commands::agent_hooks::agent_hooks_apply_copilot,
            commands::agent_hooks::agent_hooks_hermes_status,
            commands::agent_hooks::agent_hooks_apply_hermes,
            commands::agent_hooks::agent_hooks_devin_status,
            commands::agent_hooks::agent_hooks_apply_devin,
            commands::agent_hooks::agent_hooks_kimi_status,
            commands::agent_hooks::agent_hooks_apply_kimi,
            commands::browser_detection::browser_detect_installed_browsers,
            commands::browser_annotation_overlay::browser_annotation_overlay_set,
            commands::browser_child_webview::browser_permission_overrides::browser_permission_overrides_sync,
            commands::browser_device_access::browser_device_access_capabilities,
            commands::browser_device_access::browser_device_selection_resolve,
            commands::browser_child_webview::browser_child_webview_create,
            commands::browser_child_webview::browser_profile_storage_delete,
            commands::browser_http_auth::browser_child_webview_set_http_auth,
            commands::browser_http_auth::browser_child_webview_clear_http_auth,
            commands::browser_child_webview::browser_child_webview_cancel_download,
            commands::browser_child_webview::browser_child_webview_prepare_download,
            commands::browser_child_webview::browser_child_webview_wait_download,
            commands::browser_child_webview::browser_child_webview_screenshot,
            commands::browser_screencast::browser_screencast_start,
            commands::browser_screencast::browser_screencast_mark_dirty,
            commands::browser_screencast::browser_screencast_ack,
            commands::browser_screencast::browser_screencast_stop,
            commands::browser_screencast_forward::browser_screencast_forward_frame,
            commands::browser_video_recording::browser_video_recording_start,
            commands::browser_video_recording::browser_video_recording_append,
            commands::browser_video_recording::browser_video_recording_stop,
            commands::browser_child_webview::browser_child_webview_pdf,
            commands::browser_capture_save::browser_capture_save,
            commands::browser_capture_save::browser_capture_read,
            commands::browser_cookies::browser_guest_clear_cookies,
            commands::browser_cookies::browser_guest_cookie_get,
            commands::browser_cookies::browser_guest_cookie_set,
            commands::browser_cookies::browser_guest_cookie_delete,
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
            commands::emulator_ios_provider::start_emulator_ios_provider,
            commands::emulator_ios_provider::stop_emulator_ios_provider,
            commands::emulator_android_provider::start_emulator_android_provider,
            commands::emulator_android_provider::stop_emulator_android_provider,
            commands::emulator_android_permissions::emulator_android_permission_set,
            commands::emulator_android_permissions::emulator_android_permission_cancel,
            commands::emulator_ios_permissions::emulator_ios_permission_set,
            commands::emulator_ios_permissions::emulator_ios_permission_cancel,
            commands::emulator_mjpeg_stream::emulator_frame_stream_start,
            commands::emulator_mjpeg_stream::emulator_frame_stream_stop,
            commands::emulator_scrcpy_video::emulator_video_stream_start,
            commands::emulator_scrcpy_video::emulator_video_stream_stop,
            commands::export_pdf::export_html_to_pdf,
            commands::crash_reports::crash_reports_dismiss,
            commands::crash_reports::crash_reports_format,
            commands::crash_reports::crash_reports_get_latest_pending,
            commands::crash_reports::crash_reports_get_latest_report,
            commands::crash_reports::crash_reports_record_breadcrumb,
            commands::crash_reports::crash_reports_record_renderer_error,
            commands::crash_reports::crash_reports_submit,
            commands::deep_link::deep_link_initial_urls,
            commands::developer_permissions::developer_permissions_status,
            commands::external_automations::external_automations_list_local,
            commands::external_automations::external_automations_mutate_local,
            commands::feedback::feedback_submit,
            commands::hermes_automation_history::external_automations_list_local_runs,
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
            commands::native_chat_transcript::native_chat_read_session,
            commands::native_chat_transcript::native_chat_subscribe,
            commands::native_chat_transcript::native_chat_unsubscribe,
            commands::functional_gate::functional_gate_config,
            commands::functional_gate::functional_gate_minimize,
            commands::functional_gate::functional_gate_restore_and_focus,
            commands::functional_gate::functional_gate_capture_ready,
            commands::functional_gate::functional_gate_write_evidence,
            commands::filesystem_external_import::fs_import_external_paths,
            commands::filesystem_external_import::fs_stage_external_paths,
            commands::filesystem_download::fs_save_downloaded_file,
            commands::filesystem_download::fs_start_downloaded_file,
            commands::filesystem_download::fs_append_downloaded_file_chunk,
            commands::filesystem_download::fs_finish_downloaded_file,
            commands::filesystem_download::fs_cancel_downloaded_file,
            commands::git_refs::git_get_base_ref_default,
            commands::git_refs::git_resolve_mr_start_point,
            commands::git_refs::git_resolve_pr_start_point,
            commands::git_refs::git_search_base_ref_details,
            commands::hooks::hooks_create_issue_command_runner,
            commands::jira::jira_connect,
            commands::jira::jira_disconnect,
            commands::jira::jira_select_site,
            commands::jira::jira_status,
            commands::jira::jira_test_connection,
            commands::jira::jira_request,
            commands::linear::linear_connect,
            commands::linear::linear_disconnect,
            commands::linear::linear_select_workspace,
            commands::linear::linear_status,
            commands::linear::linear_test_connection,
            commands::linear::linear_request,
            commands::preflight::preflight_detect_commands,
            commands::preflight::preflight_probe_auth,
            commands::preflight::preflight_hydrate_shell_path,
            commands::runtime_environments::runtime_environments_add_from_pairing_code,
            commands::runtime_environments::runtime_environments_update_pairing_code,
            commands::runtime_environments::runtime_environments_call,
            commands::runtime_environments::runtime_environments_disconnect,
            commands::runtime_environments::runtime_environments_list,
            commands::runtime_environments::runtime_environments_remove,
            commands::runtime_environments::runtime_environments_resolve,
            commands::runtime_environments::runtime_environments_send_subscription_binary,
            commands::runtime_environments::runtime_environments_subscribe,
            commands::runtime_environments::runtime_environments_unsubscribe,
            commands::network_interfaces::network_list_interfaces,
            commands::native_paste::perform_native_paste,
            commands::runtime_process::start_runtime_process,
            commands::runtime_process::stop_runtime_process,
            commands::runtime_process::runtime_process_status,
            commands::renderer_bootstrap_log::renderer_bootstrap_log,
            commands::runtime_pty_input::write_runtime_pty_input,
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
            commands::settings_store::settings_document_path,
            commands::ghostty_import::settings_read_ghostty_sources,
            commands::ghostty_import::settings_read_ghostty_theme,
            commands::warp_theme_import::settings_read_warp_theme_sources,
            commands::session_store::read_host_workspace_session,
            commands::session_store::write_host_workspace_session,
            commands::speech::speech_get_openai_key_status,
            commands::speech::speech_save_openai_key,
            commands::speech::speech_clear_openai_key,
            commands::speech::speech_get_model_states,
            commands::speech::speech_download_model,
            commands::speech::speech_cancel_download,
            commands::speech::speech_delete_model,
            commands::speech::speech_local_inference_supported,
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
            commands::telemetry::telemetry_track,
            commands::telemetry::telemetry_set_opt_in,
            commands::telemetry::telemetry_get_consent_state,
            commands::telemetry::telemetry_acknowledge_banner,
            commands::updater::updater_check_latest_release,
            commands::updater::updater_check_release_tag,
            commands::updater::updater_assert_install_ready,
            commands::updater::updater_fetch_changelog_entries,
            commands::updater::updater_fetch_nudge,
            commands::webview_reload::webview_reload,
            commands::webview_reload::webview_toggle_devtools,
            commands::notifications::show_native_notification,
            commands::pet::pet_import,
            commands::pet::pet_import_bundle,
            commands::pet::pet_read,
            commands::pet::pet_delete,
            commands::diagnostics_memory::diagnostics_memory_snapshot,
            window_chrome::window_set_traffic_light_zoom,
            window_state::window_prepare_to_close,
            native_quit::native_quit_take_pending,
            commands::notifications::native_notification_permission,
            commands::notifications::request_native_notification_permission,
            commands::notifications::open_notification_system_settings,
            commands::notifications::load_notification_sound,
            commands::cli_registration::cli_install_status,
            commands::cli_registration::cli_install,
            commands::cli_registration::cli_remove,
            commands::cli_registration::cli_wsl_install_status,
            commands::cli_registration::cli_wsl_install,
            commands::cli_registration::cli_wsl_remove
            ,commands::clipboard::clipboard_read_text
            ,commands::clipboard::clipboard_write_text
            ,commands::clipboard::clipboard_read_selection_text
            ,commands::clipboard::clipboard_write_selection_text
            ,commands::clipboard::clipboard_write_file
            ,commands::clipboard::clipboard_save_image_as_temp_file
            ,commands::clipboard::clipboard_save_image_bytes_as_temp_file
            ,commands::clipboard::clipboard_write_image
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Pebble Tauri desktop shell");

    termination_signal::install(app.handle().clone());
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Ready => {
            let _ = commands::native_session_recovery::record_stage(app_handle, "ready");
            primary_window::schedule_launch_reveal_fallback(app_handle.clone());
            #[cfg(target_os = "macos")]
            commands::macos_system_crash_import::import_unseen_reports(app_handle.clone());
            #[cfg(target_os = "macos")]
            {
                let _ = app_handle.set_activation_policy(ActivationPolicy::Regular);
            }
            if !primary_window::is_evidence_shell() {
                if let Some(window) = primary_window::webview_window(app_handle) {
                    // Why: Tauri can report a launch window as visible while AppKit still
                    // hides the application, causing the delayed fallback to skip recovery.
                    primary_window::restore_and_focus(&window);
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = primary_window::webview_window(app_handle) {
                primary_window::restore_and_focus(&window);
                window_chrome::promote_launch_window(&window);
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        tauri::RunEvent::Opened { urls } => {
            commands::deep_link::emit_deep_links(
                app_handle,
                urls.into_iter().map(|url| url.to_string()),
            );
            if let Some(window) = primary_window::webview_window(app_handle) {
                primary_window::restore_and_focus(&window);
                window_chrome::promote_launch_window(&window);
            }
        }
        tauri::RunEvent::Exit => {
            app_handle
                .state::<commands::agent_awake::AgentAwakeState>()
                .shutdown();
            let runtime_state =
                app_handle.state::<commands::runtime_process::RuntimeProcessState>();
            let _ = commands::runtime_process::stop_managed_runtime_process(&runtime_state);
            let _ = commands::native_session_recovery::mark_clean(app_handle);
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            native_quit::handle_exit_requested(app_handle, &api);
        }
        _ => {}
    });
}

fn configure_native_setup(app: &mut tauri::App) {
    if let Err(error) = commands::native_session_recovery::begin(app.handle()) {
        commands::crash_reports::record_native_startup_failure(
            app.handle(),
            "native-session-recovery",
            &error,
        );
    }
    #[cfg(target_os = "macos")]
    {
        let _ = commands::native_session_recovery::record_stage(
            app.handle(),
            "native-quit-hook-installing",
        );
        if let Err(error) = macos_native_quit::install(app.handle()) {
            // Why: startup remains usable when the optional native quit hook
            // cannot attach; the failure is preserved for diagnosis.
            commands::crash_reports::record_native_startup_failure(
                app.handle(),
                "macos-native-quit-hook",
                &error,
            );
        } else {
            let _ = commands::native_session_recovery::record_stage(
                app.handle(),
                "native-quit-hook-installed",
            );
        }
    }
    // Why: Zig is a shipped native dependency; fail startup instead of
    // running with an ABI that Rust cannot safely call.
    let _ = commands::native_session_recovery::record_stage(app.handle(), "zig-abi-verifying");
    if let Err(error) = zig_system::verify_linked_abi() {
        commands::crash_reports::record_native_startup_failure(
            app.handle(),
            "zig-linked-abi",
            &error,
        );
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            app_handle.exit(1);
        });
        return;
    }
    let _ = commands::native_session_recovery::record_stage(app.handle(), "abi-verified");
    #[cfg(target_os = "macos")]
    app.set_activation_policy(ActivationPolicy::Regular);
    #[cfg(target_os = "windows")]
    if let Err(error) = windows_system_tray::install(app) {
        commands::crash_reports::record_native_startup_failure(
            app.handle(),
            "windows-system-tray",
            &error.to_string(),
        );
    }

    if let Some(window) = primary_window::webview_window(app.handle()) {
        // Why: functional parity captures require deterministic bounds;
        // restoring a developer window would invalidate cross-shell pixels.
        if std::env::var_os("PEBBLE_FUNCTIONAL_GATE_REPO_PATH").is_none() {
            app.state::<window_state::WindowStatePersistence>()
                .restore(&window);
        }
        window_chrome::apply_window_chrome(&window);
        install_main_window_renderer_diagnostics(&window);
    }
    let _ = commands::native_session_recovery::record_stage(app.handle(), "window-configured");
}

fn install_main_window_renderer_diagnostics(window: &tauri::WebviewWindow) {
    // Why: module initialization can fail before React and renderer crash
    // boundaries exist; relay those otherwise invisible white-screen errors.
    let _ = window.eval(
        r#"(() => {
          const report = (stage, value) => {
            const message = value?.stack || value?.message || String(value);
            window.__TAURI_INTERNALS__?.invoke('renderer_bootstrap_log', { input: { stage, message } }).catch(() => {});
          };
          window.addEventListener('error', (event) => report('error', event.error || event.message));
          window.addEventListener('unhandledrejection', (event) => report('unhandledrejection', event.reason));
        })()"#,
    );
}

#[cfg(debug_assertions)]
fn install_page_load_probe<R: tauri::Runtime>(webview: &tauri::Webview<R>, url: &str) {
    eprintln!("[renderer-page-load] {url}");
    // Why: module failures can occur before renderer diagnostics install. This
    // bounded native probe distinguishes navigation, script, and React stalls.
    let _ = webview.eval(
        r#"setTimeout(() => {
          const root = document.getElementById('root');
          const snapshot = JSON.stringify({
            href: location.href,
            readyState: document.readyState,
            scripts: document.scripts.length,
            rootChildren: root?.childElementCount ?? -1,
            rootTextLength: root?.textContent?.length ?? -1
          });
          window.__TAURI_INTERNALS__?.invoke('renderer_bootstrap_log', {
            input: { stage: 'native-page-load-probe', message: snapshot }
          }).catch(() => {});
        }, 750)"#,
    );
}
