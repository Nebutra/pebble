const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const static_only = b.option(bool, "static-only", "Build only the static C ABI library") orelse false;

    const static_lib = b.addLibrary(.{
        .linkage = .static,
        .name = "pebble_system",
        .root_module = systemModule(b, target, optimize),
    });
    static_lib.installHeader(b.path("include/pebble_system.h"), "pebble_system.h");
    b.installArtifact(static_lib);

    if (!static_only) {
        const shared_lib = b.addLibrary(.{
            .linkage = .dynamic,
            .name = "pebble_system",
            .root_module = systemModule(b, target, optimize),
        });
        b.installArtifact(shared_lib);
    }

    const unit_tests = b.addTest(.{
        .root_module = systemModule(b, target, optimize),
    });

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run Zig system layer unit tests");
    test_step.dependOn(&run_unit_tests.step);
}

fn systemModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
) *std.Build.Module {
    const module = b.createModule(.{
        .root_source_file = b.path("src/pebble_system.zig"),
        .target = target,
        .optimize = optimize,
        // Windows exports explicit unsupported results for the POSIX process,
        // signal, and PTY functions, so its ABI library has no libc dependency.
        .link_libc = target.result.os.tag != .windows,
    });

    // Linux keeps forkpty-compatible symbols in libutil on older libc layouts.
    if (target.result.os.tag == .linux) {
        module.linkSystemLibrary("util", .{});
    }

    return module;
}
