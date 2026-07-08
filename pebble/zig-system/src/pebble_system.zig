const std = @import("std");

const abi = @import("abi.zig");
const process = @import("process.zig");
const pty = @import("pty.zig");
const signal = @import("signal.zig");
const status = @import("status.zig");

pub const ProcessStart = abi.ProcessStart;
pub const ProcessHandle = abi.ProcessHandle;
pub const ProcessExit = abi.ProcessExit;
pub const PtyStart = abi.PtyStart;
pub const PtyHandle = abi.PtyHandle;
pub const PtySize = abi.PtySize;
pub const StatusCode = status.Code;

pub const process_layer = process;
pub const pty_layer = pty;
pub const signal_layer = signal;

pub export fn pebble_system_abi_version() c_int {
    return abi.version;
}

pub export fn pebble_system_status_message(code: c_int) [*:0]const u8 {
    return status.message(code);
}

pub export fn pebble_system_process_spawn(
    start: ?*const abi.ProcessStart,
    out_handle: ?*abi.ProcessHandle,
) c_int {
    const start_ptr = start orelse return status.toInt(.invalid_argument);
    const handle_ptr = out_handle orelse return status.toInt(.invalid_argument);

    return resultCode(process.spawn(start_ptr, handle_ptr));
}

pub export fn pebble_system_process_wait(
    handle: ?*abi.ProcessHandle,
    timeout_ms: u32,
    out_exit: ?*abi.ProcessExit,
) c_int {
    const handle_ptr = handle orelse return status.toInt(.invalid_argument);
    const exit_ptr = out_exit orelse return status.toInt(.invalid_argument);

    return resultCode(process.wait(handle_ptr, timeout_ms, exit_ptr));
}

pub export fn pebble_system_process_kill(
    handle: ?*const abi.ProcessHandle,
    sig: c_int,
) c_int {
    const handle_ptr = handle orelse return status.toInt(.invalid_argument);
    return resultCode(process.kill(handle_ptr, sig));
}

pub export fn pebble_system_process_release(handle: ?*abi.ProcessHandle) c_int {
    const handle_ptr = handle orelse return status.toInt(.invalid_argument);
    return resultCode(process.release(handle_ptr));
}

pub export fn pebble_system_signal_send_pid(pid: u64, sig: c_int) c_int {
    return resultCode(signal.sendPid(pid, sig));
}

pub export fn pebble_system_pty_spawn(
    start: ?*const abi.PtyStart,
    out_handle: ?*abi.PtyHandle,
) c_int {
    const start_ptr = start orelse return status.toInt(.invalid_argument);
    const handle_ptr = out_handle orelse return status.toInt(.invalid_argument);

    return resultCode(pty.spawn(start_ptr, handle_ptr));
}

pub export fn pebble_system_pty_read(
    handle: ?*const abi.PtyHandle,
    buffer: ?[*]u8,
    capacity: usize,
    out_bytes_read: ?*usize,
) c_int {
    const handle_ptr = handle orelse return status.toInt(.invalid_argument);
    const bytes_ptr = out_bytes_read orelse return status.toInt(.invalid_argument);
    const buffer_ptr = buffer orelse {
        if (capacity == 0) {
            bytes_ptr.* = 0;
            return status.toInt(.ok);
        }
        return status.toInt(.invalid_argument);
    };

    return resultCode(pty.readBytes(handle_ptr, buffer_ptr, capacity, bytes_ptr));
}

pub export fn pebble_system_pty_write(
    handle: ?*const abi.PtyHandle,
    buffer: ?[*]const u8,
    length: usize,
    out_bytes_written: ?*usize,
) c_int {
    const handle_ptr = handle orelse return status.toInt(.invalid_argument);
    const bytes_ptr = out_bytes_written orelse return status.toInt(.invalid_argument);
    const buffer_ptr = buffer orelse {
        if (length == 0) {
            bytes_ptr.* = 0;
            return status.toInt(.ok);
        }
        return status.toInt(.invalid_argument);
    };

    return resultCode(pty.writeBytes(handle_ptr, buffer_ptr, length, bytes_ptr));
}

pub export fn pebble_system_pty_resize(handle: ?*const abi.PtyHandle, size: abi.PtySize) c_int {
    const handle_ptr = handle orelse return status.toInt(.invalid_argument);
    return resultCode(pty.resize(handle_ptr, size));
}

pub export fn pebble_system_pty_close(handle: ?*abi.PtyHandle) c_int {
    const handle_ptr = handle orelse return status.toInt(.invalid_argument);
    return resultCode(pty.closeHandle(handle_ptr));
}

fn resultCode(result: anyerror!void) c_int {
    result catch |err| return status.toInt(status.fromError(err));
    return status.toInt(.ok);
}

test "ABI version matches public header" {
    try std.testing.expectEqual(@as(c_int, 1), pebble_system_abi_version());
}

test "null process spawn pointers are rejected" {
    try std.testing.expectEqual(
        status.toInt(.invalid_argument),
        pebble_system_process_spawn(null, null),
    );
}
