const builtin = @import("builtin");
const std = @import("std");

pub const hangup: c_int = 1;
pub const interrupt: c_int = 2;
pub const terminate: c_int = 15;

extern "c" fn kill(pid: c_int, sig: c_int) c_int;

pub fn sendPid(pid: u64, sig: c_int) !void {
    if (pid == 0 or sig < 0) return error.InvalidArgument;

    return switch (builtin.os.tag) {
        .windows => error.UnsupportedPlatform,
        else => sendPidPosix(pid, sig),
    };
}

fn sendPidPosix(pid: u64, sig: c_int) !void {
    if (pid > std.math.maxInt(c_int)) return error.InvalidArgument;

    const result = kill(@as(c_int, @intCast(pid)), sig);
    if (result != 0) return error.SignalFailed;
}

test "zero pid is rejected before platform calls" {
    try std.testing.expectError(error.InvalidArgument, sendPid(0, interrupt));
}

test "negative signal is rejected before platform calls" {
    try std.testing.expectError(error.InvalidArgument, sendPid(1, -1));
}
