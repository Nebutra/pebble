use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    build_zig_system();
    configure_local_speech_runtime_paths();
    tauri_build::build();
}

fn configure_local_speech_runtime_paths() {
    if env::var_os("CARGO_FEATURE_LOCAL_SPEECH").is_none() {
        return;
    }
    // Why: sherpa-rs ships shared ONNX/Sherpa libraries beside the executable;
    // direct dev launches and packaged apps must resolve them without DYLD_LIBRARY_PATH.
    if cfg!(target_os = "macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../Frameworks");
    } else if cfg!(target_os = "linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
    }
}

fn build_zig_system() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let zig_root = manifest_dir.join("../../../native/zig-system");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("out dir"));
    let target = env::var("TARGET").expect("cargo target");
    println!(
        "cargo:rerun-if-changed={}",
        zig_root.join("build.zig").display()
    );
    println!("cargo:rerun-if-changed={}", zig_root.join("src").display());
    println!(
        "cargo:rerun-if-changed={}",
        zig_root.join("include").display()
    );

    let library_dir = if target == "universal-apple-darwin" {
        build_universal_macos_library(&zig_root, &out_dir)
    } else {
        build_zig_target(&zig_root, &out_dir.join("zig-system"), zig_target(&target))
    };
    println!("cargo:rustc-link-search=native={}", library_dir.display());
    println!("cargo:rustc-link-lib=static=pebble_system");
    if target.contains("linux") {
        println!("cargo:rustc-link-lib=util");
    }
}

fn build_universal_macos_library(zig_root: &Path, out_dir: &Path) -> PathBuf {
    let arm = build_zig_target(zig_root, &out_dir.join("zig-arm64"), "aarch64-macos");
    let x64 = build_zig_target(zig_root, &out_dir.join("zig-x64"), "x86_64-macos");
    let universal = out_dir.join("zig-universal/lib");
    std::fs::create_dir_all(&universal).expect("create universal Zig output directory");
    let output = universal.join("libpebble_system.a");
    run(
        Command::new("lipo")
            .arg("-create")
            .arg(arm.join("libpebble_system.a"))
            .arg(x64.join("libpebble_system.a"))
            .arg("-output")
            .arg(&output),
        "combine universal Zig system library",
    );
    universal
}

fn build_zig_target(zig_root: &Path, prefix: &Path, target: &str) -> PathBuf {
    run(
        Command::new("zig")
            .current_dir(zig_root)
            .arg("build")
            .arg("-Doptimize=ReleaseSafe")
            .arg("-Dstatic-only=true")
            .arg(format!("-Dtarget={target}"))
            .arg("--prefix")
            .arg(prefix),
        "build Zig system library",
    );
    prefix.join("lib")
}

fn zig_target(cargo_target: &str) -> &str {
    match cargo_target {
        "aarch64-apple-darwin" => "aarch64-macos",
        "x86_64-apple-darwin" => "x86_64-macos",
        "aarch64-unknown-linux-gnu" => "aarch64-linux-gnu",
        "x86_64-unknown-linux-gnu" => "x86_64-linux-gnu",
        "x86_64-pc-windows-msvc" => "x86_64-windows-msvc",
        "x86_64-pc-windows-gnu" => "x86_64-windows-gnu",
        other => panic!("unsupported Zig system target: {other}"),
    }
}

fn run(command: &mut Command, description: &str) {
    let status = command
        .status()
        .unwrap_or_else(|error| panic!("failed to {description}: {error}"));
    assert!(status.success(), "failed to {description}: {status}");
}
