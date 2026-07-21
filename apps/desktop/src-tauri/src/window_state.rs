use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize, State, Window, WindowEvent};

const MIN_WIDTH: u32 = 600;
const MIN_HEIGHT: u32 = 400;
const SAVE_DELAY: Duration = Duration::from_millis(500);
const STATE_FILE_NAME: &str = "window-state.json";
const LOGICAL_BOUNDS_VERSION: u8 = 2;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowState {
    #[serde(default)]
    version: u8,
    bounds: Option<WindowBounds>,
    maximized: bool,
}

impl Default for PersistedWindowState {
    fn default() -> Self {
        Self {
            version: LOGICAL_BOUNDS_VERSION,
            bounds: None,
            maximized: false,
        }
    }
}

#[derive(Default)]
struct SaveState {
    document: PersistedWindowState,
    generation: u64,
    closing: bool,
}

#[derive(Clone, Default)]
pub struct WindowStatePersistence {
    inner: Arc<Mutex<SaveState>>,
}

impl WindowStatePersistence {
    pub fn restore(&self, window: &tauri::WebviewWindow) {
        let path = match state_path(window.app_handle()) {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[window] failed to resolve state path: {error}");
                return;
            }
        };
        let monitors = window.available_monitors().unwrap_or_default();
        let document = read_state(&path).unwrap_or_default();
        let fallback_scale_factor = window.scale_factor().unwrap_or(1.0);
        let normalized_bounds = document.bounds.map(|bounds| {
            normalize_persisted_bounds(bounds, document.version, &monitors, fallback_scale_factor)
        });
        let valid_bounds =
            normalized_bounds.filter(|bounds| bounds_are_restorable(*bounds, &monitors));

        if document.bounds.is_some() && valid_bounds.is_none() {
            eprintln!("[window] discarded invalid or off-screen persisted bounds");
        }
        if let Some(bounds) = valid_bounds {
            restore_logical_bounds(window, bounds, &monitors);
        } else if let Ok(Some(monitor)) = window.primary_monitor() {
            let work_area = monitor.work_area();
            let _ = window.set_size(work_area.size);
            let _ = window.set_position(work_area.position);
        }
        if document.maximized {
            let _ = window.maximize();
        }

        if let Ok(mut state) = self.inner.lock() {
            state.document = PersistedWindowState {
                version: LOGICAL_BOUNDS_VERSION,
                bounds: valid_bounds,
                maximized: document.maximized,
            };
            state.closing = false;
        }
    }

    pub fn handle_event(&self, window: &Window, event: &WindowEvent) {
        match event {
            WindowEvent::CloseRequested { .. } => {
                // Renderer guards can veto this event. Capture current bounds,
                // but only freeze persistence once native destruction begins.
                self.capture_and_schedule(window);
            }
            WindowEvent::Destroyed => {
                self.freeze_and_save(window);
            }
            WindowEvent::Moved(_)
            | WindowEvent::Resized(_)
            | WindowEvent::ScaleFactorChanged { .. } => {
                self.capture_and_schedule(window);
            }
            _ => {}
        }
    }

    fn capture_and_schedule(&self, window: &Window) {
        let maximized = window.is_maximized().unwrap_or(false);
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let bounds = capture_bounds(window);
        let (generation, document) = {
            let Ok(mut state) = self.inner.lock() else {
                return;
            };
            if state.closing || fullscreen {
                return;
            }
            state.document.maximized = maximized;
            // Why: maximized geometry is display-sized and must not overwrite the
            // user's last normal bounds restored after unmaximizing.
            if !maximized {
                if let Some(bounds) = bounds.filter(|bounds| bounds_have_safe_size(*bounds)) {
                    state.document.bounds = Some(bounds);
                }
            }
            state.generation = state.generation.wrapping_add(1);
            (state.generation, state.document)
        };
        let persistence = self.clone();
        let app = window.app_handle().clone();
        thread::spawn(move || {
            thread::sleep(SAVE_DELAY);
            if let (Ok(path), Ok(state)) = (state_path(&app), persistence.inner.lock()) {
                // Why: keep the generation check and write under one lock so an
                // old debounce cannot overwrite the synchronous exit snapshot.
                if !state.closing && state.generation == generation {
                    let _ = write_state_atomic(&path, document);
                }
            }
        });
    }

    fn freeze_and_save(&self, window: &Window) {
        let maximized = window.is_maximized().unwrap_or(false);
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let bounds = capture_bounds(window);
        let path = state_path(window.app_handle()).ok();
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        if state.closing {
            return;
        }
        state.closing = true;
        state.generation = state.generation.wrapping_add(1);
        if !fullscreen {
            state.document.maximized = maximized;
            if !maximized {
                if let Some(bounds) = bounds.filter(|bounds| bounds_have_safe_size(*bounds)) {
                    state.document.bounds = Some(bounds);
                }
            }
        }
        if let Some(path) = path {
            // Why: serialize the terminal write with debounce writers; shutdown
            // must leave the newest monitor and normal-window geometry durable.
            let _ = write_state_atomic(&path, state.document);
        }
    }
}

#[tauri::command]
pub fn window_prepare_to_close(
    app: tauri::AppHandle,
    window: Window,
    state: State<'_, WindowStatePersistence>,
) {
    // Process exit may bypass the debounced resize write, so confirmed quit
    // flushes the latest normal bounds before the event loop starts teardown.
    state.freeze_and_save(&window);
    // Why: native ExitRequested is guarded by the renderer; confirmation may
    // permit exactly one programmatic exit without weakening later quit guards.
    crate::native_quit::permit_next_exit(&app);
    let _ = crate::commands::native_session_recovery::mark_exit_requested(&app);
}

fn capture_bounds(window: &Window) -> Option<WindowBounds> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale_factor = window.scale_factor().ok()?;
    Some(physical_to_logical_bounds(
        WindowBounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        scale_factor,
    ))
}

fn bounds_have_safe_size(bounds: WindowBounds) -> bool {
    bounds.width > MIN_WIDTH && bounds.height > MIN_HEIGHT
}

fn bounds_are_restorable(bounds: WindowBounds, monitors: &[tauri::Monitor]) -> bool {
    bounds_have_safe_size(bounds)
        && monitors
            .iter()
            .any(|monitor| bounds_overlap(bounds, logical_work_area(monitor)))
}

fn bounds_overlap(bounds: WindowBounds, work_area: WindowBounds) -> bool {
    let right = i64::from(bounds.x) + i64::from(bounds.width);
    let bottom = i64::from(bounds.y) + i64::from(bounds.height);
    let work_right = i64::from(work_area.x) + i64::from(work_area.width);
    let work_bottom = i64::from(work_area.y) + i64::from(work_area.height);
    let overlap_x = (right.min(work_right) - i64::from(bounds.x.max(work_area.x))).max(0);
    let overlap_y = (bottom.min(work_bottom) - i64::from(bounds.y.max(work_area.y))).max(0);
    overlap_x >= i64::from(MIN_WIDTH / 2) && overlap_y >= i64::from(MIN_HEIGHT / 2)
}

fn overlap_area(bounds: WindowBounds, work_area: WindowBounds) -> u64 {
    let right = i64::from(bounds.x) + i64::from(bounds.width);
    let bottom = i64::from(bounds.y) + i64::from(bounds.height);
    let work_right = i64::from(work_area.x) + i64::from(work_area.width);
    let work_bottom = i64::from(work_area.y) + i64::from(work_area.height);
    let width = (right.min(work_right) - i64::from(bounds.x.max(work_area.x))).max(0);
    let height = (bottom.min(work_bottom) - i64::from(bounds.y.max(work_area.y))).max(0);
    (width as u64).saturating_mul(height as u64)
}

fn normalize_persisted_bounds(
    bounds: WindowBounds,
    version: u8,
    monitors: &[tauri::Monitor],
    fallback_scale_factor: f64,
) -> WindowBounds {
    if version >= LOGICAL_BOUNDS_VERSION {
        return bounds;
    }
    // Why: the first Tauri persistence format stored physical pixels. Migrate
    // it once so an existing HiDPI window does not reopen at double its size.
    let scale_factor = monitors
        .iter()
        .max_by_key(|monitor| overlap_area(bounds, physical_work_area(monitor)))
        .map(tauri::Monitor::scale_factor)
        .unwrap_or(fallback_scale_factor);
    physical_to_logical_bounds(bounds, scale_factor)
}

fn restore_logical_bounds(
    window: &tauri::WebviewWindow,
    bounds: WindowBounds,
    monitors: &[tauri::Monitor],
) {
    let monitor = monitors
        .iter()
        .max_by_key(|monitor| overlap_area(bounds, logical_work_area(monitor)));
    let scale_factor = monitor
        .map(tauri::Monitor::scale_factor)
        .or_else(|| window.scale_factor().ok())
        .unwrap_or(1.0);
    let physical = logical_to_physical_bounds(bounds, scale_factor);
    // Tauri reports monitor work areas in physical pixels even though persisted
    // Electron-compatible bounds are logical, so conversion belongs here.
    let _ = window.set_position(PhysicalPosition::new(physical.x, physical.y));
    let _ = window.set_size(PhysicalSize::new(physical.width, physical.height));
}

fn logical_work_area(monitor: &tauri::Monitor) -> WindowBounds {
    physical_to_logical_bounds(physical_work_area(monitor), monitor.scale_factor())
}

fn physical_work_area(monitor: &tauri::Monitor) -> WindowBounds {
    let area = monitor.work_area();
    WindowBounds {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}

fn physical_to_logical_bounds(bounds: WindowBounds, scale_factor: f64) -> WindowBounds {
    convert_bounds_scale(bounds, scale_factor.recip())
}

fn logical_to_physical_bounds(bounds: WindowBounds, scale_factor: f64) -> WindowBounds {
    convert_bounds_scale(bounds, scale_factor)
}

fn convert_bounds_scale(bounds: WindowBounds, multiplier: f64) -> WindowBounds {
    let multiplier = if multiplier.is_finite() && multiplier > 0.0 {
        multiplier
    } else {
        1.0
    };
    WindowBounds {
        x: (f64::from(bounds.x) * multiplier).round() as i32,
        y: (f64::from(bounds.y) * multiplier).round() as i32,
        width: (f64::from(bounds.width) * multiplier).round() as u32,
        height: (f64::from(bounds.height) * multiplier).round() as u32,
    }
}

fn state_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(STATE_FILE_NAME))
        .map_err(|error| error.to_string())
}

fn read_state(path: &Path) -> Option<PersistedWindowState> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_state_atomic(path: &Path, document: PersistedWindowState) -> Result<(), String> {
    let parent = path.parent().ok_or("window state path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: i32, y: i32, width: u32, height: u32) -> WindowBounds {
        WindowBounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn rejects_minimum_and_smaller_bounds() {
        assert!(!bounds_have_safe_size(WindowBounds {
            x: 0,
            y: 0,
            width: 600,
            height: 800
        }));
        assert!(!bounds_have_safe_size(WindowBounds {
            x: 0,
            y: 0,
            width: 900,
            height: 400
        }));
        assert!(bounds_have_safe_size(WindowBounds {
            x: 0,
            y: 0,
            width: 601,
            height: 401
        }));
    }

    #[test]
    fn requires_a_meaningful_visible_area() {
        let display = bounds(0, 0, 1440, 900);
        assert!(bounds_overlap(bounds(1140, 700, 900, 600), display));
        assert!(!bounds_overlap(bounds(1439, 0, 900, 600), display));
        assert!(!bounds_overlap(bounds(0, 899, 900, 600), display));
    }

    #[test]
    fn accepts_restorable_bounds_on_a_negative_coordinate_secondary_display() {
        let secondary = bounds(-1920, 0, 1920, 1080);

        assert!(bounds_overlap(bounds(-1700, 120, 1200, 760), secondary));
        assert!(!bounds_overlap(bounds(200, 120, 1200, 760), secondary));
    }

    #[test]
    fn disconnected_secondary_display_bounds_fail_the_visible_area_gate() {
        let primary = bounds(0, 0, 1512, 982);
        let former_secondary_window = bounds(-1700, 120, 1200, 760);

        assert!(!bounds_overlap(former_secondary_window, primary));
    }

    #[test]
    fn converts_physical_hidpi_bounds_to_electron_compatible_logical_bounds() {
        let physical = bounds(-240, 80, 2560, 1520);

        let logical = physical_to_logical_bounds(physical, 2.0);

        assert_eq!(logical, bounds(-120, 40, 1280, 760));
        assert_eq!(logical_to_physical_bounds(logical, 2.0), physical);
    }

    #[test]
    fn treats_invalid_scale_factors_as_one() {
        let physical = bounds(20, 40, 1200, 800);

        assert_eq!(physical_to_logical_bounds(physical, 0.0), physical);
        assert_eq!(logical_to_physical_bounds(physical, f64::NAN), physical);
    }

    #[test]
    fn round_trips_state_with_atomic_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(STATE_FILE_NAME);
        let document = PersistedWindowState {
            version: LOGICAL_BOUNDS_VERSION,
            bounds: Some(WindowBounds {
                x: -120,
                y: 40,
                width: 1280,
                height: 760,
            }),
            maximized: true,
        };
        write_state_atomic(&path, document).unwrap();
        assert_eq!(read_state(&path), Some(document));
        assert!(!path.with_extension("json.tmp").exists());
    }
}
