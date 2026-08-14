import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { RuntimeHost } from '../runtime/RuntimeHost';

const DOMAIN: number = 0x5042;
const TAG: string = 'EntryAbility';

export default class EntryAbility extends UIAbility {
  private runtimeHost?: RuntimeHost;
  private prepared: boolean = false;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate');
    this.runtimeHost = new RuntimeHost(this.context);
    // Fire-and-forget prepare; Index page will re-probe for UI state.
    // Shell + web only; real Go is hybrid/privileged host — not this process.
    void this.runtimeHost.ensurePrepared().then((snap) => {
      this.prepared = true;
      hilog.info(DOMAIN, TAG, 'shell prepare: %{public}s %{public}s', snap.kind, snap.message);
      AppStorage.setOrCreate('runtimeSnapshot', snap);
    });
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onDestroy');
    // Shell probe can stay up across ability restarts.
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageCreate');
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent ok');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground');
    // Why: the first onForeground races ensurePrepared (pairing still empty)
    // and made Index load web-index.html without ?pairing=.
    if (this.runtimeHost && this.prepared) {
      void this.runtimeHost.probeGateway().then((snap) => {
        AppStorage.setOrCreate('runtimeSnapshot', snap);
      });
    }
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
  }
}
