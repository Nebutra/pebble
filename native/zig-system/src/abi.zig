const std = @import("std");

pub const version: c_int = 1;
pub const wait_infinite: u32 = std.math.maxInt(u32);
pub const max_vector_items: usize = 4096;

pub const process_clear_environment: u32 = 1 << 0;
pub const process_supported_flags: u32 = process_clear_environment;
pub const pty_supported_flags: u32 = 0;

pub const ProcessStart = extern struct {
    executable: ?[*:0]const u8,
    argv: ?[*]const ?[*:0]const u8,
    argc: usize,
    cwd: ?[*:0]const u8,
    env: ?[*]const ?[*:0]const u8,
    env_count: usize,
    flags: u32,
    reserved: u32,
};

pub const ProcessHandle = extern struct {
    pid: u64,
    native_handle: usize,
    flags: u32,
    reserved: u32,
};

pub const ProcessExit = extern struct {
    exit_code: i32,
    signal: i32,
    exited: u8,
    signaled: u8,
    reserved: u16,
};

pub const PtySize = extern struct {
    rows: u32,
    cols: u32,
    pixel_width: u32,
    pixel_height: u32,
};

pub const PtyStart = extern struct {
    shell: ?[*:0]const u8,
    argv: ?[*]const ?[*:0]const u8,
    argc: usize,
    cwd: ?[*:0]const u8,
    env: ?[*]const ?[*:0]const u8,
    env_count: usize,
    size: PtySize,
    flags: u32,
    reserved: u32,
};

pub const PtyHandle = extern struct {
    master_fd: isize,
    pid: u64,
    native_handle: usize,
    flags: u32,
    reserved: u32,
};

pub fn emptyProcessHandle() ProcessHandle {
    return .{
        .pid = 0,
        .native_handle = 0,
        .flags = 0,
        .reserved = 0,
    };
}

pub fn emptyProcessExit() ProcessExit {
    return .{
        .exit_code = -1,
        .signal = 0,
        .exited = 0,
        .signaled = 0,
        .reserved = 0,
    };
}

pub fn emptyPtyHandle() PtyHandle {
    return .{
        .master_fd = -1,
        .pid = 0,
        .native_handle = 0,
        .flags = 0,
        .reserved = 0,
    };
}

pub fn copyCommandSlices(
    allocator: std.mem.Allocator,
    executable: ?[*:0]const u8,
    argv: ?[*]const ?[*:0]const u8,
    argc: usize,
) ![][]const u8 {
    const executable_ptr = executable orelse return error.InvalidArgument;
    if (argc > max_vector_items) return error.InvalidArgument;
    if (argc > 0 and argv == null) return error.InvalidArgument;

    var items = try allocator.alloc([]const u8, argc + 1);
    errdefer allocator.free(items);
    items[0] = std.mem.span(executable_ptr);

    if (argc > 0) {
        const argv_items = argv.?;
        for (0..argc) |index| {
            const arg_ptr = argv_items[index] orelse return error.InvalidArgument;
            items[index + 1] = std.mem.span(arg_ptr);
        }
    }

    return items;
}

pub fn copyCommandVector(
    allocator: std.mem.Allocator,
    executable: ?[*:0]const u8,
    argv: ?[*]const ?[*:0]const u8,
    argc: usize,
) ![]?[*:0]const u8 {
    const executable_ptr = executable orelse return error.InvalidArgument;
    if (argc > max_vector_items) return error.InvalidArgument;
    if (argc > 0 and argv == null) return error.InvalidArgument;

    var items = try allocator.alloc(?[*:0]const u8, argc + 2);
    errdefer allocator.free(items);
    items[0] = executable_ptr;

    if (argc > 0) {
        const argv_items = argv.?;
        for (0..argc) |index| {
            items[index + 1] = argv_items[index] orelse return error.InvalidArgument;
        }
    }

    items[argc + 1] = null;
    return items;
}

pub fn copyNullTerminatedVector(
    allocator: std.mem.Allocator,
    values: ?[*]const ?[*:0]const u8,
    count: usize,
) ![]?[*:0]const u8 {
    if (count > max_vector_items) return error.InvalidArgument;
    if (count > 0 and values == null) return error.InvalidArgument;

    var items = try allocator.alloc(?[*:0]const u8, count + 1);
    errdefer allocator.free(items);

    if (count > 0) {
        const value_items = values.?;
        for (0..count) |index| {
            items[index] = value_items[index] orelse return error.InvalidArgument;
        }
    }

    items[count] = null;
    return items;
}

pub fn populateEnvMap(
    env_map: *std.process.Environ.Map,
    env: ?[*]const ?[*:0]const u8,
    env_count: usize,
) !void {
    if (env_count == 0) return;
    if (env_count > max_vector_items) return error.InvalidArgument;

    const entries = env orelse return error.InvalidArgument;
    for (0..env_count) |index| {
        const entry_ptr = entries[index] orelse return error.InvalidArgument;
        const entry = std.mem.span(entry_ptr);
        const equals_index = std.mem.indexOfScalar(u8, entry, '=') orelse return error.InvalidArgument;
        if (equals_index == 0) return error.InvalidArgument;

        // KEY=VALUE strings avoid ABI-sensitive nested env structs for Rust and Go.
        try env_map.put(entry[0..equals_index], entry[equals_index + 1 ..]);
    }
}

test "process handle defaults are inert" {
    const handle = emptyProcessHandle();
    try std.testing.expectEqual(@as(u64, 0), handle.pid);
    try std.testing.expectEqual(@as(usize, 0), handle.native_handle);
}

test "command slices require an executable" {
    try std.testing.expectError(
        error.InvalidArgument,
        copyCommandSlices(std.testing.allocator, null, null, 0),
    );
}

test "command vector appends a null terminator" {
    const shell: [:0]const u8 = "/bin/sh";
    const arg: [:0]const u8 = "-l";
    const argv = [_]?[*:0]const u8{arg.ptr};
    const vector = try copyCommandVector(std.testing.allocator, shell.ptr, &argv, argv.len);
    defer std.testing.allocator.free(vector);

    try std.testing.expectEqual(shell.ptr, vector[0].?);
    try std.testing.expectEqual(arg.ptr, vector[1].?);
    try std.testing.expectEqual(@as(?[*:0]const u8, null), vector[2]);
}

test "null terminated vectors accept empty values" {
    const vector = try copyNullTerminatedVector(std.testing.allocator, null, 0);
    defer std.testing.allocator.free(vector);

    try std.testing.expectEqual(@as(?[*:0]const u8, null), vector[0]);
}
