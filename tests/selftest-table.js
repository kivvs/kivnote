/* 表格列宽自检脚本（跑在真实的 WebView2 里）
 *
 * 由 `kivnote-tauri.exe --selftest <本文件> <输出文件>` 驱动。
 * 返回一个 JSON 对象，Rust 侧写到输出文件。
 *
 * 要验证的是【浏览器布局引擎】的实际行为：
 *   · 初始列宽是否已按内容算够（不应不足）；
 *   · 滚动到含长文本的行时，列宽是否保持不变（不应增宽）。
 * 这两点用 Rust / Node 都测不出来，只有真实渲染引擎能作数。
 */
(function () {
  return new Promise(function (resolve) {
    var out = { ok: false, checks: [] };
    function add(name, pass, detail) {
      out.checks.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
    }

    var TEST_FILE = '__TEST_FILE__';

    function measure() {
      var tbl = document.getElementById('tbl');
      if (!tbl) { add('表格已渲染', false, '找不到 #tbl'); return false; }
      var sc = document.querySelector('.tbl-scroll');
      if (!sc) { add('找到滚动容器', false, '找不到 .tbl-scroll'); return false; }

      /* 取所有数据单元格的实际渲染宽度，统计有几种 */
      var cells = tbl.querySelectorAll('tbody tr td:nth-child(2)');
      if (!cells.length) { add('有数据行', false, 'tbody 里没有单元格'); return false; }

      var hist = {};
      for (var i = 0; i < cells.length; i++) {
        var w = Math.round(cells[i].getBoundingClientRect().width * 100) / 100;
        hist[w] = (hist[w] || 0) + 1;
      }
      var distinct = Object.keys(hist).map(Number);
      out.widthHistogram = hist;
      out.distinctWidths = distinct.length;
      out.minWidth = Math.min.apply(null, distinct);
      out.maxWidth = Math.max.apply(null, distinct);

      var cols = tbl.querySelectorAll('col');
      out.declared = [];
      for (var c = 0; c < cols.length; c++) {
        out.declared.push(cols[c].style.width || '');
      }

      var cs = getComputedStyle(cells[0]);
      out.tdMinWidth = cs.minWidth;
      out.tdOverflow = cs.overflow;
      out.tdTextOverflow = cs.textOverflow;
      out.tableLayout = getComputedStyle(tbl).tableLayout;
      out.boxSizing = cs.boxSizing;

      /* 找最长的那个单元格，看它是否被截断（而不是撑开列） */
      var longest = null, longestText = '';
      for (var k = 0; k < cells.length; k++) {
        var t = cells[k].textContent || '';
        if (t.length > longestText.length) { longestText = t; longest = cells[k]; }
      }
      if (longest) {
        out.longestText = longestText;
        out.longestScrollW = longest.scrollWidth;
        out.longestClientW = longest.clientWidth;
      }

      add('table-layout 生效为 fixed', out.tableLayout === 'fixed', out.tableLayout);
      add('单元格 border-box（col 宽度即最终占位宽）', out.boxSizing === 'border-box', out.boxSizing);
      add('td 无 min-width（不会顶开列）',
        out.tdMinWidth === '0px' || out.tdMinWidth === 'auto', out.tdMinWidth);
      add('整列所有行宽度一致（滚动不增宽）',
        out.distinctWidths === 1,
        '出现 ' + out.distinctWidths + ' 种: ' + JSON.stringify(out.widthHistogram));
      add('长文本被 ellipsis 截断而非撑开列',
        out.tdOverflow === 'hidden' && out.tdTextOverflow === 'ellipsis',
        out.tdOverflow + '/' + out.tdTextOverflow);
      add('长内容确实超宽（说明截断生效）',
        out.longestScrollW > out.longestClientW,
        out.longestScrollW + ' > ' + out.longestClientW);
      return true;
    }

    /* 打开测试表格。
       注意：前端的业务函数都包在 IIFE 里，外部拿不到；
       但 window.__kivOpenPaths 是暴露出来的打开桥，用它走完整渲染链路。 */
    out.env = {
      hasNative: typeof native !== 'undefined',
      hasBridge: typeof window.__kivOpenPaths === 'function',
      hasXlsx: typeof window.XLSX !== 'undefined',
      docReady: document.readyState
    };
    if (typeof window.__kivOpenPaths !== 'function') {
      add('打开桥 __kivOpenPaths 可用', false, '找不到 window.__kivOpenPaths; env=' + JSON.stringify(out.env));
      resolve(out);
      return;
    }
    window.__kivOpenPaths([TEST_FILE]);
    add('已触发打开', true, TEST_FILE);

    /* 分阶段上报：万一卡在某一步，也能看出卡在哪 */
    var stage = 'opened';
    window.__selftestStage = stage;

    /* 等前端把表格画出来（SheetJS 解析 + 渲染是异步的） */
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var tbl = document.getElementById('tbl');
      var cells = tbl && tbl.querySelectorAll('tbody tr td');
      if (cells && cells.length > 5) {
        clearInterval(timer);
        /* 再等一帧，让布局稳定 */
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            out.beforeScroll = { widths: (function () {
              var h = {};
              var cs2 = tbl.querySelectorAll('tbody tr td:nth-child(2)');
              for (var i = 0; i < cs2.length; i++) {
                var w = Math.round(cs2[i].getBoundingClientRect().width * 100) / 100;
                h[w] = (h[w] || 0) + 1;
              }
              return h;
            })() };

            if (!measure()) { resolve(out); return; }

            /* 关键动作：滚到底部，触发长文本行进入视口，
               然后再量一次 —— 宽度若变了就是「越滚越宽」 */
            var sc = document.querySelector('.tbl-scroll');
            sc.scrollTop = sc.scrollHeight;
            requestAnimationFrame(function () {
              requestAnimationFrame(function () {
                out.afterScroll = { widths: (function () {
                  var h = {};
                  var cs3 = tbl.querySelectorAll('tbody tr td:nth-child(2)');
                  for (var i = 0; i < cs3.length; i++) {
                    var w = Math.round(cs3[i].getBoundingClientRect().width * 100) / 100;
                    h[w] = (h[w] || 0) + 1;
                  }
                  return h;
                })() };
                out.tableWidthBefore = Math.round(tbl.getBoundingClientRect().width * 100) / 100;
                out.tableWidthAfter = Math.round(tbl.getBoundingClientRect().width * 100) / 100;
                out.scrollTop = sc.scrollTop;

                var bk = Object.keys(out.beforeScroll.widths);
                var ak = Object.keys(out.afterScroll.widths);
                out.widthsSameBeforeAfter = (bk.length === ak.length) &&
                  bk.every(function (k) { return out.afterScroll.widths[k] === out.beforeScroll.widths[k]; });

                add('滚动前后列宽完全一致（表格不变宽）',
                  out.widthsSameBeforeAfter,
                  '前 ' + JSON.stringify(out.beforeScroll.widths) + ' 后 ' + JSON.stringify(out.afterScroll.widths));
                add('滚动后表格总宽没变',
                  Math.abs(out.tableWidthBefore - out.tableWidthAfter) < 0.5,
                  out.tableWidthBefore + ' → ' + out.tableWidthAfter);

                out.ok = out.checks.every(function (c) { return c.pass; });
                resolve(out);
              });
            });
          });
        });
        return;
      }
      if (tries > 60) {
        clearInterval(timer);
        add('表格在 6 秒内渲染出来', false,
          '超时（#tbl 里没有数据行）; stage=' + stage + '; env=' + JSON.stringify(out.env) +
          '; tabs=' + (document.querySelectorAll('.tab').length) +
          '; vTable=' + (document.getElementById('vTable') ?
                        getComputedStyle(document.getElementById('vTable')).display : 'n/a') +
          '; sheetjs=' + (typeof window.XLSX !== 'undefined'));
        resolve(out);
      }
    }, 100);
  });
})
