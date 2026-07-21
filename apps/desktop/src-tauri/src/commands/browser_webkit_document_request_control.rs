// Why: Wry exposes no WebKit deferral for arbitrary HTTP resources; this bridge
// intentionally covers only main-frame fetch and asynchronous XHR calls.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn script() -> &'static str {
    r#"
(() => {
  const capture = globalThis.__pebbleAutomationCapture;
  const tauriInvoke = globalThis.__TAURI_INTERNALS__?.invoke?.bind(globalThis.__TAURI_INTERNALS__);
  if (!capture || typeof tauriInvoke !== 'function') return;
  const match = (url) => capture.interceptRoutes.find((route) => {
    let escaped = '';
    for (let index = 0; index < route.pattern.length; index += 1) {
      const character = route.pattern[index];
      if (character === '*') {
        if (route.pattern[index + 1] === '*') {
          escaped += '.*';
          index += 1;
        } else {
          escaped += '[^/]*';
        }
      } else {
        escaped += /[.+^${}()|[\]\\]/.test(character) ? '\\' + character : character;
      }
    }
    try { return new RegExp('^' + escaped + '$').test(url); } catch { return false; }
  });
  const decide = async (route, url, method, headers, resourceType) => {
    if (route?.action !== 'pause') return { action: 'continue' };
    try {
      return await tauriInvoke('browser_document_request_pause', {
        input: { url, method, headers: Object.fromEntries(headers.entries()), resourceType }
      });
    } catch {
      return { action: 'continue' };
    }
  };
  const response = (decision) => {
    const status = decision.status || 200;
    const body = [204, 205, 304].includes(status) ? null : (decision.body || '');
    return new Response(body, { status, headers: decision.headers || {} });
  };
  const innerFetch = globalThis.fetch?.bind(globalThis);
  if (innerFetch) {
    globalThis.fetch = async (...args) => {
      const request = args[0];
      const method = String(args[1]?.method || (request instanceof Request ? request.method : 'GET'));
      const url = new URL(String(request instanceof Request ? request.url : request), location.href).href.slice(0, 8192);
      const route = match(url);
      if (route?.action !== 'pause') return innerFetch(...args);
      const headers = new Headers(request instanceof Request ? request.headers : args[1]?.headers);
      const decision = await decide(route, url, method, headers, 'fetch');
      if (decision.action === 'fail') throw new TypeError(decision.reason || 'Failed to fetch');
      if (decision.action === 'fulfill') return response(decision);
      return innerFetch(...args);
    };
  }
  const xhr = new WeakMap();
  const innerOpen = XMLHttpRequest.prototype.open;
  const innerSend = XMLHttpRequest.prototype.send;
  const innerSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    xhr.set(this, {
      method: String(method),
      url: new URL(String(url), location.href).href.slice(0, 8192),
      async: rest[0] !== false,
      headers: new Headers()
    });
    return innerOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    try { xhr.get(this)?.headers.append(String(name), String(value)); } catch {}
    return innerSetRequestHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const request = xhr.get(this);
    const route = request ? match(request.url) : null;
    if (route?.action !== 'pause' || request?.async === false) return innerSend.apply(this, args);
    void decide(route, request.url, request.method, request.headers, 'xhr').then((decision) => {
      if (decision.action === 'fail') {
        this.abort();
        this.dispatchEvent(new ProgressEvent('error'));
        this.dispatchEvent(new ProgressEvent('loadend'));
        return;
      }
      if (decision.action === 'fulfill') {
        Object.defineProperties(this, {
          readyState: { configurable: true, value: 4 },
          status: { configurable: true, value: decision.status || 200 },
          responseText: { configurable: true, value: decision.body || '' },
          response: { configurable: true, value: decision.body || '' }
        });
        const headers = new Headers(decision.headers || {});
        this.getResponseHeader = (name) => headers.get(name);
        this.dispatchEvent(new ProgressEvent('readystatechange'));
        this.dispatchEvent(new ProgressEvent('load'));
        this.dispatchEvent(new ProgressEvent('loadend'));
        return;
      }
      innerSend.apply(this, args);
    });
  };
})();
"#
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn script() -> &'static str {
    "void 0;"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn limits_request_control_to_document_fetch_and_async_xhr() {
        let script = script();
        assert!(script.contains("browser_document_request_pause"));
        assert!(script.contains("globalThis.fetch = async"));
        assert!(script.contains("request?.async === false"));
        assert!(script.contains("new WeakMap()"));
        assert!(script.contains("route.pattern[index + 1] === '*'"));
        assert!(script.contains("escaped += '[^/]*'"));
        assert!(!script.contains("replace(/\\*\\*/g, '.*').replace(/\\*/g"));
        assert!(!script.contains("HTMLImageElement"));
        assert!(!script.contains("serviceWorker"));
    }
}
