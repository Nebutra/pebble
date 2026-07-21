pub const Code = enum(c_int) {
    ok = 0,
    invalid_argument = 1,
    not_found = 2,
    access_denied = 3,
    unsupported_platform = 4,
    spawn_failed = 5,
    wait_failed = 6,
    io_failed = 7,
    no_memory = 8,
    buffer_too_small = 9,
    process_running = 10,
    bad_handle = 11,
    signal_failed = 12,
    unknown = 255,
};

pub fn toInt(code: Code) c_int {
    return @intFromEnum(code);
}

pub fn fromError(err: anyerror) Code {
    return switch (err) {
        error.InvalidArgument => .invalid_argument,
        error.FileNotFound => .not_found,
        error.AccessDenied => .access_denied,
        error.PermissionDenied => .access_denied,
        error.UnsupportedPlatform => .unsupported_platform,
        error.SpawnFailed => .spawn_failed,
        error.WaitFailed => .wait_failed,
        error.IoFailed => .io_failed,
        error.OutOfMemory => .no_memory,
        error.ProcessRunning => .process_running,
        error.BadHandle => .bad_handle,
        error.SignalFailed => .signal_failed,
        else => .unknown,
    };
}

pub fn message(code: c_int) [*:0]const u8 {
    return switch (code) {
        toInt(.ok) => "ok",
        toInt(.invalid_argument) => "invalid argument",
        toInt(.not_found) => "not found",
        toInt(.access_denied) => "access denied",
        toInt(.unsupported_platform) => "unsupported platform",
        toInt(.spawn_failed) => "spawn failed",
        toInt(.wait_failed) => "wait failed",
        toInt(.io_failed) => "i/o failed",
        toInt(.no_memory) => "out of memory",
        toInt(.buffer_too_small) => "buffer too small",
        toInt(.process_running) => "process still running",
        toInt(.bad_handle) => "bad handle",
        toInt(.signal_failed) => "signal failed",
        else => "unknown error",
    };
}

test "status messages are stable C strings" {
    try @import("std").testing.expect(message(toInt(.ok))[0] == 'o');
    try @import("std").testing.expect(message(999)[0] == 'u');
}
