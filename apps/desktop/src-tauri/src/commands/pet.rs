use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPet {
    id: String,
    label: String,
    file_name: String,
    mime_type: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    sprite: Option<PetSprite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sprite_fps: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetSprite {
    frame_width: u32,
    frame_height: u32,
    columns: u32,
    rows: u32,
    sheet_width: u32,
    sheet_height: u32,
    fps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_animation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    animations: Option<HashMap<String, PetAnimation>>,
}

#[derive(Clone, Deserialize, Serialize)]
struct PetAnimation {
    row: u32,
    frames: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetManifest {
    id: Option<String>,
    display_name: Option<String>,
    spritesheet_path: Option<String>,
    frame: Option<PetFrame>,
    fps: Option<f64>,
    default_animation: Option<String>,
    animations: Option<HashMap<String, PetAnimation>>,
}

#[derive(Clone, Deserialize)]
struct PetFrame {
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetFileInput {
    id: String,
    file_name: String,
    kind: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetReadResult {
    content_base64: String,
}

#[tauri::command]
pub async fn pet_import(app: AppHandle) -> Result<Option<CustomPet>, String> {
    let Some(source) = rfd::FileDialog::new()
        .add_filter("Pet image", &["png", "jpg", "jpeg", "gif", "webp", "svg"])
        .pick_file()
    else {
        return Ok(None);
    };
    let root = pets_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || import_image(&source, &root))
        .await
        .map_err(|error| format!("pet import task failed: {error}"))?
        .map(Some)
}

#[tauri::command]
pub async fn pet_import_bundle(app: AppHandle) -> Result<Option<CustomPet>, String> {
    let Some(source) = rfd::FileDialog::new()
        .set_title("Pick a .codex-pet bundle")
        .pick_folder()
    else {
        return Ok(None);
    };
    let root = pets_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || import_bundle(&source, &root))
        .await
        .map_err(|error| format!("pet bundle import task failed: {error}"))?
        .map(Some)
}

#[tauri::command]
pub async fn pet_read(
    app: AppHandle,
    input: PetFileInput,
) -> Result<Option<PetReadResult>, String> {
    let root = pets_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = resolve_pet_file(&root, &input)? else {
            return Ok(None);
        };
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("pet file exceeds the size limit".to_string());
        }
        Ok(Some(PetReadResult {
            content_base64: BASE64_STANDARD.encode(bytes),
        }))
    })
    .await
    .map_err(|error| format!("pet read task failed: {error}"))?
}

#[tauri::command]
pub async fn pet_delete(app: AppHandle, input: PetFileInput) -> Result<(), String> {
    let root = pets_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !is_uuid(&input.id) {
            return Ok(());
        }
        if input.kind.as_deref() == Some("bundle") {
            let target = root.join(&input.id);
            if target.starts_with(&root) {
                let _ = fs::remove_dir_all(target);
            }
            return Ok(());
        }
        if let Some(path) = resolve_pet_file(&root, &input)? {
            let _ = fs::remove_file(path);
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("pet delete task failed: {error}"))?
}

fn import_image(source: &Path, root: &Path) -> Result<CustomPet, String> {
    reject_symlink_or_large_file(source, MAX_FILE_BYTES)?;
    let (extension, mime_type) = classify_image(source, true)?;
    fs::create_dir_all(root).map_err(file_error)?;
    let id = Uuid::new_v4().to_string();
    let file_name = format!("{id}{extension}");
    let destination = root.join(&file_name);
    fs::copy(source, &destination).map_err(file_error)?;
    Ok(CustomPet {
        id,
        label: bounded_label(
            source.file_stem().and_then(|value| value.to_str()),
            "Custom pet",
        ),
        file_name,
        mime_type,
        kind: "image",
        sprite: None,
        sprite_fps: None,
    })
}

fn import_bundle(source: &Path, root: &Path) -> Result<CustomPet, String> {
    let manifest_path = source.join("pet.json");
    reject_symlink_or_large_file(&manifest_path, MAX_MANIFEST_BYTES)?;
    let raw = fs::read_to_string(&manifest_path).map_err(file_error)?;
    if raw.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("pet.json is invalid".to_string());
    }
    let mut manifest: PetManifest =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid pet.json: {error}"))?;
    apply_bundle_defaults(&mut manifest);
    validate_manifest(&manifest)?;
    let normalized_sprite_path = manifest
        .spritesheet_path
        .as_deref()
        .unwrap_or("spritesheet.webp")
        .replace('\\', "/");
    let relative = safe_relative_path(&normalized_sprite_path)?;
    let sheet = source.join(relative);
    let canonical_source = source.canonicalize().map_err(file_error)?;
    let canonical_sheet = sheet.canonicalize().map_err(file_error)?;
    if !canonical_sheet.starts_with(&canonical_source) {
        return Err("spritesheetPath escapes the bundle".to_string());
    }
    reject_symlink_or_large_file(&sheet, MAX_FILE_BYTES)?;
    let (extension, mime_type) = classify_image(&sheet, false)?;
    let bytes = fs::read(&sheet).map_err(file_error)?;
    let sprite = validate_sprite(&bytes, &manifest)?;
    fs::create_dir_all(root).map_err(file_error)?;
    let id = Uuid::new_v4().to_string();
    let destination = root.join(&id);
    let temporary = root.join(format!("{id}.tmp"));
    let _ = fs::remove_dir_all(&temporary);
    fs::create_dir(&temporary).map_err(file_error)?;
    let file_name = format!("spritesheet{extension}");
    let result = (|| {
        fs::write(temporary.join(&file_name), bytes).map_err(file_error)?;
        fs::write(temporary.join("pet.json"), raw).map_err(file_error)?;
        fs::rename(&temporary, &destination).map_err(file_error)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result?;
    Ok(CustomPet {
        id,
        label: bounded_label(
            manifest
                .display_name
                .as_deref()
                .or(manifest.id.as_deref())
                .or_else(|| source.file_name().and_then(|value| value.to_str())),
            "Pet bundle",
        ),
        file_name,
        mime_type,
        kind: "bundle",
        sprite,
        sprite_fps: manifest.fps,
    })
}

fn validate_sprite(bytes: &[u8], manifest: &PetManifest) -> Result<Option<PetSprite>, String> {
    let Some(frame) = manifest.frame.as_ref() else {
        return Ok(None);
    };
    let image = image::load_from_memory(bytes)
        .map_err(|_| "Could not decode the spritesheet image".to_string())?;
    let (width, height) = image.dimensions();
    if width % frame.width != 0 || height % frame.height != 0 {
        return Err("spritesheet is not a clean frame multiple".to_string());
    }
    let columns = width / frame.width;
    let rows = height / frame.height;
    if let Some(animations) = manifest.animations.as_ref() {
        for (name, animation) in animations {
            if animation.row >= rows || animation.frames == 0 || animation.frames > columns {
                return Err(format!("Animation \"{name}\" exceeds the spritesheet"));
            }
        }
        if manifest
            .default_animation
            .as_ref()
            .is_some_and(|name| !animations.contains_key(name))
        {
            return Err("defaultAnimation is missing from animations".to_string());
        }
    }
    Ok(Some(PetSprite {
        frame_width: frame.width,
        frame_height: frame.height,
        columns,
        rows,
        sheet_width: width,
        sheet_height: height,
        fps: manifest.fps.unwrap_or(8.0),
        default_animation: manifest.default_animation.clone(),
        animations: manifest.animations.clone(),
    }))
}

fn apply_bundle_defaults(manifest: &mut PetManifest) {
    let codex_layout = manifest
        .spritesheet_path
        .as_deref()
        .is_none_or(|path| path.ends_with("spritesheet.webp"))
        && manifest.frame.is_none()
        && manifest.animations.is_none();
    manifest
        .spritesheet_path
        .get_or_insert_with(|| "spritesheet.webp".to_string());
    if !codex_layout {
        return;
    }
    manifest.frame = Some(PetFrame {
        width: 192,
        height: 208,
    });
    manifest.fps.get_or_insert(8.0);
    manifest
        .default_animation
        .get_or_insert_with(|| "idle".to_string());
    manifest.animations = Some(HashMap::from([
        ("idle".to_string(), PetAnimation { row: 0, frames: 6 }),
        (
            "running-right".to_string(),
            PetAnimation { row: 1, frames: 8 },
        ),
        (
            "running-left".to_string(),
            PetAnimation { row: 2, frames: 8 },
        ),
        ("waving".to_string(), PetAnimation { row: 3, frames: 4 }),
        ("jumping".to_string(), PetAnimation { row: 4, frames: 5 }),
        ("failed".to_string(), PetAnimation { row: 5, frames: 8 }),
        ("waiting".to_string(), PetAnimation { row: 6, frames: 6 }),
        ("running".to_string(), PetAnimation { row: 7, frames: 6 }),
        ("review".to_string(), PetAnimation { row: 8, frames: 6 }),
    ]));
}

fn validate_manifest(manifest: &PetManifest) -> Result<(), String> {
    if manifest
        .display_name
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.chars().count() > 120)
    {
        return Err("displayName is invalid".to_string());
    }
    if manifest
        .fps
        .is_some_and(|fps| !fps.is_finite() || fps <= 0.0 || fps > 60.0)
    {
        return Err("fps is invalid".to_string());
    }
    if manifest.frame.as_ref().is_some_and(|frame| {
        frame.width == 0 || frame.height == 0 || frame.width > 1024 || frame.height > 1024
    }) {
        return Err("frame is invalid".to_string());
    }
    if manifest
        .animations
        .as_ref()
        .is_some_and(|items| items.len() > 256)
    {
        return Err("too many animations".to_string());
    }
    Ok(())
}

fn resolve_pet_file(root: &Path, input: &PetFileInput) -> Result<Option<PathBuf>, String> {
    if !is_uuid(&input.id) {
        return Ok(None);
    }
    let name = Path::new(&input.file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid pet file name".to_string())?;
    if name != input.file_name {
        return Ok(None);
    }
    if input.kind.as_deref() == Some("bundle") {
        return Ok(Some(root.join(&input.id).join(name)));
    }
    if !name.starts_with(&format!("{}.", input.id)) {
        return Ok(None);
    }
    Ok(Some(root.join(name)))
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || value.contains('\0')
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("spritesheetPath must stay inside the bundle".to_string());
    }
    Ok(path.to_path_buf())
}

fn reject_symlink_or_large_file(path: &Path, max: u64) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(file_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("selected pet resource must be a regular file".to_string());
    }
    if metadata.len() > max {
        return Err("selected pet resource is too large".to_string());
    }
    Ok(())
}

fn classify_image(path: &Path, allow_svg: bool) -> Result<(String, String), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" | "apng" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" if allow_svg => "image/svg+xml",
        _ => return Err("Unsupported pet image format".to_string()),
    };
    Ok((format!(".{extension}"), mime.to_string()))
}

fn pets_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("sidekicks").join("custom"))
        .map_err(|error| error.to_string())
}

fn bounded_label(value: Option<&str>, fallback: &str) -> String {
    let value = value.unwrap_or("").trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.chars().take(40).collect()
    }
}

fn is_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}
fn file_error(error: std::io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_and_reads_a_bounded_image() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("pixel.png");
        fs::write(&source, b"png bytes").unwrap();
        let root = temp.path().join("pets");
        let pet = import_image(&source, &root).unwrap();
        assert_eq!(pet.mime_type, "image/png");
        assert!(root.join(&pet.file_name).is_file());
        assert!(resolve_pet_file(
            &root,
            &PetFileInput {
                id: pet.id,
                file_name: pet.file_name,
                kind: None
            }
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn rejects_bundle_path_escape() {
        assert!(safe_relative_path("../secret.png").is_err());
        assert!(safe_relative_path("spritesheet.webp").is_ok());
    }

    #[test]
    fn imports_a_valid_sprite_bundle_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = temp.path().join("pixel.codex-pet");
        fs::create_dir(&bundle).unwrap();
        image::RgbaImage::new(2, 1)
            .save(bundle.join("sheet.png"))
            .unwrap();
        fs::write(
            bundle.join("pet.json"),
            r#"{
              "displayName": "Pixel",
              "spritesheetPath": "sheet.png",
              "frame": { "width": 1, "height": 1 },
              "fps": 12,
              "defaultAnimation": "idle",
              "animations": { "idle": { "row": 0, "frames": 2 } }
            }"#,
        )
        .unwrap();
        let root = temp.path().join("pets");

        let pet = import_bundle(&bundle, &root).unwrap();

        assert_eq!(pet.label, "Pixel");
        assert_eq!(pet.sprite.as_ref().unwrap().columns, 2);
        assert!(root.join(&pet.id).join("spritesheet.png").is_file());
        assert!(!root.join(format!("{}.tmp", pet.id)).exists());
    }
}
