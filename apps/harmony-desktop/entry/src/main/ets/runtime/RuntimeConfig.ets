/**
 * Harmony shell defaults.
 *
 * Hard decision: real brain is Go pebble-runtime (hybrid host or future
 * privileged host). C++ probe is packaging smoke only — different port.
 * See docs/reference/investigations/harmony-runtime-host.md
 */
export class RuntimeConfig {
  /**
   * Shell probe only (C++ stub). Not product-core pairing target.
   * Why not 17777/17778: those belong to real Go (desktop / Harmony hybrid).
   */
  static readonly SHELL_PROBE_LISTEN: string = '127.0.0.1:18777';
  static readonly SHELL_PROBE_BASE_URL: string = 'http://127.0.0.1:18777';

  /**
   * Harmony hybrid Go port. Why not 17777: macOS Pebble.app already binds
   * that as the desktop runtime; sharing it made the HAP pair to the wrong
   * process (Unknown RPC / empty session).
   */
  static readonly RUNTIME_PORT: string = '17778';
  static readonly DEFAULT_TOKEN: string = 'pebble-harmony-hybrid';

  /**
   * Hybrid advertise host baked into pairing offers.
   * Prefer 127.0.0.1 with `hdc rport tcp:17778 tcp:17778` (device → host).
   * LAN devices: set HARMONY_PAIRING_HOST when minting pairing.
   */
  static readonly DEFAULT_PAIRING_HOST: string = '127.0.0.1';

  static readonly BINARY_NAME: string = 'pebble-runtime';
  static readonly RAWFILE_BINARY: string = 'runtime/pebble-runtime';

  /** Packaged hybrid pairing code from scripts/run-hybrid-runtime.sh (optional). */
  static readonly RAWFILE_HYBRID_PAIRING_CODE: string = 'hybrid/pairing.code';
}
