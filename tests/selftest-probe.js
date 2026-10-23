/* 探针：等 __TAURI__ 完全就绪后再回报，确认 invoke 通道是否可用 */
(function () {
  return new Promise(function (resolve) {
    var t0 = Date.now();
    var waited = 0;

    function ready() {
      return !!(window.__TAURI__ && window.__TAURI__.core &&
                typeof window.__TAURI__.core.invoke === 'function');
    }

    /* 先把页面状态记下来，即使后面 invoke 失败也能看出卡在哪 */
    var state = {
      readyState: document.readyState,
      hasTauri: typeof window.__TAURI__,
      hasInternals: ('__TAURI_INTERNALS__' in window),
      tabs: document.querySelectorAll('.tab').length,
      tblRows: (function () { var t = document.getElementById('tbl'); return t ? t.querySelectorAll('tbody tr').length : -1; })(),
      xlsx: typeof window.XLSX,
      bridge: typeof window.__kivOpenPaths,
      native: typeof native
    };

    function report(extra) {
      for (var k in (extra || {})) state[k] = extra[k];
      state.waitedMs = Date.now() - t0;
      state.readyNow = ready();
      resolve(state);
    }

    if (!ready()) {
      state.note = 'TAURI 未就绪，轮询等待';
      var iv = setInterval(function () {
        waited += 100;
        if (ready()) {
          clearInterval(iv);
          report({ note: '等待后就绪' });
        } else if (waited > 8000) {
          clearInterval(iv);
          report({ note: '等待 8s 仍未就绪' });
        }
      }, 100);
    } else {
      report({ note: '立即可用' });
    }
  });
})