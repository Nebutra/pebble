#ifndef PEBBLE_SYSTEM_H
#define PEBBLE_SYSTEM_H

#include <stddef.h>
#include <stdint.h>

#if defined(__cplusplus)
extern "C" {
#endif

#ifndef PEBBLE_SYSTEM_API
#if defined(_WIN32) && defined(PEBBLE_SYSTEM_BUILD_SHARED)
#define PEBBLE_SYSTEM_API __declspec(dllexport)
#elif defined(__GNUC__) || defined(__clang__)
#define PEBBLE_SYSTEM_API __attribute__((visibility("default")))
#else
#define PEBBLE_SYSTEM_API
#endif
#endif

#define PEBBLE_SYSTEM_ABI_VERSION 1
#define PEBBLE_SYSTEM_WAIT_INFINITE UINT32_MAX

typedef enum PebbleSystemStatus {
  PEBBLE_SYSTEM_OK = 0,
  PEBBLE_SYSTEM_INVALID_ARGUMENT = 1,
  PEBBLE_SYSTEM_NOT_FOUND = 2,
  PEBBLE_SYSTEM_ACCESS_DENIED = 3,
  PEBBLE_SYSTEM_UNSUPPORTED_PLATFORM = 4,
  PEBBLE_SYSTEM_SPAWN_FAILED = 5,
  PEBBLE_SYSTEM_WAIT_FAILED = 6,
  PEBBLE_SYSTEM_IO_FAILED = 7,
  PEBBLE_SYSTEM_NO_MEMORY = 8,
  PEBBLE_SYSTEM_BUFFER_TOO_SMALL = 9,
  PEBBLE_SYSTEM_PROCESS_RUNNING = 10,
  PEBBLE_SYSTEM_BAD_HANDLE = 11,
  PEBBLE_SYSTEM_SIGNAL_FAILED = 12,
  PEBBLE_SYSTEM_UNKNOWN = 255
} PebbleSystemStatus;

typedef enum PebbleProcessFlags {
  PEBBLE_PROCESS_DEFAULT = 0,
  PEBBLE_PROCESS_CLEAR_ENVIRONMENT = 1u << 0
} PebbleProcessFlags;

typedef struct PebbleProcessStart {
  const char *executable;
  const char *const *argv;
  size_t argc;
  const char *cwd;
  const char *const *env;
  size_t env_count;
  uint32_t flags;
  uint32_t reserved;
} PebbleProcessStart;

typedef struct PebbleProcessHandle {
  uint64_t pid;
  uintptr_t native_handle;
  uint32_t flags;
  uint32_t reserved;
} PebbleProcessHandle;

typedef struct PebbleProcessExit {
  int32_t exit_code;
  int32_t signal;
  uint8_t exited;
  uint8_t signaled;
  uint16_t reserved;
} PebbleProcessExit;

typedef struct PebblePtySize {
  uint32_t rows;
  uint32_t cols;
  uint32_t pixel_width;
  uint32_t pixel_height;
} PebblePtySize;

typedef struct PebblePtyStart {
  const char *shell;
  const char *const *argv;
  size_t argc;
  const char *cwd;
  const char *const *env;
  size_t env_count;
  PebblePtySize size;
  uint32_t flags;
  uint32_t reserved;
} PebblePtyStart;

typedef struct PebblePtyHandle {
  intptr_t master_fd;
  uint64_t pid;
  uintptr_t native_handle;
  uint32_t flags;
  uint32_t reserved;
} PebblePtyHandle;

PEBBLE_SYSTEM_API int32_t pebble_system_abi_version(void);
PEBBLE_SYSTEM_API const char *pebble_system_status_message(int32_t status);

/*
 * argv excludes argv[0]; executable/shell becomes argv[0].
 * env entries use KEY=VALUE strings to keep Rust and Go callers ABI-stable.
 */
PEBBLE_SYSTEM_API int32_t pebble_system_process_spawn(
    const PebbleProcessStart *start,
    PebbleProcessHandle *out_handle);
PEBBLE_SYSTEM_API int32_t pebble_system_process_wait(
    PebbleProcessHandle *handle,
    uint32_t timeout_ms,
    PebbleProcessExit *out_exit);
PEBBLE_SYSTEM_API int32_t pebble_system_process_kill(
    const PebbleProcessHandle *handle,
    int32_t signal);
PEBBLE_SYSTEM_API int32_t pebble_system_process_release(PebbleProcessHandle *handle);

PEBBLE_SYSTEM_API int32_t pebble_system_signal_send_pid(uint64_t pid, int32_t signal);

PEBBLE_SYSTEM_API int32_t pebble_system_pty_spawn(
    const PebblePtyStart *start,
    PebblePtyHandle *out_handle);
PEBBLE_SYSTEM_API int32_t pebble_system_pty_read(
    const PebblePtyHandle *handle,
    uint8_t *buffer,
    size_t capacity,
    size_t *out_bytes_read);
PEBBLE_SYSTEM_API int32_t pebble_system_pty_write(
    const PebblePtyHandle *handle,
    const uint8_t *buffer,
    size_t length,
    size_t *out_bytes_written);
PEBBLE_SYSTEM_API int32_t pebble_system_pty_resize(
    const PebblePtyHandle *handle,
    PebblePtySize size);
PEBBLE_SYSTEM_API int32_t pebble_system_pty_close(PebblePtyHandle *handle);

#if defined(__cplusplus)
}
#endif

#endif
