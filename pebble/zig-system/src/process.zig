const builtin = @import("builtin");
const std = @import("std");

const abi = @import("abi.zig");
const signal = @import("signal.zig");

const wait_no_hang: c_int = 1;
const poll_interval_ms: u32 = 10;

extern "c" fn chdir(path: [*:0]const u8) c_int;
extern "c" fn execve(
    path: [*:0]const u8,
    argv: [*c]const ?[*:0]const u8,
    envp: [*c]const ?[*:0]const u8,
) c_int;
extern "c" fn execvp(file: [*:0]const u8, argv: [*c]const ?[*:0]const u8) c_int;
extern "c" fn fork() c_int;
extern "c" fn waitpid(pid: c_int, stat_loc: *c_int, options: c_int) c_int;
extern "c" fn _exit(status: c_int) noreturn;

pub fn spawn(start: *const abi.ProcessStart, out: *abi.ProcessHandle) !void {
    out.* = abi.emptyProcessHandle();

    return switch (builtin.os.tag) {
        .windows => error.UnsupportedPlatform,
        else => spawnPosix(start, out),
    };
}

fn spawnPosix(start: *const abi.ProcessStart, out: *abi.ProcessHandle) !void {
    if (start.reserved != 0) return error.InvalidArgument;
    if ((start.flags & ~abi.process_supported_flags) != 0) return error.UnsupportedPlatform;

    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const executable = start.executable orelse return error.InvalidArgument;
    const argv = try abi.copyCommandVector(allocator, start.executable, start.argv, start.argc);
    const envp = try abi.copyNullTerminatedVector(allocator, start.env, start.env_count);
    const child_pid = fork();
    if (child_pid < 0) return error.SpawnFailed;

    if (child_pid == 0) {
        if (start.cwd) |cwd| {
            _ = chdir(cwd);
        }

        // Fork children must leave through exec or _exit to avoid copying runtime state.
        if (start.env_count > 0 or (start.flags & abi.process_clear_environment) != 0) {
            _ = execve(
                executable,
                @as([*c]const ?[*:0]const u8, @ptrCast(argv.ptr)),
                @as([*c]const ?[*:0]const u8, @ptrCast(envp.ptr)),
            );
        } else {
            _ = execvp(executable, @as([*c]const ?[*:0]const u8, @ptrCast(argv.ptr)));
        }
        _exit(127);
    }

    out.* = .{
        .pid = @as(u64, @intCast(child_pid)),
        .native_handle = 0,
        .flags = 0,
        .reserved = 0,
    };
}

pub fn wait(handle: *abi.ProcessHandle, timeout_ms: u32, out: *abi.ProcessExit) !void {
    out.* = abi.emptyProcessExit();
    if (handle.pid == 0) return error.BadHandle;

    return switch (builtin.os.tag) {
        .windows => error.UnsupportedPlatform,
        else => waitPosix(handle, timeout_ms, out),
    };
}

fn waitPosix(handle: *abi.ProcessHandle, timeout_ms: u32, out: *abi.ProcessExit) !void {
    const pid = try pidToCInt(handle.pid);

    if (timeout_ms == abi.wait_infinite) {
        try waitBlocking(pid, out);
        handle.* = abi.emptyProcessHandle();
        return;
    }

    var remaining_ms = timeout_ms;

    while (true) {
        const complete = try waitNonBlocking(pid, out);
        if (complete) {
            handle.* = abi.emptyProcessHandle();
            return;
        }

        if (remaining_ms == 0) {
            return error.ProcessRunning;
        }

        const sleep_ms = @min(remaining_ms, poll_interval_ms);
        sleepMilliseconds(sleep_ms);
        remaining_ms -= sleep_ms;
    }
}

fn waitBlocking(pid: c_int, out: *abi.ProcessExit) !void {
    var status_value: c_int = 0;
    const waited = waitpid(pid, &status_value, 0);
    if (waited < 0) return error.WaitFailed;
    out.* = decodeExit(status_value);
}

fn waitNonBlocking(pid: c_int, out: *abi.ProcessExit) !bool {
    var status_value: c_int = 0;
    const waited = waitpid(pid, &status_value, wait_no_hang);
    if (waited < 0) return error.WaitFailed;
    if (waited == 0) return false;

    out.* = decodeExit(status_value);
    return true;
}

fn decodeExit(status_value: c_int) abi.ProcessExit {
    var result = abi.emptyProcessExit();
    const signal_bits = status_value & 0x7f;

    if (signal_bits == 0) {
        result.exited = 1;
        result.exit_code = @as(i32, @intCast((status_value >> 8) & 0xff));
    } else {
        result.signaled = 1;
        result.signal = @as(i32, @intCast(signal_bits));
    }

    return result;
}

pub fn kill(handle: *const abi.ProcessHandle, sig: c_int) !void {
    if (handle.pid == 0) return error.BadHandle;
    try signal.sendPid(handle.pid, sig);
}

pub fn release(handle: *abi.ProcessHandle) !void {
    if (handle.pid == 0 and handle.native_handle == 0) {
        handle.* = abi.emptyProcessHandle();
        return;
    }

    handle.* = abi.emptyProcessHandle();
}

fn pidToCInt(pid: u64) !c_int {
    if (pid == 0 or pid > std.math.maxInt(c_int)) return error.BadHandle;
    return @as(c_int, @intCast(pid));
}

fn sleepMilliseconds(milliseconds: u32) void {
    var request = std.c.timespec{
        .sec = @as(std.c.time_t, @intCast(milliseconds / std.time.ms_per_s)),
        .nsec = @as(c_long, @intCast((milliseconds % std.time.ms_per_s) * std.time.ns_per_ms)),
    };
    _ = std.c.nanosleep(&request, null);
}

test "release clears stale process handles" {
    var handle = abi.ProcessHandle{
        .pid = 42,
        .native_handle = 0,
        .flags = 0,
        .reserved = 0,
    };

    try release(&handle);
    try std.testing.expectEqual(@as(u64, 0), handle.pid);
}

test "wait rejects an empty process handle" {
    var handle = abi.emptyProcessHandle();
    var exit = abi.emptyProcessExit();
    try std.testing.expectError(error.BadHandle, wait(&handle, 0, &exit));
}
