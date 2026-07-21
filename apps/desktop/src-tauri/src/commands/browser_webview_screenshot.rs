use std::io::Cursor;

use super::{BrowserScreenshotCrop, BrowserScreenshotFormat};

pub(super) fn validate_screenshot_crop(
    crop: Option<BrowserScreenshotCrop>,
) -> Result<Option<BrowserScreenshotCrop>, String> {
    let Some(crop) = crop else {
        return Ok(None);
    };
    if !crop.x.is_finite()
        || !crop.y.is_finite()
        || !crop.width.is_finite()
        || !crop.height.is_finite()
        || crop.x < 0.0
        || crop.y < 0.0
        || crop.width <= 0.0
        || crop.height <= 0.0
        || crop.width > 100_000.0
        || crop.height > 100_000.0
    {
        return Err("invalid browser screenshot crop".to_string());
    }
    Ok(Some(crop))
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_platform_webview(
    platform_webview: tauri::webview::PlatformWebview,
    format: BrowserScreenshotFormat,
    crop: Option<BrowserScreenshotCrop>,
    _device_scale_factor: f64,
) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey, NSView};
    use objc2_foundation::NSDictionary;

    let pointer = platform_webview.inner();
    if pointer.is_null() {
        return Err("browser WKWebView pointer is null".to_string());
    }
    // Tauri invokes this on the AppKit thread with a live WKWebView, which is
    // an NSView subclass; retaining it outside this callback would be unsafe.
    let view = unsafe { &*(pointer as *const NSView) };
    let bounds = view.bounds();
    let bitmap = view
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .ok_or_else(|| "browser WebView could not allocate a bitmap".to_string())?;
    view.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    let storage_type = match format {
        BrowserScreenshotFormat::Png => NSBitmapImageFileType::PNG,
        BrowserScreenshotFormat::Jpeg => NSBitmapImageFileType::JPEG,
    };
    let data = unsafe { bitmap.representationUsingType_properties(storage_type, &properties) }
        .ok_or_else(|| "browser WebView bitmap encoding failed".to_string())?;
    let length = data.length();
    let mut bytes = vec![0_u8; length];
    if length > 0 {
        let destination = NonNull::new(bytes.as_mut_ptr().cast::<c_void>())
            .ok_or_else(|| "browser screenshot buffer allocation failed".to_string())?;
        unsafe { data.getBytes_length(destination, length) };
    }
    crop_image(bytes, format, crop, bounds.size.width, bounds.size.height)
}

#[cfg(target_os = "windows")]
pub(crate) fn capture_platform_webview(
    platform_webview: tauri::webview::PlatformWebview,
    format: BrowserScreenshotFormat,
    crop: Option<BrowserScreenshotCrop>,
    device_scale_factor: f64,
) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;

    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let controller = platform_webview.controller();
    let webview = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
    let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }
        .map_err(|error| error.to_string())?;
    let callback_stream = stream.clone();
    let (sender, receiver) = mpsc::channel();
    let image_format = match format {
        BrowserScreenshotFormat::Png => COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
        BrowserScreenshotFormat::Jpeg => COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
    };
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        let captured = result
            .map_err(|error| error.to_string())
            .and_then(|_| read_windows_stream(&callback_stream));
        let _ = sender.send(captured);
        Ok(())
    }));
    unsafe { webview.CapturePreview(image_format, &stream, &handler) }
        .map_err(|error| error.to_string())?;
    let bytes = webview2_com::wait_with_pump(receiver).map_err(|error| error.to_string())??;
    // WebView2 CapturePreview returns physical pixels while grab geometry is
    // expressed in CSS pixels by the shared renderer.
    crop_image_with_scale(
        bytes,
        format,
        crop,
        device_scale_factor,
        device_scale_factor,
    )
}

#[cfg(target_os = "windows")]
fn read_windows_stream(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::{STATFLAG_NONAME, STREAM_SEEK_SET};

    let mut stat = std::mem::MaybeUninit::zeroed();
    unsafe { stream.Stat(stat.as_mut_ptr(), STATFLAG_NONAME) }
        .map_err(|error| error.to_string())?;
    let stat = unsafe { stat.assume_init() };
    let length = usize::try_from(stat.cbSize)
        .map_err(|_| "browser screenshot stream is too large".to_string())?;
    let mut bytes = vec![0_u8; length];
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }.map_err(|error| error.to_string())?;
    let mut read = 0_u32;
    let read_length = u32::try_from(length)
        .map_err(|_| "browser screenshot stream exceeds WebView2 limits".to_string())?;
    unsafe { stream.Read(bytes.as_mut_ptr().cast(), read_length, Some(&mut read)) }
        .ok()
        .map_err(|error| error.to_string())?;
    bytes.truncate(read as usize);
    Ok(bytes)
}

#[cfg(target_os = "linux")]
pub(crate) fn capture_platform_webview(
    platform_webview: tauri::webview::PlatformWebview,
    format: BrowserScreenshotFormat,
    crop: Option<BrowserScreenshotCrop>,
    device_scale_factor: f64,
) -> Result<Vec<u8>, String> {
    use std::cell::{Cell, RefCell};
    use std::convert::TryFrom;
    use std::rc::Rc;
    use std::sync::mpsc;
    use std::time::Duration;

    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    let webview = platform_webview.inner();
    let main_loop = glib::MainLoop::new(None, false);
    let completion_loop = main_loop.clone();
    let (sender, receiver) = mpsc::channel();
    let sender = Rc::new(RefCell::new(Some(sender)));
    let snapshot_sender = sender.clone();
    let completed = Rc::new(Cell::new(false));
    let snapshot_completed = completed.clone();
    webview.snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&gio::Cancellable>,
        move |result| {
            let snapshot = result
                .map_err(|error| error.to_string())
                .and_then(|surface| {
                    cairo::ImageSurface::try_from(surface).map_err(|error| error.to_string())
                })
                .and_then(|surface| {
                    let mut png = Vec::new();
                    surface
                        .write_to_png(&mut png)
                        .map_err(|error| error.to_string())?;
                    Ok(png)
                });
            snapshot_completed.set(true);
            if let Some(sender) = snapshot_sender.borrow_mut().take() {
                let _ = sender.send(snapshot);
            }
            completion_loop.quit();
        },
    );
    let timeout_loop = main_loop.clone();
    glib::timeout_add_local_once(Duration::from_secs(10), move || {
        if let Some(sender) = sender.borrow_mut().take() {
            let _ = sender.send(Err("browser WebKitGTK snapshot timed out".to_string()));
        }
        timeout_loop.quit();
    });
    if !completed.get() {
        main_loop.run();
    }
    let png = receiver
        .recv()
        .map_err(|_| "browser WebKitGTK snapshot callback was dropped".to_string())??;
    let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .map_err(|error| format!("browser screenshot decode failed: {error}"))?;
    encode_dynamic_image(
        decoded,
        format,
        crop,
        device_scale_factor,
        device_scale_factor,
    )
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) fn capture_platform_webview(
    _platform_webview: tauri::webview::PlatformWebview,
    _format: BrowserScreenshotFormat,
    _crop: Option<BrowserScreenshotCrop>,
    _device_scale_factor: f64,
) -> Result<Vec<u8>, String> {
    Err("native browser screenshot capture is not available on this platform yet".to_string())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn crop_image(
    bytes: Vec<u8>,
    format: BrowserScreenshotFormat,
    crop: Option<BrowserScreenshotCrop>,
    css_width: f64,
    css_height: f64,
) -> Result<Vec<u8>, String> {
    let Some(crop) = crop else {
        return Ok(bytes);
    };
    if css_width <= 0.0 || css_height <= 0.0 {
        return Err("browser WebView has invalid capture bounds".to_string());
    }
    let decoded = decode_image(&bytes, format)?;
    let scale_x = f64::from(decoded.width()) / css_width;
    let scale_y = f64::from(decoded.height()) / css_height;
    encode_cropped_image(decoded, format, crop, scale_x, scale_y)
}

#[cfg(target_os = "windows")]
fn crop_image_with_scale(
    bytes: Vec<u8>,
    format: BrowserScreenshotFormat,
    crop: Option<BrowserScreenshotCrop>,
    scale_x: f64,
    scale_y: f64,
) -> Result<Vec<u8>, String> {
    let Some(crop) = crop else {
        return Ok(bytes);
    };
    let decoded = decode_image(&bytes, format)?;
    encode_cropped_image(decoded, format, crop, scale_x, scale_y)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn decode_image(
    bytes: &[u8],
    format: BrowserScreenshotFormat,
) -> Result<image::DynamicImage, String> {
    let image_format = match format {
        BrowserScreenshotFormat::Png => image::ImageFormat::Png,
        BrowserScreenshotFormat::Jpeg => image::ImageFormat::Jpeg,
    };
    image::load_from_memory_with_format(bytes, image_format)
        .map_err(|error| format!("browser screenshot decode failed: {error}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn encode_cropped_image(
    decoded: image::DynamicImage,
    format: BrowserScreenshotFormat,
    crop: BrowserScreenshotCrop,
    scale_x: f64,
    scale_y: f64,
) -> Result<Vec<u8>, String> {
    let crop_x = (crop.x * scale_x).round() as u32;
    let crop_y = (crop.y * scale_y).round() as u32;
    if crop_x >= decoded.width() || crop_y >= decoded.height() {
        return Err("browser screenshot crop falls outside the WebView".to_string());
    }
    let crop_width = ((crop.width * scale_x).round().max(1.0) as u32).min(decoded.width() - crop_x);
    let crop_height =
        ((crop.height * scale_y).round().max(1.0) as u32).min(decoded.height() - crop_y);
    let cropped = decoded.crop_imm(crop_x, crop_y, crop_width, crop_height);
    let mut output = Cursor::new(Vec::new());
    let image_format = match format {
        BrowserScreenshotFormat::Png => image::ImageFormat::Png,
        BrowserScreenshotFormat::Jpeg => image::ImageFormat::Jpeg,
    };
    cropped
        .write_to(&mut output, image_format)
        .map_err(|error| format!("browser screenshot crop encoding failed: {error}"))?;
    Ok(output.into_inner())
}

#[cfg(target_os = "linux")]
fn encode_dynamic_image(
    decoded: image::DynamicImage,
    format: BrowserScreenshotFormat,
    crop: Option<BrowserScreenshotCrop>,
    scale_x: f64,
    scale_y: f64,
) -> Result<Vec<u8>, String> {
    let image = if let Some(crop) = crop {
        let crop_x = (crop.x * scale_x).round() as u32;
        let crop_y = (crop.y * scale_y).round() as u32;
        if crop_x >= decoded.width() || crop_y >= decoded.height() {
            return Err("browser screenshot crop falls outside the WebView".to_string());
        }
        let crop_width =
            ((crop.width * scale_x).round().max(1.0) as u32).min(decoded.width() - crop_x);
        let crop_height =
            ((crop.height * scale_y).round().max(1.0) as u32).min(decoded.height() - crop_y);
        decoded.crop_imm(crop_x, crop_y, crop_width, crop_height)
    } else {
        decoded
    };
    let image_format = match format {
        BrowserScreenshotFormat::Png => image::ImageFormat::Png,
        BrowserScreenshotFormat::Jpeg => image::ImageFormat::Jpeg,
    };
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, image_format)
        .map_err(|error| format!("browser screenshot encoding failed: {error}"))?;
    Ok(output.into_inner())
}
