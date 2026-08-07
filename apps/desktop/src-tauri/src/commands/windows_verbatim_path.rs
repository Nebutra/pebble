/// Strips Windows verbatim (`\\?\`) prefixes from a canonicalized path string.
///
/// Why: `fs::canonicalize` returns verbatim paths on Windows, where the volume
/// reads as `\\?\C:` rather than `C:`. These strings leave Rust as `CODEX_HOME`
/// / `CLAUDE_CONFIG_DIR` and as the captive-login PTY's cwd, and the consumers
/// downstream — Go's `filepath.Rel`, the Windows process working directory —
/// read the verbatim volume as a different drive, so the managed login lane
/// fails on Windows only.
pub fn strip_verbatim_prefix(path: &str) -> String {
    // `\\?\UNC\server\share` denotes `\\server\share`; dropping only the `\\?\`
    // would leave `UNC\server\share`, which names nothing.
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    match path.strip_prefix(r"\\?\") {
        // A bare `\\?\` prefix with nothing after it is not a path; leave the
        // input untouched rather than returning an empty string.
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_verbatim_drive_prefix() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\u\AppData\Roaming\pebble"),
            r"C:\Users\u\AppData\Roaming\pebble"
        );
    }

    #[test]
    fn rewrites_a_verbatim_unc_prefix_to_a_plain_share() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\codex"),
            r"\\server\share\codex"
        );
    }

    #[test]
    fn leaves_non_verbatim_paths_untouched() {
        assert_eq!(strip_verbatim_prefix(r"C:\Users\u"), r"C:\Users\u");
        assert_eq!(
            strip_verbatim_prefix("/Users/u/Library/Application Support/pebble"),
            "/Users/u/Library/Application Support/pebble"
        );
        assert_eq!(strip_verbatim_prefix(r"\\server\share"), r"\\server\share");
    }

    #[test]
    fn leaves_a_bare_verbatim_prefix_untouched() {
        assert_eq!(strip_verbatim_prefix(r"\\?\"), r"\\?\");
    }
}
