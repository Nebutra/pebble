use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

const MAX_SEGMENTS: usize = 100;
const MAX_PAGE_CSS_PIXELS: f64 = 100_000.0;
const MAX_ENCODED_SEGMENT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFullPageSegment {
    data_base64: String,
    y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFullPageScreenshotInput {
    format: String,
    viewport_width: f64,
    page_height: f64,
    segments: Vec<BrowserFullPageSegment>,
}

#[derive(Debug, Serialize)]
pub struct BrowserFullPageScreenshotResult {
    data: String,
    format: String,
}

#[tauri::command]
pub async fn browser_stitch_full_page_screenshot(
    input: BrowserFullPageScreenshotInput,
) -> Result<BrowserFullPageScreenshotResult, String> {
    tauri::async_runtime::spawn_blocking(move || stitch_full_page_screenshot(input))
        .await
        .map_err(|error| format!("browser screenshot stitch task failed: {error}"))?
}

fn stitch_full_page_screenshot(
    input: BrowserFullPageScreenshotInput,
) -> Result<BrowserFullPageScreenshotResult, String> {
    if !input.viewport_width.is_finite()
        || !input.page_height.is_finite()
        || input.viewport_width <= 0.0
        || input.page_height <= 0.0
        || input.viewport_width > MAX_PAGE_CSS_PIXELS
        || input.page_height > MAX_PAGE_CSS_PIXELS
        || input.segments.is_empty()
        || input.segments.len() > MAX_SEGMENTS
    {
        return Err("invalid full-page screenshot geometry".to_string());
    }
    let format = match input.format.as_str() {
        "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        _ => return Err("invalid full-page screenshot format".to_string()),
    };
    let mut decoded = Vec::with_capacity(input.segments.len());
    for segment in &input.segments {
        if !segment.y.is_finite()
            || segment.y < 0.0
            || segment.data_base64.len() > MAX_ENCODED_SEGMENT_BYTES
        {
            return Err("invalid full-page screenshot segment".to_string());
        }
        let bytes = BASE64_STANDARD
            .decode(&segment.data_base64)
            .map_err(|error| format!("full-page screenshot segment decode failed: {error}"))?;
        decoded.push(
            image::load_from_memory_with_format(&bytes, format)
                .map_err(|error| format!("full-page screenshot image decode failed: {error}"))?,
        );
    }
    let first = decoded
        .first()
        .ok_or_else(|| "missing screenshot segment".to_string())?;
    let scale = f64::from(first.width()) / input.viewport_width;
    if !scale.is_finite() || !(0.25..=8.0).contains(&scale) {
        return Err("invalid full-page screenshot scale".to_string());
    }
    let output_height = (input.page_height * scale).ceil() as u32;
    let mut output = RgbaImage::new(first.width(), output_height);
    for (segment, image) in input.segments.iter().zip(decoded.iter()) {
        if image.width() != first.width() {
            return Err("full-page screenshot segment widths differ".to_string());
        }
        let y = (segment.y * scale).round() as i64;
        image::imageops::overlay(&mut output, &image.to_rgba8(), 0, y);
    }
    let mut bytes = Vec::new();
    DynamicImage::ImageRgba8(output)
        .write_to(&mut Cursor::new(&mut bytes), format)
        .map_err(|error| format!("full-page screenshot encode failed: {error}"))?;
    Ok(BrowserFullPageScreenshotResult {
        data: BASE64_STANDARD.encode(bytes),
        format: input.format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    fn segment(color: [u8; 4], y: f64) -> BrowserFullPageSegment {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, image::Rgba(color)));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        BrowserFullPageSegment {
            data_base64: BASE64_STANDARD.encode(bytes),
            y,
        }
    }

    #[test]
    fn stitches_segments_at_css_offsets() {
        let result = stitch_full_page_screenshot(BrowserFullPageScreenshotInput {
            format: "png".to_string(),
            viewport_width: 2.0,
            page_height: 4.0,
            segments: vec![
                segment([255, 0, 0, 255], 0.0),
                segment([0, 0, 255, 255], 2.0),
            ],
        })
        .unwrap();
        let bytes = BASE64_STANDARD.decode(result.data).unwrap();
        let image = image::load_from_memory_with_format(&bytes, ImageFormat::Png).unwrap();
        assert_eq!(image.dimensions(), (2, 4));
        assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(image.get_pixel(0, 3).0, [0, 0, 255, 255]);
    }
}
