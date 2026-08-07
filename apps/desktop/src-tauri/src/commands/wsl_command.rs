use std::process::{Command, Stdio};

/// Builds a `wsl.exe` command that neither inherits the parent's stdio nor
/// flashes a console window.
///
/// Why: the managed account lanes drive `bash -lc` scripts through WSL. A login
/// shell can read stdin, so an inherited handle lets the child block forever
/// behind a prompt the user cannot see — the managed Codex/Claude login then
/// hangs instead of failing. `CREATE_NO_WINDOW` keeps the same spawns from
/// flashing a console over the app.
pub fn wsl_command<I, S>(args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new("wsl.exe");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW
        command.creation_flags(0x08000000);
    }

    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_arguments_through_to_wsl() {
        let command = wsl_command(["-d", "Ubuntu", "--", "bash", "-lc", "true"]);

        assert_eq!(command.get_program(), "wsl.exe");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-d", "Ubuntu", "--", "bash", "-lc", "true"]
        );
    }
}
