const builtin = @import("builtin");
const std = @import("std");

const abi = @import("abi.zig");
const signal = @import("signal.zig");

const Winsize = extern struct {
    ws_row: c_ushort,
    ws_col: c_ushort,
    ws_xpixel: c_ushort,
    ws_ypixel: c_ushort,
};

extern "c" fn chdir(path: [*:0]const u8) c_int;
extern "c" fn close(fd: c_int) c_int;
extern "c" fn execve(
    path: [*:0]const u8,
    argv: [*c]const ?[*:0]const u8,
    envp: [*c]const ?[*:0]const u8,
) c_int;
extern "c" fn execvp(file: [*:0]const u8, argv: [*c]const ?[*:0]const u8) c_int;
extern "c" fn forkpty(
    amaster: *c_int,
    name: ?[*:0]u8,
    termp: ?*anyopaque,
    winp: ?*const Winsize,
) c_int;
extern "c" fn ioctl(fd: c_int, request: c_ulong, argp: *const Winsize) c_int;
extern "c" fn read(fd: c_int, buffer: [*]u8, count: usize) isize;
extern "c" fn write(fd: c_int, buffer: [*]const u8, count: usize) isize;
extern "c" fn _exit(status: c_int) noreturn;

pub fn spawn(start: *const abi.PtyStart, out: *abi.PtyHandle) !void {
    out.* = abi.emptyPtyHandle();

    return switch (builtin.os.tag) {
        .linux, .macos => spawnPosix(start, out),
        else => error.UnsupportedPlatform,
    };
}

fn spawnPosix(start: *const abi.PtyStart, out: *abi.PtyHandle) !void {
    if (start.reserved != 0) return error.InvalidArgument;
    if ((start.flags & ~abi.pty_supported_flags) != 0) return error.UnsupportedPlatform;

    const shell = start.shell orelse return error.InvalidArgument;

    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const argv = try abi.copyCommandVector(allocator, start.shell, start.argv, start.argc);
    const envp = try abi.copyNullTerminatedVector(allocator, start.env, start.env_count);

    var master_fd: c_int = -1;
    var window_size = winsizeFrom(start.size);
    const child_pid = forkpty(&master_fd, null, null, &window_size);
    if (child_pid < 0) return error.SpawnFailed;

    if (child_pid == 0) {
        if (start.cwd) |cwd| {
            _ = chdir(cwd);
        }

        // The child must leave through exec or _exit to avoid duplicating runtime state.
        if (start.env_count > 0) {
            _ = execve(
                shell,
                @as([*c]const ?[*:0]const u8, @ptrCast(argv.ptr)),
                @as([*c]const ?[*:0]const u8, @ptrCast(envp.ptr)),
            );
        } else {
            _ = execvp(shell, @as([*c]const ?[*:0]const u8, @ptrCast(argv.ptr)));
        }
        _exit(127);
    }

    out.* = .{
        .master_fd = @as(isize, @intCast(master_fd)),
        .pid = @as(u64, @intCast(child_pid)),
        .native_handle = 0,
        .flags = 0,
        .reserved = 0,
    };
}

pub fn readBytes(
    handle: *const abi.PtyHandle,
    buffer: [*]u8,
    capacity: usize,
    out_bytes_read: *usize,
) !void {
    out_bytes_read.* = 0;
    if (capacity == 0) return;
    _ = try fdFromHandle(handle);

    return switch (builtin.os.tag) {
        .linux, .macos => readBytesPosix(handle, buffer, capacity, out_bytes_read),
        else => error.UnsupportedPlatform,
    };
}

fn readBytesPosix(
    handle: *const abi.PtyHandle,
    buffer: [*]u8,
    capacity: usize,
    out_bytes_read: *usize,
) !void {
    out_bytes_read.* = 0;
    if (capacity == 0) return;

    const fd = try fdFromHandle(handle);
    const amount = read(fd, buffer, capacity);
    if (amount < 0) return error.IoFailed;

    out_bytes_read.* = @as(usize, @intCast(amount));
}

pub fn writeBytes(
    handle: *const abi.PtyHandle,
    buffer: [*]const u8,
    length: usize,
    out_bytes_written: *usize,
) !void {
    out_bytes_written.* = 0;
    if (length == 0) return;
    _ = try fdFromHandle(handle);

    return switch (builtin.os.tag) {
        .linux, .macos => writeBytesPosix(handle, buffer, length, out_bytes_written),
        else => error.UnsupportedPlatform,
    };
}

fn writeBytesPosix(
    handle: *const abi.PtyHandle,
    buffer: [*]const u8,
    length: usize,
    out_bytes_written: *usize,
) !void {
    out_bytes_written.* = 0;
    if (length == 0) return;

    const fd = try fdFromHandle(handle);
    const amount = write(fd, buffer, length);
    if (amount < 0) return error.IoFailed;

    out_bytes_written.* = @as(usize, @intCast(amount));
}

pub fn resize(handle: *const abi.PtyHandle, size: abi.PtySize) !void {
    _ = try fdFromHandle(handle);

    return switch (builtin.os.tag) {
        .linux, .macos => resizePosix(handle, size),
        else => error.UnsupportedPlatform,
    };
}

fn resizePosix(handle: *const abi.PtyHandle, size: abi.PtySize) !void {
    const request = tiocswinsz() orelse return error.UnsupportedPlatform;
    const fd = try fdFromHandle(handle);
    var window_size = winsizeFrom(size);

    if (ioctl(fd, request, &window_size) != 0) return error.IoFailed;
}

pub fn closeHandle(handle: *abi.PtyHandle) !void {
    if (handle.master_fd < 0 and handle.pid == 0) {
        handle.* = abi.emptyPtyHandle();
        return;
    }

    return switch (builtin.os.tag) {
        .linux, .macos => closeHandlePosix(handle),
        else => {
            handle.* = abi.emptyPtyHandle();
            return error.UnsupportedPlatform;
        },
    };
}

fn closeHandlePosix(handle: *abi.PtyHandle) !void {
    const fd = fdFromHandle(handle) catch {
        handle.* = abi.emptyPtyHandle();
        return;
    };

    _ = close(fd);
    if (handle.pid != 0) {
        signal.sendPid(handle.pid, signal.hangup) catch {};
    }

    handle.* = abi.emptyPtyHandle();
}

fn fdFromHandle(handle: *const abi.PtyHandle) !c_int {
    if (handle.master_fd < 0) return error.BadHandle;
    if (handle.master_fd > std.math.maxInt(c_int)) return error.BadHandle;

    return @as(c_int, @intCast(handle.master_fd));
}

fn winsizeFrom(size: abi.PtySize) Winsize {
    return .{
        .ws_row = clampUShort(size.rows),
        .ws_col = clampUShort(size.cols),
        .ws_xpixel = clampUShort(size.pixel_width),
        .ws_ypixel = clampUShort(size.pixel_height),
    };
}

fn clampUShort(value: u32) c_ushort {
    return if (value > std.math.maxInt(c_ushort))
        std.math.maxInt(c_ushort)
    else
        @as(c_ushort, @intCast(value));
}

fn tiocswinsz() ?c_ulong {
    return switch (builtin.os.tag) {
        .linux => 0x5414,
        .macos => 0x80087467,
        else => null,
    };
}

test "empty PTY handles are rejected" {
    const handle = abi.emptyPtyHandle();
    var buffer = [_]u8{0};
    var bytes_read: usize = 0;
    try std.testing.expectError(error.BadHandle, readBytes(&handle, buffer[0..].ptr, 1, &bytes_read));
}

test "window size values are clamped to platform field width" {
    const size = winsizeFrom(.{
        .rows = std.math.maxInt(u32),
        .cols = 80,
        .pixel_width = 0,
        .pixel_height = 0,
    });

    try std.testing.expectEqual(std.math.maxInt(c_ushort), size.ws_row);
    try std.testing.expectEqual(@as(c_ushort, 80), size.ws_col);
}
