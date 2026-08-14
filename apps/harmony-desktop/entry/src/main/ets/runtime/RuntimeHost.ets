import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import runtimeSpawn from 'libruntime_spawn.so';
import { RuntimeConfig } from './RuntimeConfig';

const DOMAIN: number = 0x5042; // 'PB'
const TAG: string = 'RuntimeHost';

/**
 * Shell lifecycle host — not the product control plane.
 * Why: Go cannot run inside normal HAP (SELinux + musl TLS). Product path is
 * hybrid pairing to real pebble-runtime; C++ is packaging probe only.
 */
export type RuntimeStatusKind =
  | 'unknown'
  | 'shell_probe_starting'
  | 'shell_probe_ok'
  | 'hybrid_ready'
  | 'hybrid_connected'
  | 'error';

export interface RuntimeHostSnapshot {
  kind: RuntimeStatusKind;
  message: string;
  /** Always the shell probe URL when probe is up (smoke only). */
  shellProbeUrl: string;
  /** product-core WebView URL (loopback static + optional pairing query). */
  webUrl: string;
  /** Non-empty when hybrid pairing code is available for auto-connect. */
  pairingCode: string;
  version: string;
  /** True when app can HTTP-reach real Go on 127.0.0.1:17778 (via rport). */
  hybridReachable: boolean;
}

export class RuntimeHost {
  private context: common.UIAbilityContext;
  private webRoot: string = '';
  private pairingCode: string = '';
  private snapshot: RuntimeHostSnapshot = {
    kind: 'unknown',
    message: 'Not started',
    shellProbeUrl: RuntimeConfig.SHELL_PROBE_BASE_URL,
    webUrl: '',
    pairingCode: '',
    version: '',
    hybridReachable: false
  };

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  getSnapshot(): RuntimeHostSnapshot {
    return this.snapshot;
  }

  async ensurePrepared(): Promise<RuntimeHostSnapshot> {
    try {
      const dataDir = `${this.context.filesDir}/runtime-data`;
      try {
        await fs.mkdir(dataDir, true);
      } catch (_e) {
        // exists
      }

      // Why: pairing is cheap; web staging takes seconds. Load the code first
      // so Index can inject ?pairing= on the first navigation instead of
      // booting unpaired and racing a second loadUrl.
      this.pairingCode = await this.loadPairingCode();
      this.snapshot = {
        kind: 'shell_probe_starting',
        message: 'Staging web; starting shell probe (not Go runtime)…',
        shellProbeUrl: RuntimeConfig.SHELL_PROBE_BASE_URL,
        webUrl: this.buildWebUrl(),
        pairingCode: this.pairingCode,
        version: '',
        hybridReachable: false
      };
      this.webRoot = await this.stageWebToFilesDir();

      if (!runtimeSpawn.isInProcessRunning()) {
        await this.startShellProbe(dataDir);
      }
      await this.sleep(200);
      await this.probeShell();
      await this.probeHybridGo();
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(DOMAIN, TAG, 'ensurePrepared failed: %{public}s', JSON.stringify(err));
      this.snapshot = {
        kind: 'error',
        message: `Prepare failed: ${err?.message ?? String(e)}`,
        shellProbeUrl: RuntimeConfig.SHELL_PROBE_BASE_URL,
        webUrl: this.buildWebUrl(),
        pairingCode: this.pairingCode,
        version: '',
        hybridReachable: false
      };
    }
    return this.snapshot;
  }

  async startShellProbe(dataDir: string): Promise<void> {
    hilog.info(
      DOMAIN,
      TAG,
      'shell probe listen=%{public}s staticRoot=%{public}s',
      RuntimeConfig.SHELL_PROBE_LISTEN,
      this.webRoot
    );
    // Why token differs from hybrid: probe is local smoke only; never mint product pairing here.
    runtimeSpawn.startInProcess(
      RuntimeConfig.SHELL_PROBE_LISTEN,
      dataDir,
      'pebble-shell-probe',
      this.webRoot.length > 0 ? this.webRoot : undefined
    );
  }

  stopRuntime(): void {
    try {
      runtimeSpawn.stopInProcess();
    } catch (_e) {
      // ignore
    }
  }

  async probeShell(): Promise<RuntimeHostSnapshot> {
    const url = `${RuntimeConfig.SHELL_PROBE_BASE_URL}/v1/status`;
    const client = http.createHttp();
    try {
      const response = await client.request(url, {
        method: http.RequestMethod.GET,
        header: {
          'Authorization': 'Bearer pebble-shell-probe'
        },
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 2000,
        readTimeout: 2000
      });
      if (response.responseCode === 200) {
        const hybrid = this.pairingCode.length > 0;
        this.snapshot = {
          kind: hybrid ? 'hybrid_ready' : 'shell_probe_ok',
          message: hybrid
            ? 'Shell probe OK; hybrid pairing injected → real Go on host :17778'
            : 'Shell probe OK only — run run-hybrid-runtime.sh + stage-hybrid-pairing for Go',
          shellProbeUrl: RuntimeConfig.SHELL_PROBE_BASE_URL,
          webUrl: this.buildWebUrl(),
          pairingCode: this.pairingCode,
          version: hybrid ? 'hybrid-pairing' : 'shell-probe',
          hybridReachable: this.snapshot.hybridReachable
        };
      } else {
        this.snapshot = {
          kind: 'error',
          message: `Shell probe HTTP ${response.responseCode}`,
          shellProbeUrl: RuntimeConfig.SHELL_PROBE_BASE_URL,
          webUrl: this.buildWebUrl(),
          pairingCode: this.pairingCode,
          version: '',
          hybridReachable: false
        };
      }
    } catch (_e) {
      this.snapshot = {
        kind: runtimeSpawn.isInProcessRunning() ? 'shell_probe_starting' : 'error',
        message: runtimeSpawn.isInProcessRunning()
          ? 'Shell probe starting…'
          : 'Shell probe unreachable',
        shellProbeUrl: RuntimeConfig.SHELL_PROBE_BASE_URL,
        webUrl: this.buildWebUrl(),
        pairingCode: this.pairingCode,
        version: '',
        hybridReachable: false
      };
    } finally {
      client.destroy();
    }
    return this.snapshot;
  }

  /**
   * Prove app UID can reach real Go (hdc rport makes host :17778 appear local).
   * Why: shell UID cannot open TCP to host; WebView pairing needs this path.
   */
  async probeHybridGo(): Promise<boolean> {
    const url = `http://127.0.0.1:${RuntimeConfig.RUNTIME_PORT}/v1/status`;
    const client = http.createHttp();
    try {
      const response = await client.request(url, {
        method: http.RequestMethod.GET,
        header: {
          'Authorization': `Bearer ${RuntimeConfig.DEFAULT_TOKEN}`
        },
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 2500,
        readTimeout: 2500
      });
      if (response.responseCode === 200 && typeof response.result === 'string') {
        let version = 'go';
        try {
          const parsed = JSON.parse(response.result) as Record<string, string>;
          if (parsed.version) {
            version = parsed.version;
          }
        } catch (_e) {
          // keep
        }
        hilog.info(DOMAIN, TAG, 'hybrid Go reachable version=%{public}s pairingLen=%{public}d',
          version, this.pairingCode.length);
        const hasPairing = this.pairingCode.length > 0;
        this.snapshot = {
          kind: hasPairing ? 'hybrid_connected' : 'hybrid_ready',
          message: hasPairing
            ? `Real Go reachable (${version}); pairing injected`
            : `Real Go reachable (${version}); missing pairing.code — stage-hybrid-pairing`,
          shellProbeUrl: this.snapshot.shellProbeUrl,
          webUrl: this.buildWebUrl(),
          pairingCode: this.pairingCode,
          version,
          hybridReachable: true
        };
        return true;
      }
      hilog.warn(DOMAIN, TAG, 'hybrid Go HTTP %{public}d', response.responseCode);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'hybrid Go unreachable: %{public}s', String(e));
    } finally {
      client.destroy();
    }
    this.snapshot.hybridReachable = false;
    return false;
  }

  /** @deprecated name kept for EntryAbility. */
  async probeGateway(): Promise<RuntimeHostSnapshot> {
    await this.probeShell();
    await this.probeHybridGo();
    return this.snapshot;
  }

  private async loadPairingCode(): Promise<string> {
    // Prefer filesDir (pushed by hdc / stage-pairing) then rawfile package.
    const dest = `${this.context.filesDir}/hybrid/pairing.code`;
    try {
      await fs.access(dest);
      const file = await fs.open(dest, fs.OpenMode.READ_ONLY);
      try {
        const buf = new ArrayBuffer(8192);
        const n = await fs.read(file.fd, buf);
        if (n > 0) {
          const code = this.bytesToUtf8(new Uint8Array(buf, 0, n)).trim();
          hilog.info(DOMAIN, TAG, 'pairing from filesDir len=%{public}d', code.length);
          return code;
        }
      } finally {
        await fs.close(file);
      }
    } catch (_e) {
      // fall through
    }
    try {
      const raw = this.context.resourceManager.getRawFileContentSync(
        RuntimeConfig.RAWFILE_HYBRID_PAIRING_CODE
      );
      const code = this.bytesToUtf8(raw).trim();
      hilog.info(DOMAIN, TAG, 'pairing from rawfile len=%{public}d', code.length);
      return code;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'no hybrid pairing code packaged: %{public}s', String(e));
      return '';
    }
  }

  private buildWebUrl(): string {
    // Static UI always from shell probe HTTP (ES modules need http, not resource://).
    let url = `${RuntimeConfig.SHELL_PROBE_BASE_URL}/web-index.html`;
    if (this.pairingCode.length > 0) {
      // product-core web-pairing reads ?pairing= / ?code=
      url = `${url}?pairing=${encodeURIComponent(this.pairingCode)}&harmony=1`;
    } else {
      url = `${url}?harmony=1`;
    }
    return url;
  }

  private async stageWebToFilesDir(): Promise<string> {
    const destDir = `${this.context.filesDir}/web`;
    try {
      await fs.mkdir(destDir, true);
    } catch (_e) {
      // exists
    }

    let hasIndex = false;
    try {
      this.context.resourceManager.getRawFileContentSync('web/web-index.html');
      hasIndex = true;
    } catch (_e) {
      hasIndex = false;
    }

    if (!hasIndex) {
      try {
        const raw = this.context.resourceManager.getRawFileContentSync('web/bootstrap.html');
        await this.writeUint8(`${destDir}/bootstrap.html`, raw);
        await this.writeUint8(`${destDir}/web-index.html`, raw);
        return destDir;
      } catch (_missing) {
        return '';
      }
    }

    try {
      const packaged = this.context.resourceManager.getRawFileContentSync('web/.staged-from-product-core');
      await this.writeUint8(`${destDir}/.staged-from-product-core`, packaged);
    } catch (_noMarker) {
      // continue
    }

    // Why: HAP packaging drops dotfiles, so the skip marker is a regular name.
    let packagedMarker = '';
    try {
      packagedMarker = this.bytesToUtf8(
        this.context.resourceManager.getRawFileContentSync('web/staged-from.txt')
      ).trim();
    } catch (_noPackagedMarker) {
      // older packages
    }
    if (packagedMarker.length > 0) {
      try {
        const existing = await this.readUtf8File(`${destDir}/staged-from.txt`);
        await fs.access(`${destDir}/web-index.html`);
        if (existing.trim() === packagedMarker) {
          hilog.info(DOMAIN, TAG, 'web already staged, skip copy');
          return destDir;
        }
      } catch (_needCopy) {
        // first launch or HAP web changed
      }
    }

    await this.copyRawToFiles('web/web-index.html', `${destDir}/web-index.html`);
    if (packagedMarker.length > 0) {
      await this.writeUtf8(`${destDir}/staged-from.txt`, packagedMarker);
    }
    try {
      await this.copyRawToFiles('web/bootstrap.html', `${destDir}/bootstrap.html`);
    } catch (_e) {
      // optional
    }

    try {
      const listRaw = this.context.resourceManager.getRawFileContentSync('web/assets/filelist.txt');
      const text = this.bytesToUtf8(listRaw);
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l !== 'filelist.txt');
      hilog.info(DOMAIN, TAG, 'staging %{public}d web assets…', lines.length);
      let ok = 0;
      for (const rel of lines) {
        const rawPath = `web/assets/${rel}`;
        const outPath = `${destDir}/assets/${rel}`;
        const slash = outPath.lastIndexOf('/');
        if (slash > 0) {
          try {
            await fs.mkdir(outPath.substring(0, slash), true);
          } catch (_e) {
            // exists
          }
        }
        try {
          await this.copyRawToFiles(rawPath, outPath);
          ok++;
        } catch (_skip) {
          // continue
        }
      }
      hilog.info(DOMAIN, TAG, 'staged %{public}d/%{public}d assets', ok, lines.length);
    } catch (_noList) {
      hilog.warn(DOMAIN, TAG, 'no web/assets/filelist.txt — index only');
    }

    return destDir;
  }

  private async copyRawToFiles(rawPath: string, destPath: string): Promise<void> {
    const raw = this.context.resourceManager.getRawFileContentSync(rawPath);
    await this.writeUint8(destPath, raw);
  }

  private async readUtf8File(path: string): Promise<string> {
    const file = await fs.open(path, fs.OpenMode.READ_ONLY);
    try {
      const buf = new ArrayBuffer(4096);
      const n = await fs.read(file.fd, buf);
      return n > 0 ? this.bytesToUtf8(new Uint8Array(buf, 0, n)) : '';
    } finally {
      await fs.close(file);
    }
  }

  private async writeUtf8(destPath: string, text: string): Promise<void> {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i) & 0xff;
    }
    await this.writeUint8(destPath, bytes);
  }

  private async writeUint8(destPath: string, data: Uint8Array): Promise<void> {
    const file = await fs.open(destPath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      const copy = new ArrayBuffer(data.byteLength);
      const view = new Uint8Array(copy);
      for (let i = 0; i < data.byteLength; i++) {
        view[i] = data[i];
      }
      await fs.write(file.fd, copy);
    } finally {
      await fs.close(file);
    }
  }

  private bytesToUtf8(raw: Uint8Array): string {
    let s = '';
    for (let i = 0; i < raw.length; i++) {
      s += String.fromCharCode(raw[i]);
    }
    return s;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
