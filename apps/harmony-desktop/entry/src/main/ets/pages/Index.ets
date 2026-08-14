import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { RuntimeHostSnapshot } from '../runtime/RuntimeHost';

const DOMAIN: number = 0x5042;
const TAG: string = 'Index';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State statusLine: string = 'Preparing shell…';
  @State useWebShell: boolean = true;
  @State webSrc: string = '';
  private pollTimer: number = -1;
  private lastWebUrl: string = '';
  private webControllerReady: boolean = false;

  aboutToAppear(): void {
    this.applySnapshot(AppStorage.get<RuntimeHostSnapshot>('runtimeSnapshot'));
    let ticks = 0;
    this.pollTimer = setInterval(() => {
      ticks++;
      const snap = AppStorage.get<RuntimeHostSnapshot>('runtimeSnapshot');
      this.applySnapshot(snap);
      const hasPairingUrl = (this.webSrc.indexOf('pairing=') >= 0);
      const done =
        (snap?.kind === 'hybrid_connected' && hasPairingUrl) ||
        ticks > 50;
      if (done) {
        clearInterval(this.pollTimer);
        this.pollTimer = -1;
      }
    }, 500) as number;
  }

  aboutToDisappear(): void {
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
  }

  private applySnapshot(snap: RuntimeHostSnapshot | undefined): void {
    if (!snap) {
      return;
    }
    this.statusLine = `${snap.kind}: ${snap.message}`;
    if (snap.webUrl.length > 0 && snap.webUrl !== this.lastWebUrl) {
      this.lastWebUrl = snap.webUrl;
      this.webSrc = snap.webUrl;
      hilog.info(DOMAIN, TAG, 'webSrc=%{public}s', this.webSrc);
      // Why: changing @State Web({src}) alone often does not navigate after first load.
      if (this.webControllerReady) {
        try {
          this.controller.loadUrl(this.webSrc);
          hilog.info(DOMAIN, TAG, 'loadUrl applied');
        } catch (e) {
          hilog.warn(DOMAIN, TAG, 'loadUrl failed: %{public}s', String(e));
        }
      }
    }
  }

  build() {
    Column() {
      Row() {
        Text('Pebble')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
        Blank()
        Text(this.statusLine)
          .fontSize(12)
          .fontColor($r('app.color.status_warn'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .constraintSize({ maxWidth: '72%' })
      }
      .width('100%')
      .padding({
        left: 16,
        right: 16,
        top: 10,
        bottom: 10
      })
      .backgroundColor($r('app.color.page_background'))

      if (this.useWebShell && this.webSrc.length > 0) {
        Web({ src: this.webSrc, controller: this.controller })
          .width('100%')
          .layoutWeight(1)
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .mixedMode(MixedMode.All)
          .onlineImageAccess(true)
          .onControllerAttached(() => {
            this.webControllerReady = true;
            // Re-apply latest URL (often has pairing after first attach).
            if (this.webSrc.length > 0) {
              try {
                this.controller.loadUrl(this.webSrc);
              } catch (_e) {
                // first src already loading
              }
            }
          })
          .onErrorReceive((_event) => {
            hilog.error(DOMAIN, TAG, 'Web error src=%{public}s', this.webSrc);
          })
          .onPageEnd((_event) => {
            hilog.info(DOMAIN, TAG, 'Web loaded %{public}s', this.webSrc);
          })
      } else {
        Column() {
          Text('Waiting for shell probe + web stage…')
            .fontSize(16)
          Text(this.statusLine)
            .margin({ top: 8 })
            .fontColor($r('app.color.status_warn'))
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
