pub(super) fn script() -> &'static str {
    r#"
(() => {
  if (globalThis.__pebbleScreencastDirtyInstalled) return;
  globalThis.__pebbleScreencastDirtyInstalled = true;
  const invoke = globalThis.__TAURI_INTERNALS__?.invoke?.bind(globalThis.__TAURI_INTERNALS__);
  if (typeof invoke !== 'function') return;
  let queued = false;
  const mark = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      void invoke('browser_screencast_mark_dirty').catch(() => {});
      if (document.getAnimations?.().some((animation) => animation.playState === 'running')) mark();
    });
  };
  const observe = () => {
    if (!document.documentElement) return;
    new MutationObserver(mark).observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
  };
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe, { once: true });
  for (const event of ['input', 'change', 'scroll', 'resize', 'animationstart',
    'animationiteration', 'animationend', 'transitionrun', 'transitionend',
    'loadeddata', 'seeked', 'timeupdate']) {
    globalThis.addEventListener(event, mark, { capture: true, passive: true });
  }
  mark();
})();
"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observes_document_and_visual_timeline_changes() {
        let script = script();
        assert!(script.contains("MutationObserver"));
        assert!(script.contains("browser_screencast_mark_dirty"));
        assert!(script.contains("animationiteration"));
        assert!(script.contains("document.getAnimations"));
        assert!(script.contains("timeupdate"));
        assert!(script.contains("requestAnimationFrame"));
    }
}
