// ==UserScript==
// @name         超星通用课程截止提醒
// @namespace    chaoxing-deadline
// @version      2.9.1
// @description  通用课程（含新版）和课程都读取：列出还没截止的作业和考试（含未设置截止时间的），单列最近30天已结束且未作答的作业，另列出未结课且章节没看完的课程；菜单一键更新
// @author       specdock
// @match        https://mooc1-2.chaoxing.com/visit/courses*
// @match        https://mooc1-2.chaoxing.com/mooc-ans/visit/courses*
// @match        https://mooc1.chaoxing.com/visit/courses*
// @match        https://mooc1-2.chaoxing.com/visit/interaction*
// @match        https://mooc1-2.chaoxing.com/mooc-ans/visit/interaction*
// @match        https://mooc1.chaoxing.com/visit/interaction*
// @match        https://mooc2-ans.chaoxing.com/mooc2-ans/visit/interaction*
// @match        https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courses*
// @match        https://i.chaoxing.com/base*
// @match        https://*.chaoxing.com/wfw/courselist/course3*
// @match        https://*.chaoxing.com/fyportal/courselist/course3*
// @match        https://*.chaoxing.com/courselist/course3*
// @connect      v24.chaoxing.com
// @connect      mooc1-2.chaoxing.com
// @connect      mooc1-3.chaoxing.com
// @connect      mooc1-4.chaoxing.com
// @connect      mooc1.chaoxing.com
// @connect      mooc2-ans.chaoxing.com
// @connect      passport2.chaoxing.com
// @connect      i.mooc.chaoxing.com
// @connect      mobilelearn.chaoxing.com
// @connect      fycourse.fanya.chaoxing.com
// @connect      fyportal.chaoxing.com
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_info
// @updateURL    https://raw.githubusercontent.com/SpecDock/MyScript/master/chaoxing-deadline-reminder.user.js
// @downloadURL  https://raw.githubusercontent.com/SpecDock/MyScript/master/chaoxing-deadline-reminder.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // i.chaoxing.com/base 是个人空间外壳，课程内容都在 iframe 里
  // （旧版通用课程 → mooc1-2，新版通用课程 → mooc2-ans）。
  // 外壳本身没有课程数据，注入只会多出一个空面板，所以直接跳过，交给 iframe 里的脚本。
  const shellFrame = document.getElementById('frame_content')
    || Array.from(document.querySelectorAll('iframe')).some(function (f) {
      return /\/visit\/(interaction|courses)/.test(f.src || '');
    });
  if (location.hostname === 'i.chaoxing.com' && shellFrame) return;

  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  // 「最近已结束」分区的时间窗口：只看 30 天内结束的未作答作业。
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  // 列表翻页上限。作业列表每页 12 条，40 页足够覆盖 480 条；
  // 这个上限防的是分页脚本给出异常 pageNum 时无限翻页。
  const MAX_LIST_PAGES = 40;
  // 单个请求的超时。20 秒太长：一旦有几个请求卡住，光超时就够把整轮拖到一分钟以上，
  // 而超时的请求本来也要走重试/换域名。12 秒足够正常页面返回，卡住的早点放弃更快。
  const FETCH_TIMEOUT = 12000;
  // v2.2.0 提速参数
  // 已知安全域名（mooc1-2 / mooc2-ans）的请求发起间隔。实测这两个域名
  // 承接 170+ 个请求全部 200，180ms（约 5.5 req/s）是安全余量。
  // 被反爬命中时这个间隔会自动 ×3 退避，必要时可手动调大。
  const FAST_GAP = 180;
  // mooc1 及未知域名的间隔，保守一些（mooc1 本身是指纹型拒绝，限速也拦不住它）
  const SLOW_GAP = 1500;
  // 同时处理几门课。并发数决定流水线深度：并发够大时耗时只受“域名发起间隔”约束，
  // 不会随网络变慢而线性膨胀（仿真：43 门课在 200~800ms 延迟下都是 23~25 秒）。
  // 并发变多不会提高对服务器的瞬时压力——同域名的请求发起间隔仍是 180ms，
  // 并发只影响“同时在途”的连接数。
  const CONCURRENCY_FAST = 20;
  // 全局在途请求上限。
  // 实测超星一次请求要 1.8~4.1 秒（章节页 100~500KB），在途上限就等于吞吐上限：
  // 20 个在途 / 4 秒 = 只有 5 请求/秒，147 个请求要 29.5 秒（v2.6.1 实测）。
  // 提到 26 之后，最坏情况（冷连接 4 秒）约 22 秒，常见情况（1.5 秒）约 11 秒。
  // 注意每个域名的请求发起间隔仍是 180ms，单机总请求量不变（每台约 39 个，远低于反爬阈值）。
  const MAX_INFLIGHT = 26;
  // 命中反爬后的退避：间隔 ×3（上限 6 秒）+ 该域名本轮弃用
  const MAX_HOST_GAP = 6000;

  GM_addStyle(`
    #cx-deadline {
      position: fixed;
      top: 72px;
      right: 18px;
      z-index: 2147483646;
      width: 880px;
      height: min(560px, calc(100vh - 120px));
      min-width: min(600px, calc(100vw - 16px));
      min-height: 200px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      background: #fff;
      color: #1f2937;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
      font: 12px/1.35 "Microsoft YaHei", "PingFang SC", sans-serif;
      overflow: hidden;
    }
    #cx-deadline.is-min {
      width: 300px;
      height: 30px;
      min-width: 220px;
      min-height: 30px;
    }
    #cx-deadline.is-min .cx-rz { display: none; }
    #cx-deadline .cx-bar {
      flex: 0 0 30px;
      height: 30px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 6px 0 8px;
      background: #1e3a5f;
      color: #fff;
      cursor: move;
      user-select: none;
      touch-action: none;
    }
    #cx-deadline .cx-title { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #cx-deadline .cx-bar button {
      border: 0;
      background: transparent;
      color: #fff;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      line-height: 22px;
    }
    #cx-deadline .cx-bar button:hover { background: rgba(255,255,255,.16); }
    #cx-deadline .cx-bar button.cx-scanbtn { width: auto; padding: 0 9px; font-size: 12px; font-weight: 600; }
    #cx-deadline .cx-bar button.cx-scanbtn:disabled { opacity: .6; cursor: default; background: transparent; }
    #cx-deadline .cx-start { padding: 20px 12px; text-align: center; }
    #cx-deadline .cx-start button {
      border: 0; background: #1e3a5f; color: #fff; padding: 8px 20px; border-radius: 6px;
      font: 600 13px/1.2 "Microsoft YaHei", "PingFang SC", sans-serif; cursor: pointer;
    }
    #cx-deadline .cx-start button:hover { background: #2b5480; }
    #cx-deadline .cx-start p { margin: 9px 0 0; color: #64748b; font-size: 11px; line-height: 1.5; }
    #cx-deadline .cx-body {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      align-items: stretch;
      overflow: hidden;
      background: #fff;
    }
    #cx-deadline .cx-col { flex: 1.35 1 0; width: auto; min-width: 0; max-height: none; overflow: auto; }
    #cx-deadline .cx-col + .cx-col { flex: 1 1 0; border-left: 1px solid #e5e7eb; }
    #cx-deadline .cx-start { flex: 1 1 auto; }
    #cx-deadline .cx-sec { padding: 4px 8px; background: #f8fafc; color: #1e3a5f; font-weight: 650; border-bottom: 1px solid #e5e7eb; }
    #cx-deadline .cx-sec.cx-sub { border-top: 1px solid #cbd5e1; background: #eef2f7; }
    #cx-deadline table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    #cx-deadline th, #cx-deadline td {
      padding: 3px 5px;
      text-align: left;
      border-bottom: 1px solid #f1f5f9;
      vertical-align: top;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    #cx-deadline th { position: sticky; top: 0; background: #f8fafc; color: #64748b; font-weight: 600; }
    #cx-deadline table.cx-tasks th:nth-child(1) { width: 26%; }
    #cx-deadline table.cx-tasks th:nth-child(3) { width: 27%; }
    #cx-deadline table.cx-ended th:nth-child(1) { width: 26%; }
    #cx-deadline table.cx-ended th:nth-child(3) { width: 29%; }
    #cx-deadline table.cx-chapters th:nth-child(2) { width: 38%; }
    #cx-deadline table.cx-tasks td:last-child,
    #cx-deadline table.cx-ended td:last-child,
    #cx-deadline table.cx-chapters td:last-child { font-size: 11px; }
    /* 边框拖拽手柄（放在面板内侧，避免被 overflow:hidden 裁掉） */
    #cx-deadline .cx-rz { position: absolute; z-index: 6; touch-action: none; }
    #cx-deadline .cx-rz-n, #cx-deadline .cx-rz-s { left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
    #cx-deadline .cx-rz-n { top: 0; }
    #cx-deadline .cx-rz-s { bottom: 0; }
    #cx-deadline .cx-rz-w, #cx-deadline .cx-rz-e { top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
    #cx-deadline .cx-rz-w { left: 0; }
    #cx-deadline .cx-rz-e { right: 0; }
    #cx-deadline .cx-rz-ne, #cx-deadline .cx-rz-nw,
    #cx-deadline .cx-rz-se, #cx-deadline .cx-rz-sw { width: 12px; height: 12px; }
    #cx-deadline .cx-rz-ne { top: 0; right: 0; cursor: nesw-resize; }
    #cx-deadline .cx-rz-nw { top: 0; left: 0; cursor: nwse-resize; }
    #cx-deadline .cx-rz-se { bottom: 0; right: 0; cursor: nwse-resize; }
    #cx-deadline .cx-rz-sw { bottom: 0; left: 0; cursor: nesw-resize; }
    #cx-deadline .cx-rz-se::after {
      content: '';
      position: absolute;
      right: 3px;
      bottom: 3px;
      width: 7px;
      height: 7px;
      border-right: 2px solid #94a3b8;
      border-bottom: 2px solid #94a3b8;
    }
    #cx-deadline tr.cx-hot td { color: #dc2626; font-weight: 650; background: #fff5f5; }
    #cx-deadline tr.cx-nodue td { color: #b45309; font-weight: 650; background: #fffbeb; }
    #cx-deadline tr.cx-ok td { color: #15803d; background: #f0fdf4; }
    #cx-deadline tr.cx-done td { color: #15803d; font-weight: 650; background: #f0fdf4; }
    #cx-deadline tr.cx-ended td { color: #475569; background: #f8fafc; }
    #cx-deadline tr.cx-ended .cx-kind { color: #64748b; }
    #cx-deadline .cx-kind { color: #64748b; font-weight: 500; margin-right: 4px; }
    #cx-deadline tr.cx-hot .cx-kind { color: #dc2626; }
    #cx-deadline tr.cx-nodue .cx-kind { color: #b45309; }
    #cx-deadline tr.cx-ok .cx-kind,
    #cx-deadline tr.cx-done .cx-kind { color: #15803d; }
    #cx-deadline .cx-status { display: block; color: #94a3b8; font-size: 11px; font-weight: 400; }
    #cx-deadline tr.cx-hot .cx-status { color: #f87171; }
    #cx-deadline tr.cx-done .cx-status { color: #16a34a; }
    #cx-deadline .cx-foot { flex: 0 0 auto; padding: 4px 8px; color: #64748b; background: #f8fafc; font-size: 11px; }
    #cx-deadline .cx-log {
      flex: 0 0 auto;
      max-height: 190px; overflow: auto; background: #0f172a; color: #cbd5e1;
      font: 11px/1.45 Consolas, Menlo, monospace; padding: 6px 8px; word-break: break-all;
    }
    #cx-deadline.is-min .cx-log { display: none !important; }
    #cx-deadline .cx-empty { padding: 12px 8px; text-align: center; color: #64748b; }
  `);

  const panel = document.createElement('div');
  panel.id = 'cx-deadline';
  panel.innerHTML = `
    <div class="cx-bar">
      <div class="cx-title">通用课程截止</div>
      <button type="button" data-act="scan" class="cx-scanbtn" title="开始扫描（手动触发）">▶ 扫描</button>
      <button type="button" data-act="log" title="查看读取日志">☰</button>
      <button type="button" data-act="min" title="最小化">—</button>
    </div>
    <div class="cx-body"></div>
    <div class="cx-log" style="display:none"></div>
    <div class="cx-foot">拖动蓝条移动，拖动边框调整大小</div>
    <span class="cx-rz cx-rz-n" data-dir="n"></span>
    <span class="cx-rz cx-rz-s" data-dir="s"></span>
    <span class="cx-rz cx-rz-w" data-dir="w"></span>
    <span class="cx-rz cx-rz-e" data-dir="e"></span>
    <span class="cx-rz cx-rz-ne" data-dir="ne"></span>
    <span class="cx-rz cx-rz-nw" data-dir="nw"></span>
    <span class="cx-rz cx-rz-se" data-dir="se"></span>
    <span class="cx-rz cx-rz-sw" data-dir="sw"></span>
  `;
  document.documentElement.appendChild(panel);

  const titleEl = panel.querySelector('.cx-title');
  const bodyEl = panel.querySelector('.cx-body');
  const footEl = panel.querySelector('.cx-foot');
  const logEl = panel.querySelector('.cx-log');
  const minBtn = panel.querySelector('[data-act="min"]');
  const logBtn = panel.querySelector('[data-act="log"]');
  const scanBtn = panel.querySelector('[data-act="scan"]');
  const FALLBACK_VERSION = '2.9.1';
  const VERSION = (function () {
    try {
      if (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) {
        const v = String(GM_info.script.version).trim();
        if (v) return v;
      }
    } catch (e) { /* ignore */ }
    return FALLBACK_VERSION;
  })();
  // 更新检查：与仓库里的翻译脚本一致，只走菜单「更新」
  const UPDATE = {
    repo: 'SpecDock/MyScript',
    file: 'chaoxing-deadline-reminder.user.js',
    branches: ['master', 'main'],
    timeout: 6000,
    deadline: 10000
  };
  let logLines = [];

  function log(msg) {
    logLines.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
    if (logLines.length > 200) logLines.shift();
    if (logEl.style.display !== 'none') renderLog();
  }

  function renderLog() {
    logEl.innerHTML = logLines.length
      ? logLines.map(function (l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('')
      : '<div style="color:#94a3b8">暂无日志</div>';
  }

  logBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    const show = logEl.style.display === 'none';
    logEl.style.display = show ? '' : 'none';
    if (show) renderLog();
  });
  let rows = [];
  let endedRows = [];
  let chapterRows = [];
  let minimized = false;
  let loading = false;

  // 拖拽调整过大小后宽高是内联的，会盖掉 .is-min 的固定尺寸，最小化前先存起来。
  let savedSize = null;

  function setMinimized(next) {
    if (next === minimized) return;
    if (next) {
      savedSize = { width: panel.style.width, height: panel.style.height };
      panel.style.width = '';
      panel.style.height = '';
    } else if (savedSize) {
      panel.style.width = savedSize.width;
      panel.style.height = savedSize.height;
      savedSize = null;
    }
    minimized = next;
    panel.classList.toggle('is-min', minimized);
    bodyEl.style.display = minimized ? 'none' : '';
    footEl.style.display = minimized ? 'none' : '';
    minBtn.textContent = minimized ? '□' : '—';
    minBtn.title = minimized ? '还原' : '最小化';
  }

  minBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    setMinimized(!minimized);
  });
  // 扫描完全手动触发：刷新页面、切学期筛选都不会自动发请求，只有点按钮才扫。
  function setScanBtn(text, disabled) {
    scanBtn.textContent = text;
    scanBtn.disabled = !!disabled;
  }

  function renderIdle() {
    titleEl.textContent = '点击「▶ 扫描」开始';
    bodyEl.innerHTML = '<div class="cx-start">'
      + '<button type="button" data-act="start">▶ 开始扫描</button>'
      + '<p>只读取当前页面可见的课程（课程页按当前学期筛选）<br>读取作业、考试（含无截止时间）与未看完章节，另列最近30天已结束且未作答的作业</p></div>';
    const b = bodyEl.querySelector('[data-act="start"]');
    if (b) b.addEventListener('click', function (e) { e.stopPropagation(); startScan(); });
  }

  function startScan() {
    if (loading) return;
    setScanBtn('⟳ 扫描中', true);
    scan();
  }

  scanBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    startScan();
  });

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  panel.querySelector('.cx-bar').addEventListener('mousedown', function (e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dragging = true;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    const maxL = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxT = Math.max(0, window.innerHeight - 38);
    const left = Math.min(maxL, Math.max(0, e.clientX - offsetX));
    const top = Math.min(maxT, Math.max(0, e.clientY - offsetY));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  });
  document.addEventListener('mouseup', function () { dragging = false; });

  // 八方向拖边框调整大小。用 pointer 事件，同时兼容鼠标和触屏。
  let resizing = null;
  panel.querySelectorAll('.cx-rz').forEach(function (handle) {
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || minimized) return;
      const rect = panel.getBoundingClientRect();
      resizing = {
        dir: handle.getAttribute('data-dir') || '',
        x: e.clientX,
        y: e.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.width = rect.width + 'px';
      panel.style.height = rect.height + 'px';
      e.preventDefault();
      e.stopPropagation();
      try { if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
  });

  document.addEventListener('pointermove', function (e) {
    if (!resizing) return;
    const d = resizing.dir;
    const minW = Math.min(600, Math.max(320, window.innerWidth - 8));
    const minH = Math.min(200, Math.max(120, window.innerHeight - 8));
    const maxW = Math.max(minW, window.innerWidth - 8);
    const maxH = Math.max(minH, window.innerHeight - 8);
    const dx = e.clientX - resizing.x;
    const dy = e.clientY - resizing.y;
    let left = resizing.left;
    let top = resizing.top;
    let width = resizing.width;
    let height = resizing.height;

    if (d.indexOf('e') >= 0) width = resizing.width + dx;
    if (d.indexOf('s') >= 0) height = resizing.height + dy;
    if (d.indexOf('w') >= 0) width = resizing.width - dx;
    if (d.indexOf('n') >= 0) height = resizing.height - dy;

    width = Math.min(maxW, Math.max(minW, width));
    height = Math.min(maxH, Math.max(minH, height));
    if (d.indexOf('w') >= 0) left = resizing.left + resizing.width - width;
    if (d.indexOf('n') >= 0) top = resizing.top + resizing.height - height;
    // 尺寸到边界后继续拖，不能把面板挪出视口。
    left = Math.max(0, Math.min(left, window.innerWidth - width));
    top = Math.max(0, Math.min(top, window.innerHeight - height));

    panel.style.width = width + 'px';
    panel.style.height = height + 'px';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  });

  function stopResize() { resizing = null; }
  document.addEventListener('pointerup', stopResize);
  document.addEventListener('pointercancel', stopResize);

  function headerValue(res, name) {
    const raw = res.responseHeaders || '';
    const m = raw.match(new RegExp('^' + name + ':\\s*(.+)$', 'im'));
    return m ? m[1].trim() : '';
  }

  function absoluteUrl(base, loc) {
    try { return new URL(loc, base).href; } catch (e) { return loc; }
  }

  function redirectInHtml(text) {
    if (!text || text.length > 8000) return '';
    const meta = text.match(/http-equiv=["']?refresh["']?[^>]*url=([^"'>\s]+)/i);
    if (meta) return meta[1];
    const js = text.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
    return js ? js[1] : '';
  }

  // 超星的反爬验证页：命中时说明请求被判为异常（多为频率过高）。
  function isAntispider(page, pageUrl, status) {
    return /antispiderShowVerify/i.test(pageUrl || '')
      || (status === 202 && /提示页面|antispider/i.test(page))
      || /antispider/i.test(page);
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // ---------------- 按域名的请求限速 + 反爬熔断 ----------------
  // v2.1.0 用的是「全局串行队列 + 700ms 间隔」，172 个请求要 2~3 分钟。
  // 实测证明反爬是「指纹型」而不是「频率型」：
  //   · 课程页扫描的第 1 个请求（开始后 1 秒）就吃了 202 antispider，
  //     说明 mooc1 是无条件拒绝脚本的请求形态，限速根本拦不住它；
  //   · 而 mooc1-2 / mooc2-ans 承接 170+ 个请求全部 status=200。
  // 所以改成：按域名分别限速（限的是“发起时刻”的间隔），不同域名互不等待，
  // 再叠加课程级并发。172 个请求摊下来 ~24 秒。
  const hostState = {};
  let inflightTotal = 0;
  const slotWaiters = [];

  // 各域名的请求计数：日志里能直接看出负载摊到了哪几台机器上，
  // 以及某个域名是不是被打满了（逼近反爬的累计量阈值）。
  const hostHits = {};
  let totalHits = 0;
  // GM_xmlhttpRequest 会自己跟完 302：门户请求实际落到了 mooc2-ans，
  // 但那一跳没经过 hostRequest —— 既没限速也没计数。
  // 实测证据：一轮扫描 mooc2-ans 只记到 34 次（正好等于章节数），
  // 说明门户那一跳整个是「隐身」的，几十个门户同时砸过去 = 一批没有间隔的突发流量。
  const landHits = {};
  // 门户请求实际落到的域名（只认门户这一类，别让作业/考试的跳转把预占目标带偏）
  let portalLandHost = '';

  function resetHits() {
    Object.keys(hostHits).forEach(function (k) { delete hostHits[k]; });
    Object.keys(landHits).forEach(function (k) { delete landHits[k]; });
    portalLandHost = '';
    totalHits = 0;
  }

  // 只占位、不发请求：在某个域名上按它的间隔排一个队。
  // 目前保留给「需要把某类请求在某个域名上摊开」的场景使用。
  async function reserveSlot(host) {
    if (!host) return;
    const st = stOf(host);
    const now0 = Date.now();
    const startAt = Math.max(st.nextAt, now0);
    st.nextAt = startAt + st.gap;
    const gapWait = startAt - now0;
    if (gapWait > 0) await sleep(gapWait);
  }

  function hostOf(url) {
    try { return new URL(String(url)).hostname; } catch (e) { return ''; }
  }

  // 快速域名：mooc1-2 / mooc1-3 / mooc1-4（数据与门户） + mooc2-ans（章节与门户落点）。
  // 这四个是实测没被反爬拦过的，间隔可以压到 180ms；mooc1 及未知域名用慢速间隔。
  function isFastHost(host) {
    return /(^|\.)mooc1-2\.chaoxing\.com$/.test(host || '')
      || /(^|\.)mooc1-3\.chaoxing\.com$/.test(host || '')
      || /(^|\.)mooc1-4\.chaoxing\.com$/.test(host || '')
      || /(^|\.)mooc2-ans\.chaoxing\.com$/.test(host || '');
  }

  function stOf(host) {
    if (!hostState[host]) {
      hostState[host] = {
        gap: isFastHost(host) ? FAST_GAP : SLOW_GAP,
        nextAt: 0
      };
    }
    return hostState[host];
  }

  // 命中反爬：整轮弃用该域名。
  // 关键是「不设冷却」——冷却会把所有已经排在这个域名队列里的请求一起卡住，
  // 整轮扫描会被拖成 1 分钟（实测 58.6 秒）。正确做法是：
  // 已排队的请求立刻失败并顺延到下一个宿主，剩余流量自动转移。
  function penalize(host) {
    if (!host) return;
    const h = /:\/\//.test(host) ? hostOf(host) : host;
    if (!h) return;
    const st = stOf(h);
    st.gap = Math.min(MAX_HOST_GAP, Math.round(st.gap * 3));
    if (!bannedHost[h]) {
      bannedHost[h] = true;
      log('域名 ' + h + ' 本轮弃用，后续请求改走其它宿主');
    }
  }

  function resetBans() {
    Object.keys(bannedHost).forEach(function (k) { delete bannedHost[k]; });
    Object.keys(badDataHost).forEach(function (k) { delete badDataHost[k]; });
    // 退避后的间隔也一并还原：新一轮扫描是全新的开始
    Object.keys(hostState).forEach(function (k) {
      const st = hostState[k];
      st.gap = isFastHost(k) ? FAST_GAP : SLOW_GAP;
      st.nextAt = 0;
    });
  }

  async function acquireSlot() {
    if (inflightTotal < MAX_INFLIGHT) {
      inflightTotal++;
      return;
    }
    await new Promise(function (r) { slotWaiters.push(r); });
    inflightTotal++;
  }

  function releaseSlot() {
    inflightTotal--;
    const w = slotWaiters.shift();
    if (w) w();
  }

  // 发起时刻间隔：同步预占一个时间片，避免并发调用挤在同一毫秒上。
  async function hostRequest(host, fn) {
    if (bannedHost[host]) throw new Error(host + ' 本轮已弃用');
    hostHits[host] = (hostHits[host] || 0) + 1;
    totalHits += 1;
    const st = stOf(host);
    const now0 = Date.now();
    const startAt = Math.max(st.nextAt, now0);
    st.nextAt = startAt + st.gap;
    const gapWait = startAt - now0;
    if (gapWait > 0) await sleep(gapWait);
    // 等待期间这个域名可能已经被弃用（命中反爬），立刻失败并顺延到下一个宿主，
    // 而不是把请求白发给一个必然被拦的域名。
    if (bannedHost[host]) throw new Error(host + ' 本轮已弃用');
    await acquireSlot();
    try {
      return await fn();
    } finally {
      releaseSlot();
    }
  }

  // 带浏览器特征头请求，降低被超星判为爬虫的概率。
  function browserHeaders(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { host = ''; }
    return {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://' + host + '/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1'
    };
  }

  // 真正的单次请求（不做限速、不做冷却判断，由 httpOnce 统一调度）。
  // 302 跳转的每一跳也要按“落点域名”限速：门户请求是
  // mooc1-2 → mooc2-ans 的两跳，如果落点不限速，mooc2-ans 会收到
  // 一批没被间隔约束的突发流量。
  function rawRequest(url, hops) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: String(url),
        timeout: FETCH_TIMEOUT,
        anonymous: false,
        headers: browserHeaders(url),
        onload: function (res) {
          const landed = res.finalUrl || String(url);
          const loc = headerValue(res, 'location');
          const text = res.responseText || '';
          if (res.status >= 300 && res.status < 400 && loc && (hops || 0) < 6) {
            const next = absoluteUrl(landed, loc);
            hostRequest(hostOf(next), function () { return rawRequest(next, (hops || 0) + 1); }).then(resolve, reject);
            return;
          }
          const jump = redirectInHtml(text);
          if (jump && (hops || 0) < 6) {
            const next = absoluteUrl(landed, jump);
            hostRequest(hostOf(next), function () { return rawRequest(next, (hops || 0) + 1); }).then(resolve, reject);
            return;
          }
          // 走到这里说明 GM 自己把 302 跟完了：响应是落点域名发出来的，
          // 但那一跳没经过 hostRequest（既没限速也没计数）。
          // 记下落点，后面同类请求先在它上面占个位置，把突发流量摊平。
          const reqHost = hostOf(url);
          const landHost = hostOf(landed);
          if (landHost && reqHost && landHost !== reqHost) {
            landHits[landHost] = (landHits[landHost] || 0) + 1;
          }
          resolve({
            text: text,
            url: landed,
            status: res.status,
            antispider: isAntispider(text, landed, res.status)
          });
        },
        onerror: function () { reject(new Error('网络错误')); },
        ontimeout: function () { reject(new Error('超时')); }
      });
    });
  }

  // 对外入口：按域名限速 + 冷却；命中反爬时把“最终落点域名”拉黑退避。
  // 关键点：课程页卡片链接 /courselist/opencoursenewfy 会 302 到 mooc1.chaoxing.com，
  // 而 mooc1 对脚本请求有反爬，所以必须把最终落点（mooc1）而不是请求域名拉黑。
  async function httpOnce(url, hops) {
    const host = hostOf(url);
    const res = await hostRequest(host, function () { return rawRequest(url, hops); });
    if (res.antispider) {
      const served = hostOf(res.url);
      // 把反爬页的前 120 个字打出来：到底是谁吐出了反爬页、是不是误判，一眼可见
      const snippet = String(res.text || '').replace(/\s+/g, ' ').slice(0, 120);
      log('⚠ 命中反爬：发出方=' + host + ' 吐出方=' + served + ' status=' + res.status
        + ' 正文前120字=' + snippet);
      penalize(served);
    }
    return res;
  }

  function isLoginPage(page, pageUrl) {
    return /passport2\.chaoxing\.com/.test(pageUrl || '')
      || /<title>\s*用户登录\s*<\/title>/i.test(page)
      || /id="loginBtn"/.test(page);
  }

  // 取课程门户参数：enc / t / workEnc / examEnc / cpi / moocDomainName。
  // 课程门户的 stu 页把这些值放在隐藏域里，地址栏也带 enc 与 t。
  // issuerHost 是「发起这次门户请求的域名」，不是最终落点：
  // 门户页是 302 落到 mooc2-ans 的，但 mooc2-ans 没有 /mooc2/work/list 这条路由（404），
  // 作业和考试必须回到发起方（mooc1-2/3/4）去读。
  function readCourseParams(page, pageUrl, issuerHost) {
    const enc = field(page, 'enc') || queryParam(pageUrl, 'enc') || queryParam(pageUrl, 'stuenc');
    const t = field(page, 't') || queryParam(pageUrl, 't');
    return {
      enc: enc,
      t: t,
      oldenc: field(page, 'oldenc'),
      workEnc: field(page, 'workEnc'),
      examEnc: field(page, 'examEnc'),
      cpi: field(page, 'cpi') || queryParam(pageUrl, 'cpi'),
      domain: field(page, 'moocDomainName') || 'https://mooc1.chaoxing.com',
      host: issuerHost ? 'https://' + issuerHost
        : (hostOf(pageUrl) ? 'https://' + hostOf(pageUrl) : ''),
      landHost: hostOf(pageUrl) || ''
    };
  }

  // 课程门户新版页同时具备 workEnc/examEnc 隐藏域，才算真的进了课程。
  function hasPortalFields(p) {
    return !!(p.enc && p.t && (p.workEnc || p.examEnc));
  }

  // 课程门户的候选入口，按可靠性排序。
  //
  // 实测（2026-10-19 / 2026-10-21 用户日志 + 浏览器验证）：
  //  · 课程页（v24/wfw/courselist/course3）的卡片链接是相对路径 /courselist/opencoursenewfy，
  //    它会 302 到 mooc1.chaoxing.com —— 而 mooc1 对脚本请求有反爬，返回 202 antispiderShowVerify。
  //    于是 enc/t/workEnc/examEnc 一个都拿不到，后面作业/考试的多域名回退根本轮不到执行。
  //  · 通用课程页的卡片链接本身就是 stucoursemiddle，直落 mooc2-ans 门户，可以直接用。
  //  · stucoursemiddle 必须带 ismooc2=1 才会进新版门户（否则落旧版页，没有 t）。
  //  · mooc1-2.chaoxing.com 上 stucoursemiddle 路由存在且不受反爬影响（浏览器实测：
  //    https://mooc1-2.chaoxing.com/visit/stucoursemiddle?courseid=204567725&clazzid=106500144&ismooc2=1
  //    → https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?...&enc=73ea...&t=1792416940012）
  //
  // 所以课程页必须改走 mooc1-2 的 stucoursemiddle，opencoursenewfy 只作最后兜底。
  function portalCandidates(course, step) {
    const q = 'courseid=' + encodeURIComponent(course.courseId)
      + '&clazzid=' + encodeURIComponent(course.classId)
      + '&cpi=' + encodeURIComponent(course.cpi || '');
    const href = course.href || '';
    // opencoursenewfy / courselist 形式的卡片链接最终会落到 mooc1，先不放在最前面。
    const cardIsOpenCourse = /opencoursenewfy/.test(href) || /\/courselist\//.test(href);
    // 卡片链接本身就是 stucoursemiddle 时（通用课程页），mooc1-2/3/4 的 mids 是同一条路由，
    // 只是换了宿主。所以把卡片链接的域名换成轮换出来的宿主、参数（vc=1 等）原样保留，
    // 这样既能把门户请求摊到 3 台机器上，又保持用户实测过的那条 URL 形态。
    // 自定义域名（学校自己的 mooc 域）不在此列——那种情况卡片链接必须排第一。
    const cardIsMiddle = /stucoursemiddle/.test(href);
    const cardIsChaoxing = /(^|\.)chaoxing\.com$/.test(hostOf(href));
    const list = [];
    // mooc1-2 / mooc1-3 / mooc1-4 都支持 stucoursemiddle，是门户参数的三个可用宿主，
    // 按课程序号轮换起点：单主机只承担 1/3 的请求量，既快又不容易触发累计量阈值。
    const mids = rotateHosts([
      { family: 'mid2', url: 'https://mooc1-2.chaoxing.com/visit/stucoursemiddle?' + q + '&ismooc2=1' },
      { family: 'mid3', url: 'https://mooc1-3.chaoxing.com/visit/stucoursemiddle?' + q + '&ismooc2=1' },
      { family: 'mid4', url: 'https://mooc1-4.chaoxing.com/visit/stucoursemiddle?' + q + '&ismooc2=1' }
    ], step || 0);
    if (cardIsMiddle && cardIsChaoxing) {
      const cardUrl = withIsmooc2(href);
      const path = cardUrl.replace(/^https?:\/\/[^/]+/, '');
      mids.forEach(function (m) {
        list.push({ family: m.family, url: 'https://' + hostOf(m.url) + path });
      });
      // 卡片链接本身可能就等于某个 mid（例如卡片在 mooc1-2、而本轮起点也是 mooc1-2），
      // 重复的候选只会白白发一次请求，这里去掉。
      if (!list.some(function (c) { return c.url === cardUrl; })) {
        list.push({ family: 'card', url: cardUrl });
      }
    } else {
      if (href && !cardIsOpenCourse) {
        list.push({ family: 'card', url: withIsmooc2(href) });
      }
      list.push.apply(list, mids);
      if (href && cardIsOpenCourse) {
        list.push({ family: 'card', url: href });
      }
    }
    list.push({
      family: 'mid1',
      url: 'https://mooc1.chaoxing.com/visit/stucoursemiddle?' + q + '&ismooc2=1'
    });
    // 已被反爬整轮弃用的域名直接剔除；全被剔除就解除弃用重新开始
    const usable = list.filter(function (c) { return !isBanned(hostOf(c.url)); });
    if (!usable.length) {
      log('所有门户入口都已弃用，解除弃用重新开始');
      resetBans();
      return list;
    }
    return usable;
  }

  // 通用课程页的卡片链接需要补 ismooc2=1 才进新版门户。
  function withIsmooc2(href) {
    if (/stucoursemiddle/.test(href) && !/ismooc2=1/.test(href)) {
      return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'ismooc2=1';
    }
    return href;
  }

  // 超星的错误页（non-existent）与登录页都要单独识别，避免误报参数缺失。
  function isErrorPage(page) {
    return /<title>\s*non-existent\s*<\/title>/i.test(page)
      || /error-page\/css\/style\.css/i.test(page);
  }

  // 超星的「提示」页（title=提示、正文很短）：这个域名上没有这门课的数据。
  // 它不是错误信号：绝大多数课程本来就没有作业/考试，服务器就回这个页面。
  function isHintPage(page) {
    const title = (String(page).match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    return /^\s*提示\s*$/.test(title) && String(page).length < 5000;
  }

  // 抓取数据页（作业/考试/章节）。带候选域名回退。
  // buildUrl(domain) 由调用方给出对应域名的完整地址。
  //
  // 「提示」页（title=提示、正文很短）不是错误，而是「这个域名上没有这门课的数据」。
  // 实测（2026-10-20）：大多数课程本来就没有作业/考试，服务器就是返回提示页。
  // 旧逻辑把它当失败，换域名再试 + 整轮再重试一次 —— 光是最后落到 mooc1 的那几十次
  // 白等（1.5 秒一次），一轮扫描就被拖到 89 秒。
  //
  // 现在的判定：发起方（签发 workEnc/examEnc 的那个域名）说「没有数据」，那就是没有数据，
  // 直接返回空结果，不再换域名、不进重试轮 —— 这一条是提速的关键。
  // 只有当请求发到的是兜底域名时，才值得再换一个快宿主试试。
  async function fetchData(buildUrl, label, domains, opts) {
    opts = opts || {};
    const list = domains || [null];
    const hintLimit = opts.hintLimit == null ? 2 : opts.hintLimit;
    const primary = opts.primaryHost || '';
    let last = '请求失败';
    let hints = 0;
    for (let d = 0; d < list.length; d++) {
      const dom = list[d];
      const url = buildUrl(dom);
      for (let attempt = 1; attempt <= 2; attempt++) {
        let got;
        const t0 = Date.now();
        try {
          got = await httpOnce(url, 0);
        } catch (e) {
          last = e && e.message ? e.message : '请求失败';
          log(label + '[' + dom + '] 请求异常: ' + last + '（' + (Date.now() - t0) + 'ms）');
          break;
        }
        const cost = Date.now() - t0;
        if (got.antispider) {
          last = '被超星反爬拦截';
          log(label + '[' + dom + '] 命中超星反爬，换域名重试（' + cost + 'ms）');
          await sleep(300);
          break;
        }
        if (isLoginPage(got.text, got.url)) {
          last = '登录已失效';
          log(label + '[' + dom + '] 跳登录页，换域名重试');
          break;
        }
        // 4xx/5xx 是「这个域名没有这条路由」，不是「这门课没有作业」。
        // 以前把它当成功，404 页面被解析成 0 条，作业/考试会静默全灭。
        if (got.status >= 400) {
          last = 'HTTP ' + got.status;
          log(label + '[' + dom + '] HTTP ' + got.status + '（这个域名没有这条路由），换域名重试（'
            + cost + 'ms）');
          break;
        }
        if (isErrorPage(got.text)) {
          last = '超星错误页';
          log(label + '[' + dom + '] 超星错误页（non-existent），换域名重试');
          break;
        }
        if (isHintPage(got.text)) {
          hints += 1;
          const isPrimary = !!(primary && dom === primary);
          log(label + '[' + dom + '] 返回「提示」页：这个域名上没有这门课的数据（' + cost + 'ms）'
            + (isPrimary ? '（发起方域名，确认无数据）' : ''));
          if (isPrimary || hints >= hintLimit) {
            log(label + ' 判定：确实没有数据，不再换域名、也不再重试');
            return { text: '', url: got.url, status: got.status, empty: true };
          }
          break;
        }
        const title = (String(got.text).match(/<title>([^<]*)<\/title>/i) || [])[1] || '(无title)';
        log(label + '[' + dom + '] status=' + got.status + ' len=' + String(got.text).length
          + ' title=' + title + '（' + cost + 'ms）');
        return got;
      }
    }
    // 候选域名都用完了，但至少有一个回了「提示」页：说明确实没有数据，不是失败
    if (hints > 0) {
      log(label + ' 判定：确实没有数据（不再重试）');
      return { text: '', url: '', status: 0, empty: true };
    }
    throw new Error(last);
  }

  // 某一类入口一旦整体命中反爬，本轮扫描就不再用它（避免 40 多门课各撞一次）。
  // 按“入口页路径 + 入口类型”分桶：课程页的卡片链接被判反爬，
  // 不应该影响到通用课程页那张本来好用的卡片链接。
  const badEntry = {};
  const pageKey = location.pathname;

  // 依次尝试候选入口，直到拿到完整课程门户参数。
  // step 是课程序号：门户入口必须按它轮换宿主，否则门户请求会全部压到 mooc1-2 上。
  async function openPortal(course, step) {
    const cands = portalCandidates(course, step);
    let sawLogin = false;
    let last = '没有拿到课程参数';
    log('[' + course.name + '] 开始，候选入口 ' + cands.length + ' 个');
    for (let i = 0; i < cands.length; i++) {
      const cand = cands[i];
      const key = pageKey + '|' + cand.family;
      if (badEntry[key]) {
        log('[' + course.name + '] 跳过入口' + (i + 1) + '（' + cand.family + ' 本轮已被反爬标记）');
        continue;
      }
      let got;
      try {
        got = await httpOnce(cand.url, 0);
      } catch (e) {
        last = e && e.message ? e.message : '请求失败';
        log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 请求异常: ' + last);
        continue;
      }
      // 这一跳是 GM 内部跟的：落点域名不受限速，记下来便于排查
      const landHost = hostOf(got.url);
      if (landHost && landHost !== hostOf(cand.url)) {
        portalLandHost = landHost;
        log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 实际落点=' + landHost
          + '（这一跳是 GM 内部跟的，不受本脚本限速）');
      }
      const title = (String(got.text).match(/<title>([^<]*)<\/title>/i) || [])[1] || '(无title)';
      const len = String(got.text).length;
      log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') status=' + got.status
        + ' len=' + len + ' title=' + title + ' 最终URL=' + String(got.url).slice(0, 150));
      if (got.antispider) {
        last = '被超星反爬拦截';
        // 卡片链接（opencoursenewfy）会整体落到 mooc1，一旦被拦就整轮弃用这一类入口。
        if (cand.family === 'card') badEntry[key] = true;
        log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 判定=反爬拦截'
          + (cand.family === 'card' ? '，本轮不再使用卡片链接' : ''));
        await sleep(300);
        continue;
      }
      if (isLoginPage(got.text, got.url)) {
        sawLogin = true;
        last = '登录已失效';
        log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 判定=登录页');
        continue;
      }
      if (isErrorPage(got.text)) {
        last = '课程入口已失效';
        log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 判定=超星错误页');
        continue;
      }
      if (isHintPage(got.text)) {
        last = '入口返回提示页';
        log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 判定=「提示」页，换下一个入口');
        continue;
      }
      const p = readCourseParams(got.text, got.url, hostOf(cand.url));
      log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 取到 enc=' + (p.enc || '(空)')
        + ' t=' + (p.t || '(空)') + ' workEnc=' + (p.workEnc ? '有' : '(空)')
        + ' examEnc=' + (p.examEnc ? '有' : '(空)') + ' cpi=' + (p.cpi || '(空)')
        + ' 发起域名=' + (p.host || '(空)') + ' 落点=' + (p.landHost || '(空)'));
      if (hasPortalFields(p)) {
        log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 成功');
        return p;
      }
      last = '没有拿到课程参数';
      log('[' + course.name + '] 入口' + (i + 1) + '(' + cand.family + ') 判定=参数不全');
    }
    throw new Error(last || (sawLogin ? '登录已失效' : '没有拿到课程参数'));
  }

  function queryParam(url, name) {
    const m = String(url || '').match(new RegExp('[?&]' + name + '=([^&#]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function field(html, id) {
    const patterns = [
      new RegExp('id="' + id + '"[^>]*value="([^"]*)"', 'ig'),
      new RegExp('value="([^"]*)"[^>]*id="' + id + '"', 'ig'),
      new RegExp("id='" + id + "'[^>]*value='([^']*)'", 'ig'),
      new RegExp("value='([^']*)'[^>]*id='" + id + "'", 'ig')
    ];
    for (let i = 0; i < patterns.length; i++) {
      let m;
      while ((m = patterns[i].exec(html))) {
        if (m[1]) return decode(m[1]);
      }
    }
    return '';
  }

  function decode(s) {
    const t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 探测页面上真实存在的课程容器与卡片选择器，避免选择器猜错导致整页 0 门。
  function probePage() {
    const hits = [];
    ['#courseList', '#courselistArea', 'li.w_couritem', '#stuCourseList', 'li.courseItem', 'li.course-item', '.course.learnCourse']
      .forEach(function (sel) {
        const n = document.querySelectorAll(sel).length;
        hits.push(sel + '=' + n);
      });
    log('选择器探测: ' + hits.join(' '));
    const area = document.querySelector('#courselistArea') || document.querySelector('#stuCourseList');
    if (area) {
      const kids = area.querySelectorAll('li, .course-item');
      log('容器 ' + (area.id || area.className) + ' 下子项 ' + kids.length + ' 个');
      if (kids.length) {
        const one = kids[0];
        log('首个卡片 class="' + (one.className || '') + '" 文本='
          + String(one.innerText || '').replace(/\s+/g, ' ').slice(0, 80));
        const a = one.querySelector('a[href]');
        if (a) log('首个卡片链接: ' + String(a.getAttribute('href')).slice(0, 180));
      }
    }
  }

  // 通用课程页（/visit/courses）卡片结构（实测）：
  //   li.courseItem > input[name=courseId] / input[name=classId]
  //                > a.courseName[title=课程名][href=stucoursemiddle?courseid=&clazzid=&cpi=]
  function parseCommonCourses() {
    const out = [];
    document.querySelectorAll('li.courseItem').forEach(function (li) {
      const courseId = (li.querySelector('input[name="courseId"]') || {}).value || '';
      const classId = (li.querySelector('input[name="classId"]') || {}).value || '';
      const nameEl = li.querySelector('a.courseName, h3 a[title]');
      const name = ((nameEl && (nameEl.getAttribute('title') || nameEl.textContent)) || '').trim();
      const a = li.querySelector('a.courseName') || li.querySelector('a[href*="stucoursemiddle"]');
      const href = (a && a.href) || '';
      if (!courseId || !classId || !name) {
        log('通用课程卡片缺参数 courseId=' + courseId + ' classId=' + classId + ' name=' + name);
        return;
      }
      const cpi = (href.match(/[?&]cpi=(\d+)/) || [])[1] || '';
      const cardText = (li.innerText || '').replace(/\s+/g, '');
      out.push(courseItem(name, courseId, classId, cpi, href, cardText, detectEnded(cardText, li)));
    });
    return out;
  }

  // 新版通用课程页（mooc2-ans 的 /mooc2-ans/visit/interaction，以及 mooc1-2 的同名过渡页）
  // 卡片结构（实测 2026-11）：
  //   div.course.learnCourse[info="classId_cpi"]
  //     > input[name=clazzId] / input[name=courseId] / input.curPersonId
  //     > a[href*=stucoursemiddle] > span.course-name[title]
  // 注意新版隐藏域叫 clazzId（不是 classId），旧解析器会读空。
  function parseMooc2Courses() {
    const out = [];
    document.querySelectorAll('.courselistArea .course, .course.learnCourse').forEach(function (el) {
      const val = function (sel) {
        const x = el.querySelector(sel);
        return (x && x.value ? x.value : '').trim();
      };
      const info = el.getAttribute('info') || '';
      const hrefEl = el.querySelector('a[href*="stucoursemiddle"]') || el.querySelector('a.color1[href]');
      const href = (hrefEl && hrefEl.href) || '';
      const pick = function (re) { return (href.match(re) || [])[1] || ''; };
      const courseId = val('input[name="courseId"], input.courseId') || pick(/[?&]courseid=(\d+)/i);
      const classId = val('input[name="clazzId"], input.clazzId')
        || (info.split('_')[0] || '') || pick(/[?&]clazzid=(\d+)/i);
      const cpi = val('input.curPersonId')
        || (info.split('_')[1] || '') || pick(/[?&]cpi=(\d+)/i);
      const nameEl = el.querySelector('span.course-name, a.color1[title]');
      const name = ((nameEl && (nameEl.getAttribute('title') || nameEl.textContent)) || '').trim();
      if (!courseId || !classId || !name) {
        log('新版课程卡片缺参数 courseId=' + courseId + ' classId=' + classId + ' name=' + name);
        return;
      }
      if (!isShown(el)) return;
      const cardText = (el.innerText || '').replace(/\s+/g, '');
      out.push(courseItem(name, courseId, classId, cpi, href, cardText, detectEnded(cardText, el)));
    });
    return out;
  }

  function coursesFromPage() {
    const list = [];
    // 新版通用课程（mooc2-ans / mooc1-2 的 visit/interaction）
    list.push.apply(list, parseMooc2Courses());
    // 通用课程（/visit/courses）
    list.push.apply(list, parseCommonCourses());
    // 兼容旧版通用课程页的选择器
    document.querySelectorAll('#courseList li.course').forEach(function (li) {
      const a = li.querySelector('a.color1, a[href*="courseid="]');
      if (!a) return;
      const href = a.href || '';
      const courseId = (href.match(/[?&](?:courseid|courseId)=(\d+)/) || [])[1];
      const classId = (href.match(/[?&](?:clazzid|clazzId)=(\d+)/) || [])[1];
      const cpi = (href.match(/[?&]cpi=(\d+)/) || [])[1];
      const nameEl = li.querySelector('.course-name, .courseName, [title]');
      const name = ((nameEl && (nameEl.getAttribute('title') || nameEl.textContent)) || '').trim();
      if (!courseId || !classId || !name) return;
      const cardText = (li.innerText || '').replace(/\s+/g, '');
      list.push(courseItem(name, courseId, classId, cpi, href, cardText, detectEnded(cardText, li)));
    });
    // 课程（/wfw/courselist/course3）
    document.querySelectorAll('li.w_couritem').forEach(function (li) {
      const courseId = li.getAttribute('cid');
      const classId = li.getAttribute('classid');
      const cpi = li.getAttribute('personid') || '';
      const name = (li.getAttribute('cname') || '').trim();
      const a = li.querySelector('a[href*="opencoursenewfy"]');
      if (!courseId || !classId || !name || !a) return;
      if (!isShown(li)) return;
      const cardText = (li.innerText || '').replace(/\s+/g, '');
      list.push(courseItem(name, courseId, classId, cpi, a.href, cardText, detectEnded(cardText, li)));
    });
    // 同一张卡片可能同时命中新旧选择器，按「课程+班级」去重。
    const seen = {};
    return list.filter(function (c) {
      const key = c.courseId + ':' + c.classId;
      if (seen[key]) return false;
      seen[key] = 1;
      return true;
    });
  }

  function isShown(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      const st = window.getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      n = n.parentElement;
    }
    return true;
  }

  // 卡片上的结课标记。通用课程页用文字「已开启结课模式」，课程页用 state=1 / .not-open-tip。
  function detectEnded(cardText, el) {
    const t = String(cardText || '');
    if (/已开启结课模式|已结课|已结束/.test(t)) return true;
    if (el) {
      if (el.getAttribute && el.getAttribute('state') === '1') return true;
      if (el.querySelector && el.querySelector('.not-open-tip')) return true;
    }
    return false;
  }

  // 课程起止时间。实测有两种写法：
  //   开课时间：2026-03-02~2027-02-20
  //   课程时间：2026年10月12日-2028年10月12日
  function parseTermEnd(cardText) {
    const t = String(cardText || '');
    const iso = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*[～~—\-–至到]\s*(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) {
      const end = new Date(iso[4] + '/' + iso[5] + '/' + iso[6] + ' 23:59:59').getTime();
      return isNaN(end) ? null : end;
    }
    const cn = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*[～~—\-–至到]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (cn) {
      const end = new Date(cn[4] + '/' + cn[5] + '/' + cn[6] + ' 23:59:59').getTime();
      return isNaN(end) ? null : end;
    }
    return null;
  }

  function courseItem(name, courseId, classId, cpi, href, cardText, ended) {
    const endMs = ended ? 0 : parseTermEnd(cardText);
    return { name: name, courseId: courseId, classId: classId, cpi: cpi || '', href: href, endMs: endMs, ended: !!ended };
  }

  function parseDeadline(text, now) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t) return null;
    // 「已结束/已截止」只说明状态，不给出时间：交给调用方标记 ended，
    // 真实结束时间只能从作业详情页拿（以前这里返回 now-60000 会让排序和展示都失真）。
    if (/已结束|已截止|已过期/.test(t)) return null;
    let ms = 0;
    let hit = false;
    const day = t.match(/(\d+)天/);
    const hour = t.match(/(\d+)小时/);
    const min = t.match(/(\d+)分/);
    if (day || hour || min) {
      hit = true;
      if (day) ms += Number(day[1]) * 86400000;
      if (hour) ms += Number(hour[1]) * 3600000;
      if (min) ms += Number(min[1]) * 60000;
    }
    if (hit && /剩余|还剩/.test(t)) return now + ms;
    const dates = t.match(/20\d{2}-\d{2}-\d{2}\d{2}:\d{2}/g) || text.match(/20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}/g);
    if (dates && dates.length) {
      const last = dates[dates.length - 1].replace(/(\d{4}-\d{2}-\d{2})(\d{2}:)/, '$1 $2').replace(/-/g, '/');
      const ts = new Date(last).getTime();
      if (!isNaN(ts)) return ts;
    }
    return null;
  }

  // 未设置截止时间的任务，超星不会渲染 .time 元素（或留空）。
  // 注意：列表页只在「还有剩余时间」时才渲染 .time，已经结束的作业同样没有 .time，
  // 所以列表本身区分不了「已结束」和「没设置截止时间」。
  // 这里先保留所有无时间的作业（交给详情页确认结束时间），已完成/待批阅的也保留：
  // 用户需要看到「确实没有截止时间」的作业，包括已经提交的；只有确实有截止时间且已经过期的才丢弃。
  // 返回的每条记录可能是：
  //   · 正常未截止：deadline > now；
  //   · 无截止时间：noDue=true，交给详情页确认（列表页不给 .time）；
  //   · 已结束：ended=true，endTime 可能为 null（列表只说「已结束」），同样交给详情页补时间。
  function parseTasks(html, courseName, kind, now) {
    const out = [];
    let doc = null;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { doc = null; }
    if (doc) doc.querySelectorAll('.bottomList li, .task-list li').forEach(function (li) {
      const name = ((li.querySelector('.overHidden2') || {}).textContent || '').trim();
      const status = ((li.querySelector('.status') || {}).textContent || '').replace(/\s+/g, '');
      const timeText = ((li.querySelector('.time') || {}).textContent || '').replace(/\s+/g, '');
      if (!name) return;
      if (/已过期|已失效|已结束/.test(status)) return;
      const settled = /待批阅|待批改|已完成|已批阅/.test(status);
      let deadline = parseDeadline(timeText, now);
      let ended = /已结束|已截止|已过期/.test(timeText);
      let endTime = null;
      if (deadline != null && deadline <= now) {
        ended = true;
        endTime = deadline;
        deadline = null;
      }
      // 考试列表没有详情页可确认时间，已完成的考试保持原样（无时间就不列），避免误标成无截止。
      if (deadline == null && settled && kind !== '作业') return;
      out.push({
        course: courseName,
        work: name,
        kind: kind,
        status: status,
        settled: settled,
        deadline: deadline,
        noDue: deadline == null,
        ended: ended,
        endTime: endTime,
        detailUrl: kind === '作业' ? (li.getAttribute('data') || '') : ''
      });
    });
    if (out.length || !/剩余|还剩/.test(html)) return out;
    html.split(/<li\b/i).slice(1).forEach(function (part) {
      const name = textOf(part.match(/class="overHidden2[^"]*"[^>]*>([\s\S]*?)<\/p>/i));
      const status = textOf(part.match(/class="status[^"]*"[^>]*>([\s\S]*?)<\/p>/i)).replace(/\s+/g, '');
      const timeText = textOf(part.match(/class="time[^"]*"[^>]*>([\s\S]*?)<\/div>/i)).replace(/\s+/g, '');
      if (!name) return;
      if (/已过期|已失效|已结束/.test(status)) return;
      const settled = /待批阅|待批改|已完成|已批阅/.test(status);
      let deadline = parseDeadline(timeText, now);
      let ended = /已结束|已截止|已过期/.test(timeText);
      let endTime = null;
      if (deadline != null && deadline <= now) {
        ended = true;
        endTime = deadline;
        deadline = null;
      }
      if (deadline == null && settled && kind !== '作业') return;
      const detailUrl = decode((part.match(/data="([^"]+)"/) || [])[1] || '');
      out.push({
        course: courseName, work: name, kind: kind, status: status, settled: settled,
        deadline: deadline, noDue: deadline == null, ended: ended, endTime: endTime,
        detailUrl: kind === '作业' ? detailUrl : ''
      });
    });
    return out;
  }

  // 作业详情页的「作答时间: 开始 至 结束」。已结束的作业也保留这一段，
  // 这是列表页之外唯一能拿到结束时间的地方。
  function parseWorkTimeRange(html) {
    const raw = String(html || '');
    const m = raw.match(
      /作答时间[：:]\s*<em>([^<]+)<\/em>\s*至\s*<em>([^<]+)<\/em>/
    );
    if (m) return { start: m[1].trim(), end: m[2].trim() };
    const text = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    const plain = text.match(
      /作答时间[：:]\s*(20\d{2}-\d{2}-\d{2}\s*\d{2}:\d{2})\s*至\s*(20\d{2}-\d{2}-\d{2}\s*\d{2}:\d{2})/
    );
    if (plain) return { start: plain[1], end: plain[2] };
    return null;
  }

  function parseDateTimeText(s) {
    const t = String(s || '').trim().replace(/-/g, '/');
    if (!t) return null;
    const ts = new Date(t).getTime();
    return isNaN(ts) ? null : ts;
  }

  // 详情页地址换成另一个数据宿主（路径与参数不变）。
  // 作业详情页也是按课程分片存放的，某个宿主被反爬弃用时要能换一个读。
  function swapOrigin(url, domain) {
    try {
      const u = new URL(String(url));
      const base = String(domain || '').replace(/\/+$/, '');
      return base ? base + u.pathname + u.search : String(url);
    } catch (e) {
      return String(url);
    }
  }

  // 详情页确认结果的缓存：detailUrl → { end: 时间戳 | null }。
  // 已完成/待批阅的作业在后台确认，后续扫描直接复用，不会每次都重新请求。
  const workTimeCache = Object.create(null);

  // end == null 表示详情页「作答时间」没有结束时间，也就是确实没有截止时间。
  // 注意：列表已经标记「已结束」的行不能因此改判为无截止，保持原来的 ended 状态。
  function applyWorkTime(r, cached, now) {
    if (!cached) return;
    if (cached.end == null) {
      if (!r.ended) {
        r.endTime = null;
        r.deadline = null;
        r.noDue = true;
      }
      return;
    }
    r.endTime = cached.end;
    if (cached.end <= now) {
      r.ended = true;
      r.deadline = null;
      r.noDue = false;
    } else {
      r.ended = false;
      r.deadline = cached.end;
      r.noDue = false;
    }
  }

  async function fetchWorkTime(r, label, domains, now) {
    const origin = hostOf(r.detailUrl) ? 'https://' + hostOf(r.detailUrl) : '';
    const detailDomains = origin
      ? [origin].concat((domains || []).filter(function (d) { return d !== origin; }))
      : domains;
    const got = await fetchData(function (d) { return swapOrigin(r.detailUrl, d); },
      label + ' 详情', detailDomains, { primaryHost: origin });
    if (got.empty) return false;
    const range = parseWorkTimeRange(got.text);
    const end = range ? parseDateTimeText(range.end) : null;
    workTimeCache[r.detailUrl] = { end: end };
    applyWorkTime(r, workTimeCache[r.detailUrl], now);
    return true;
  }

  // 列表页没给时间的未完成作业，逐条进详情页确认：
  //   · 有结束时间且已过 → 真·已结束，记下 endTime（30 天内且未作答的会进「已结束」分区）；
  //   · 有结束时间且未到 → 正常带截止时间显示（列表没渲染剩余时间时的兜底）；
  //   · 详情页没有作答时间 → 确实没有截止时间，保留并标记为无截止。
  // 「已结束」的条目也要读详情：列表只说状态，结束时间只有详情页有。
  // 已完成/待批阅的行不在这里同步确认——数量多，会把扫描拖慢，改到扫描结束后后台处理。
  async function resolveNoDueWorks(list, label, now, domains) {
    const pending = list.filter(function (r) {
      return (r.noDue || r.ended) && !r.settled && r.detailUrl;
    });
    if (!pending.length) return list;
    log(label + ' 有 ' + pending.length + ' 条列表未给时间的作业，读取详情页确认截止/结束时间');
    await mapPool(pending, 3, async function (r) {
      try {
        const cached = workTimeCache[r.detailUrl];
        if (cached && (cached.end != null || !r.ended)) {
          applyWorkTime(r, cached, now);
          return;
        }
        await fetchWorkTime(r, label, domains, now);
      } catch (e) {
        log(label + ' 详情页读取失败：' + r.work + '（' + (e && e.message ? e.message : '失败') + '）');
      }
    });
    const ended = pending.filter(function (r) { return r.ended && r.endTime != null; }).length;
    const active = pending.filter(function (r) { return !r.ended && r.deadline != null; }).length;
    const unknown = pending.length - ended - active;
    log(label + ' 详情页确认：已结束 ' + ended + ' 条，未截止 ' + active + ' 条'
      + (unknown ? '，仍无时间 ' + unknown + ' 条' : ''));
    return list;
  }

  // 把作业拆成「还要提醒的」和「最近 30 天已结束且未作答的」。
  // 已结束但没有结束时间的（详情页也读不到）既不放进提醒，也不放进已结束分区。
  function splitEndedWorks(list, now) {
    const active = [];
    const ended = [];
    let older = 0;
    list.forEach(function (r) {
      if (!r.ended) {
        active.push(r);
        return;
      }
      if (r.kind === '作业' && !r.settled && r.endTime != null
        && r.endTime <= now && r.endTime >= now - THIRTY_DAYS) {
        ended.push(r);
      } else {
        older += 1;
      }
    });
    return { active: active, ended: ended, older: older };
  }


  function textOf(match) {
    return match ? decode(match[1].replace(/<[^>]+>/g, '')).trim() : '';
  }

  // 章节页结构：.chapter_item > .catalog_title > .catalog_task，
  // 未完成时是 .catalog_jindu > .catalog_points_yi(数字)，完成时是 .catalog_state。
  function parseChapters(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    doc.querySelectorAll('.chapter_item').forEach(function (item) {
      const task = item.querySelector('.catalog_task');
      if (!task) return;
      if (task.querySelector('.catalog_state')) return;
      const numEl = task.querySelector('.catalog_points_yi');
      const pending = parseInt(((numEl && numEl.textContent) || '').trim(), 10);
      if (!pending || isNaN(pending)) return;
      const title = (item.getAttribute('title') || '').trim();
      const sbar = ((item.querySelector('.catalog_sbar') || {}).textContent || '').trim();
      const name = ((sbar ? sbar + ' ' : '') + title).trim();
      if (!name) return;
      out.push({ name: name, pending: pending });
    });
    return out;
  }

  // 三个“快宿主”轮转分摊请求。
  // 实测：单一主力时 mooc1-2 要扛 129 个请求（23.5 秒）且会被超星按累计量拦下；
  // 按课程序号轮换起点后，每个宿主只承担约 43 个（15.5 秒），既更快也更安全。
  // 同一门课的门户/作业/考试落在同一个宿主上（用同一个课程序号），保持一致性。
  const FAST_DATA_HOSTS = [
    'https://mooc1-2.chaoxing.com',
    'https://mooc1-3.chaoxing.com',
    'https://mooc1-4.chaoxing.com'
  ];

  function rotateHosts(list, step) {
    const n = list.length;
    if (!n) return list.slice();
    const r = ((step % n) + n) % n;
    return list.slice(r).concat(list.slice(0, r));
  }

  // 被反爬命中的域名，本轮扫描整体弃用（不是只冷却 10 秒）。
  // 原因：超星拦的其实是「单个域名的累计请求量」——通用课程页 102 个请求打在
  // mooc1-2 上没事，紧接着的课程页扫描 129 个就被拦了。命中后继续用它，
  // 后面几十门课会连环失败；整轮弃用能让剩下的流量自动转移到下一个宿主。
  const bannedHost = {};

  function isBanned(host) {
    return !!bannedHost[host];
  }

  // 某个域名连续多次返回「提示」页，说明它压根不提供这个学校/这个班级的数据，
  // 本轮扫描就不再用它了（否则每门课都要白费一次请求）。
  const badDataHost = {};

  function markDataHostBad(domain) {
    if (!domain) return;
    badDataHost[domain] = (badDataHost[domain] || 0) + 1;
    if (badDataHost[domain] >= 3) {
      log('数据域名 ' + domain + ' 连续 ' + badDataHost[domain] + ' 次返回提示页，本轮弃用');
    }
  }

  // 作业/考试列表的候选域名。实测（2026-10-19/21）：
  // mooc1.chaoxing.com 对脚本请求有反爬，返回 202 antispiderShowVerify（指纹型拒绝，限速也防不住）；
  // mooc1-2 / mooc1-3 / mooc1-4 承载同一套数据且都不受该反爬影响（路由探测：四个域名的
  // /visit/stucoursemiddle、/mooc2/work/list、/exam-ans/mooc2/exam/exam-list 全部 302 跳登录=存在；
  // mooc1-5 不存在）。所以四个宿主轮着当主力，某个被限流时自动切到下一个，
  // 不会像只有 mooc1-2 + mooc1 那样“一被拦就彻底没退路”。
  function dataDomains(domain, step, portalHost) {
    const all = [];
    // 门户参数（enc / t / workEnc / examEnc）是从哪个域名拿到的，作业和考试就优先用那个域名。
    // 同一门课的数据是按分片存放的：换到别的域名去读同一门课，服务器只会回一个「提示」页。
    if (portalHost && all.indexOf(portalHost) < 0) all.push(portalHost);
    rotateHosts(FAST_DATA_HOSTS, step || 0).forEach(function (d) {
      if (all.indexOf(d) < 0) all.push(d);
    });
    [domain, 'https://mooc1.chaoxing.com'].forEach(function (d) {
      if (d && all.indexOf(d) < 0) all.push(d);
    });
    const list = all.filter(function (d) { return !badDataHost[d] && !isBanned(hostOf(d)); });
    // 全被弃用/拉黑了就等于没得选了：解除弃用，重新从主力开始，
    // 宁可慢，也不能把这门课的数据整个丢掉。
    if (!list.length) {
      log('所有数据域名都已弃用，解除弃用重新开始');
      resetBans();
      return all;
    }
    return list;
  }

  // 三个数据页地址。参数组合与浏览器实测通过的请求一致。
  // 第 1 页保持原样；第 2 页起按列表页自身的翻页参数追加
  // （作业：status=0&pageNum=N&topicId=，浏览器实测第 2 页返回 10 条已完成作业）。
  function workListUrl(domain, c, p, cpi, page) {
    const url = domain + '/mooc2/work/list?courseId=' + encodeURIComponent(c.courseId)
      + '&classId=' + encodeURIComponent(c.classId)
      + '&cpi=' + encodeURIComponent(cpi)
      + '&ut=s&t=' + encodeURIComponent(p.t)
      + '&stuenc=' + encodeURIComponent(p.enc)
      + '&enc=' + encodeURIComponent(p.workEnc);
    if (!page || page <= 1) return url;
    return url + '&status=0&pageNum=' + page + '&topicId=';
  }

  function examListUrl(domain, c, p, cpi, page) {
    const url = domain + '/exam-ans/mooc2/exam/exam-list?courseid=' + encodeURIComponent(c.courseId)
      + '&clazzid=' + encodeURIComponent(c.classId)
      + '&cpi=' + encodeURIComponent(cpi)
      + '&ut=s&t=' + encodeURIComponent(p.t)
      + '&enc=' + encodeURIComponent(p.examEnc);
    if (!page || page <= 1) return url;
    return url + '&status=0&pageNum=' + page + '&openc=';
  }

  // 列表页内联的分页脚本：$("#page").paging({nowPage:1, pageNum:2, ...})。
  // 只有一页时 .pageDiv 是空的、脚本里也没有 paging 调用，按 1 页处理。
  function parsePagerTotal(html) {
    const s = String(html || '');
    const m = s.match(/pageNum\s*:\s*(\d+)/)
      || s.match(/pageCount\s*:\s*(\d+)/)
      || s.match(/totalPage\s*:\s*(\d+)/);
    let total = m ? Number(m[1]) : 0;
    if (!total) {
      try {
        const doc = new DOMParser().parseFromString(s, 'text/html');
        doc.querySelectorAll('.pageDiv li, #page li, .pageDiv a, #page a').forEach(function (el) {
          const n = Number((el.textContent || '').trim());
          if (n >= 1 && n < 1000) total = Math.max(total, n);
        });
      } catch (e) { total = 0; }
    }
    if (!isFinite(total) || total < 1) total = 1;
    return Math.min(total, MAX_LIST_PAGES);
  }

  // 翻页后同一门课里可能有重复条目（列表排序变化时尤其常见），按内容去重。
  function dedupeRows(list) {
    const seen = {};
    const out = [];
    list.forEach(function (r) {
      const key = r.kind + '|' + r.work + '|' + r.status + '|' + (r.detailUrl || '');
      if (seen[key]) return;
      seen[key] = 1;
      out.push(r);
    });
    return out;
  }

  // 先读第 1 页，再按分页脚本给出的总页数逐页补齐。
  // 后续页固定用第 1 页实际落地的域名（同一门课的数据分片在同一个宿主上），
  // 某个后续页失败时标记 partial，交给整轮重试补读，而不是静默少几条。
  async function fetchPaged(buildUrl, label, domains, opts, parse, now) {
    const rows = [];
    let totalPages = 1;
    let partial = false;
    let empty = false;
    let pageHost = '';
    for (let page = 1; page <= totalPages; page++) {
      const hostBase = pageHost ? 'https://' + pageHost : '';
      const list = hostBase
        ? [hostBase].concat((domains || []).filter(function (d) { return hostOf(d) !== pageHost; }))
        : domains;
      const pageOpts = hostBase
        ? { primaryHost: hostBase, hintLimit: opts && opts.hintLimit }
        : opts;
      let got;
      try {
        got = await fetchData(function (d) { return buildUrl(d, page); },
          page === 1 ? label : (label + ' 第' + page + ' 页'), list, pageOpts);
      } catch (e) {
        if (page === 1) throw e;
        partial = true;
        log(label + ' 第 ' + page + ' 页读取失败：'
          + (e && e.message ? e.message : '失败') + '（标记待重试）');
        break;
      }
      if (got.empty) {
        if (page === 1) empty = true;
        break;
      }
      if (page === 1) {
        totalPages = parsePagerTotal(got.text);
        if (totalPages > 1) log(label + ' 列表共 ' + totalPages + ' 页，继续读取后续页');
      }
      const landed = hostOf(got.url);
      if (landed) pageHost = landed;
      rows.push.apply(rows, parse(got.text, now));
    }
    return { rows: dedupeRows(rows), pages: totalPages, partial: partial, empty: empty };
  }

  function chapterUrl(c, p, cpi, domain) {
    return (domain || 'https://mooc2-ans.chaoxing.com') + '/mooc2-ans/mycourse/studentcourse?courseid='
      + encodeURIComponent(c.courseId)
      + '&clazzid=' + encodeURIComponent(c.classId)
      + '&cpi=' + encodeURIComponent(cpi)
      + '&ut=s&t=' + encodeURIComponent(p.t)
      + '&stuenc=' + encodeURIComponent(p.enc);
  }

  // 抓一门课的三个数据页。
  // opts 里已经成功的部分直接跳过（重试轮用得上），返回各部分结果 + 失败清单，
  // 这样重试时只补失败的那一项，不用把整门课重取一遍。
  //
  // 关键：作业 / 考试 / 章节这三个页面**互不依赖**（都只依赖门户参数），
  // 所以并行发起。串行的话每门课是「门户 → 作业 → 考试 → 章节」4 步串行，
  // 单请求 4 秒的话课程并发就被这个链卡死（43 门课仿真 32 秒）；
  // 并行之后每门课只有 2 步（门户 → 三个数据页同时），耗时明显下降。
  async function loadCourse(course, idx, opts) {
    opts = opts || {};
    const out = { work: null, workEnded: null, exam: null, chapter: null, failed: [], portal: null, noData: false, pendingSettled: [] };
    if (course.ended) return out;
    const p = opts.portal || await openPortal(course, idx);
    out.portal = p;
    const cpi = p.cpi || course.cpi || '';
    const domain = p.domain || 'https://mooc1.chaoxing.com';
    // 作业/考试优先回到门户参数来源的那个域名
    const dlist = dataDomains(domain, idx, p.host);
    const now = Date.now();
    const jobs = [];

    if (p.workEnc && !opts.workOk) {
      const label = '[' + course.name + '] 作业列表';
      jobs.push((async function () {
        try {
          const got = await fetchPaged(function (d, page) { return workListUrl(d, course, p, cpi, page); },
            label, dlist, { primaryHost: p.host },
            function (text, n) { return parseTasks(text, course.name, '作业', n); }, now);
          if (got.empty) out.noData = true;
          if (got.partial) out.failed.push('work');
          const resolved = await resolveNoDueWorks(got.rows, label, now, dlist);
          // 已完成/待批阅且列表没给时间的作业：能命中缓存就直接采用，
          // 其余的留到扫描结束后后台确认，避免几百个详情请求把本轮拖慢。
          const pendingSettled = [];
          resolved.forEach(function (r) {
            if (!r.settled || !r.noDue || !r.detailUrl) return;
            const cached = workTimeCache[r.detailUrl];
            if (cached) {
              applyWorkTime(r, cached, now);
            } else {
              // 先不显示：列表没给时间不等于没有截止时间，等后台确认后再补进来。
              r.pendingConfirm = true;
              pendingSettled.push(r);
            }
          });
          const split = splitEndedWorks(resolved.filter(function (r) { return !r.pendingConfirm; }), now);
          out.work = split.active;
          out.workEnded = split.ended;
          out.pendingSettled = pendingSettled;
          if (split.older) log(label + ' 另有 ' + split.older + ' 条已结束（含已完成/待批阅）或结束时间未知，不列出');
          log(label + ' 解析出未截止 ' + out.work.length + ' 条，最近30天已结束未作答 '
            + out.workEnded.length + ' 条（共 ' + got.pages + ' 页）'
            + (out.work.length ? ' 首条=' + out.work[0].work + ' ' + out.work[0].status : '')
            + (pendingSettled.length ? '，另有 ' + pendingSettled.length + ' 条已完成/待批阅待后台确认' : ''));
        } catch (e) {
          out.failed.push('work');
          log(label + ' 失败: ' + (e && e.message ? e.message : '失败'));
        }
      })());
    }
    if (p.examEnc && !opts.examOk) {
      const label = '[' + course.name + '] 考试列表';
      jobs.push((async function () {
        try {
          const got = await fetchPaged(function (d, page) { return examListUrl(d, course, p, cpi, page); },
            label, dlist, { primaryHost: p.host },
            function (text, n) { return parseTasks(text, course.name, '考试', n); }, now);
          // 已结束的考试没有「最近结束」分区，也没有可查看的结束时间，直接排除。
          out.exam = got.rows.filter(function (r) { return !r.ended; });
          if (got.empty) out.noData = true;
          if (got.partial) out.failed.push('exam');
          log(label + ' 解析出 ' + out.exam.length + ' 条（共 ' + got.pages + ' 页）');
        } catch (e) {
          out.failed.push('exam');
          log(label + ' 失败: ' + (e && e.message ? e.message : '失败'));
        }
      })());
    }

    const courseOpen = !course.ended && (course.endMs == null || course.endMs > now);
    if (courseOpen && !opts.chapterOk) {
      const label = '[' + course.name + '] 章节';
      jobs.push((async function () {
        try {
          const got = await fetchData(function (d) { return chapterUrl(course, p, cpi, d); },
            label, ['https://mooc2-ans.chaoxing.com']);
          out.chapter = [];
          if (got.empty) out.noData = true;
          parseChapters(got.text).forEach(function (ch) {
            out.chapter.push({
              course: course.name,
              chapter: ch.name,
              pending: ch.pending,
              endMs: course.endMs
            });
          });
          log(label + ' 未完成章节 ' + out.chapter.length + ' 个');
        } catch (e) {
          out.failed.push('chapter');
          log(label + ' 失败: ' + (e && e.message ? e.message : '失败'));
        }
      })());
    }
    await Promise.all(jobs);
    return out;
  }

  function formatRemain(ms) {
    if (ms < 0) return '已截止';
    const total = Math.floor(ms / 60000);
    const d = Math.floor(total / 1440);
    const h = Math.floor((total % 1440) / 60);
    const m = total % 60;
    let s = '';
    if (d) s += d + '天';
    if (d || h) s += h + '小时';
    s += m + '分钟';
    return s;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function formatDate(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatAgo(ms, now) {
    const diff = Math.max(0, now - ms);
    const days = Math.floor(diff / 86400000);
    if (days >= 1) return days + '天前';
    const hours = Math.floor(diff / 3600000);
    return (hours >= 1 ? hours + '小时前' : Math.max(1, Math.floor(diff / 60000)) + '分钟前');
  }

  function render() {
    const now = Date.now();
    // 有截止时间的按时间升序；无截止时间的排在后面（未完成优先于已完成）。
    const sorted = rows.slice().sort(function (a, b) {
      const an = a.deadline == null ? Infinity : a.deadline;
      const bn = b.deadline == null ? Infinity : b.deadline;
      if (an !== bn) return an - bn;
      if (an === Infinity && a.settled !== b.settled) return a.settled ? 1 : -1;
      return 0;
    });
    const chapters = chapterRows.slice().sort(function (a, b) {
      const ae = a.endMs == null ? Infinity : a.endMs;
      const be = b.endMs == null ? Infinity : b.endMs;
      return ae - be;
    });
    const noDueCount = sorted.filter(function (r) { return r.deadline == null; }).length;
    const hot = sorted.filter(function (r) { return r.deadline != null && r.deadline - now < SEVEN_DAYS; }).length;
    const endedPart = endedRows.length ? ' · 已结束 ' + endedRows.length : '';
    titleEl.textContent = (minimized
      ? ('未截止 ' + sorted.length + endedPart + ' · 章节 ' + chapters.length)
      : ('未截止 ' + sorted.length + ' 项' + endedPart + ' · 未看完章节 '
        + chapters.length)) + ' v' + VERSION;
    const seen = {};
    const courses = [];
    chapters.forEach(function (r) {
      if (seen[r.course]) return;
      seen[r.course] = 1;
      courses.push(r);
    });
    const html = ['<div class="cx-col"><div class="cx-sec">作业 / 考试'
      + (noDueCount ? '（无截止 ' + noDueCount + '）' : '') + '</div>'];
    if (!sorted.length) {
      html.push('<div class="cx-empty">没有还没截止的</div>');
    } else {
      html.push('<table class="cx-tasks"><thead><tr><th>课程</th><th>名称</th><th>还剩</th></tr></thead><tbody>');
      sorted.forEach(function (r) {
        const left = r.deadline == null ? null : r.deadline - now;
        let cls = '';
        if (r.settled) cls = ' class="cx-ok"';
        else if (left == null) cls = ' class="cx-nodue"';
        else if (left < SEVEN_DAYS) cls = ' class="cx-hot"';
        html.push(
          '<tr' + cls + '><td class="cx-name">' + escapeHtml(r.course) + '</td><td class="cx-work"><span class="cx-kind">[' + r.kind + ']</span>'
          + escapeHtml(r.work) + ' ' + (r.settled ? '已完成' : '未完成') + '</td><td>'
          + (left == null ? '无截止时间' : formatRemain(left)) + '</td></tr>'
        );
      });
      html.push('</tbody></table>');
    }
    if (endedRows.length) {
      const endedSorted = endedRows.slice().sort(function (a, b) {
        return (b.endTime || 0) - (a.endTime || 0);
      });
      html.push('<div class="cx-sec cx-sub">最近30天已结束（未作答）</div>');
      html.push('<table class="cx-ended"><thead><tr><th>课程</th><th>名称</th><th>结束于</th></tr></thead><tbody>');
      endedSorted.forEach(function (r) {
        html.push('<tr class="cx-ended"><td class="cx-name">' + escapeHtml(r.course) + '</td>'
          + '<td class="cx-work"><span class="cx-kind">[' + r.kind + ']</span>'
          + escapeHtml(r.work) + ' ' + escapeHtml(r.status || '未交') + '</td>'
          + '<td>' + formatDate(r.endTime)
          + '<span class="cx-status">' + formatAgo(r.endTime, now) + '</span></td></tr>');
      });
      html.push('</tbody></table>');
    }
    html.push('</div><div class="cx-col"><div class="cx-sec">未看完课程</div>');
    if (!courses.length) {
      html.push('<div class="cx-empty">没有未看完的课</div>');
    } else {
      html.push('<table class="cx-chapters"><thead><tr><th>课程名称</th><th>课程还剩</th></tr></thead><tbody>');
      courses.forEach(function (r) {
        const leftText = r.endMs == null ? '未显示结课时间' : formatRemain(r.endMs - now);
        html.push('<tr><td class="cx-name">' + escapeHtml(r.course) + '</td><td>' + leftText + '</td></tr>');
      });
      html.push('</tbody></table>');
    }
    html.push('</div>');
    bodyEl.innerHTML = html.join('');
  }

  async function mapPool(items, limit, worker) {
    const ret = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const i = cursor++;
        ret[i] = await worker(items[i], i);
      }
    }
    const n = Math.min(limit, items.length);
    const jobs = [];
    for (let i = 0; i < n; i++) jobs.push(run());
    await Promise.all(jobs);
    return ret;
  }

  // 扫描结束后的后台确认：已完成/待批阅且列表没给时间的作业才需要读详情。
  // 放到后台跑，扫描出结果的耗时不受影响；确认出的行再补进列表。
  // 每轮最多确认 120 条，避免老课程积压的已完成作业把后台请求量拉得太大；
  // 已确认过的会进缓存，下一轮自然轮到后面的。
  const MAX_SETTLED_CONFIRM = 120;
  async function confirmSettledRows(list, gen) {
    if (!list.length || gen !== scanGen) return;
    const seen = {};
    const unique = list.filter(function (r) {
      if (!r || !r.detailUrl || seen[r.detailUrl]) return false;
      seen[r.detailUrl] = 1;
      return true;
    });
    const pending = unique.slice(0, MAX_SETTLED_CONFIRM);
    if (unique.length > pending.length) {
      log('已完成/待批阅作业共 ' + unique.length + ' 条，本轮后台只确认前 ' + pending.length
        + ' 条，其余下次扫描继续');
    }
    if (!pending.length) return;
    log('后台确认 ' + pending.length + ' 条已完成/待批阅作业的截止时间（不影响本轮结果）');
    const found = [];
    let lastFlush = Date.now();

    function flush() {
      if (gen !== scanGen) return;
      let added = 0;
      found.slice().forEach(function (r) {
        if (rows.indexOf(r) < 0) {
          rows.push(r);
          added += 1;
        }
      });
      found.length = 0;
      if (added) {
        render();
        log('后台确认新增 ' + added + ' 条已完成/待批阅作业（无截止时间或还未到期）');
      }
    }

    await mapPool(pending, 6, async function (r) {
      if (gen !== scanGen) return;
      const origin = hostOf(r.detailUrl) ? 'https://' + hostOf(r.detailUrl) : '';
      try {
        const cached = workTimeCache[r.detailUrl];
        if (cached) applyWorkTime(r, cached, Date.now());
        else await fetchWorkTime(r, '[' + r.course + '] 作业',
          dataDomains(origin, 0, origin), Date.now());
      } catch (e) {
        // 后台确认失败就算了，下一轮扫描会重新排队
      }
      // 只有真正读到详情页的才采用，避免把「没读到」误当成「无截止」。
      if (workTimeCache[r.detailUrl] && r.settled && !r.ended) {
        r.pendingConfirm = false;
        found.push(r);
      }
      if (found.length && Date.now() - lastFlush > 800) {
        lastFlush = Date.now();
        flush();
      }
    });
    if (gen !== scanGen) return;
    flush();
    log('后台确认完成：共检查 ' + pending.length + ' 条已完成/待批阅作业');
  }

  let scanGen = 0;

  async function scan() {
    const gen = ++scanGen;
    loading = true;
    const courses = coursesFromPage();
    if (!courses.length) {
      rows = [];
      endedRows = [];
      chapterRows = [];
      titleEl.textContent = '没有课程';
      bodyEl.innerHTML = '<div class="cx-empty">当前筛选下没有课程</div>';
      footEl.textContent = '';
      loading = false;
      setScanBtn('▶ 扫描', false);
      return;
    }
    const errors = [];
    const retryList = [];
    let done = 0;
    const t0 = Date.now();
    // 每轮扫描重新开始：之前被反爬弃用的域名可以再试一次
    resetBans();
    resetHits();
    log('===== 开始扫描，共 ' + courses.length + ' 门课，脚本 v' + VERSION + ' =====');
    log('页面地址: ' + location.href);
    log('识别到的课程数: ' + courses.length);
    // 卡片链接落在哪个域名，直接决定了会不会撞上 mooc1 的反爬，必须打出来
    const hostCount = {};
    courses.forEach(function (c) {
      const h = hostOf(c.href) || '(无链接)';
      hostCount[h] = (hostCount[h] || 0) + 1;
    });
    log('卡片链接域名分布: ' + Object.keys(hostCount).map(function (k) {
      return k + '×' + hostCount[k];
    }).join('  '));
    if (courses.length) {
      log('入口顺序示例[' + courses[0].name + ']: ' + portalCandidates(courses[0], 0).map(function (c, i) {
        return (i + 1) + '.' + c.family + '=' + String(c.url).slice(0, 95);
      }).join('  |  '));
    }
    if (!courses.length) probePage();
    titleEl.textContent = '正在读取 0/' + courses.length;
    bodyEl.innerHTML = '<div class="cx-empty">正在逐门读取作业、考试和章节…</div>';
    footEl.textContent = '左：7天内未完成标红，已完成或待批改且还有剩余时间标绿，最近30天已结束单列。右：未看完课程';
    // 结果按课程存，重试时覆盖（而不是追加），避免同一门课的数据重复计入
    const results = {};
    const keyOf = function (c) { return c.courseId + ':' + c.classId; };
    await mapPool(courses, CONCURRENCY_FAST, async function (course, i) {
      if (gen !== scanGen) return;
      try {
        const pack = await loadCourse(course, i);
        if (gen !== scanGen) return;
        results[keyOf(course)] = pack;
        if (pack.failed.length) retryList.push(course);
        log('[' + course.name + '] 完成：作业/考试 '
          + ((pack.work ? pack.work.length : 0) + (pack.exam ? pack.exam.length : 0))
          + ' 条，未完成章节 ' + (pack.chapter ? pack.chapter.length : 0)
          + ' 个' + (pack.failed.length ? '（' + pack.failed.join('/') + ' 待重试）' : ''));
      } catch (err) {
        const msg = err && err.message ? err.message : '失败';
        errors.push(course.name + '：' + msg);
        results[keyOf(course)] = { work: null, workEnded: null, exam: null, chapter: null, failed: ['portal'], portal: null, noData: false, pendingSettled: [] };
        retryList.push(course);
        log('[' + course.name + '] 失败：' + msg);
      }
      done += 1;
      if (gen === scanGen) titleEl.textContent = '正在读取 ' + done + '/' + courses.length;
    });
    // 第一轮没读全的门课，等一会儿再重试一次。
    // 只补失败的那一项（复用已拿到的门户参数），不用把整门课重取一遍。
    if (retryList.length && gen === scanGen) {
      log('===== 有 ' + retryList.length + ' 门没读全，等 4 秒后重试一轮 =====');
      titleEl.textContent = '正在重试 ' + retryList.length + ' 门';
      await sleep(4000);
      // 重试前把弃用名单清掉：上一轮被拦的域名，过几秒可能已经放行
      resetBans();
      await mapPool(retryList, 2, async function (course, i) {
        if (gen !== scanGen) return;
        const prev = results[keyOf(course)] || {};
        try {
          const pack = await loadCourse(course, i + 500, {
            portal: prev.portal,
            workOk: prev.failed.indexOf('work') < 0,
            examOk: prev.failed.indexOf('exam') < 0,
            chapterOk: prev.failed.indexOf('chapter') < 0
          });
          if (gen !== scanGen) return;
          // 只用重试补上的部分覆盖，其它部分保留第一轮的结果。
          // 注意：第一轮若是「门户就失败」，prev.failed 里只有 'portal'，三个数据项都不在，
          // 这时必须整体采用重试结果，否则第一轮拿到的 null 会把重试补回的数据覆盖掉。
          const portalFailed = !prev.portal;
          const want = function (k) { return portalFailed || prev.failed.indexOf(k) >= 0; };
          results[keyOf(course)] = {
            work: want('work') ? pack.work : prev.work,
            workEnded: want('work') ? pack.workEnded : prev.workEnded,
            exam: want('exam') ? pack.exam : prev.exam,
            chapter: want('chapter') ? pack.chapter : prev.chapter,
            failed: pack.failed,
            noData: !!(prev.noData || pack.noData),
            portal: pack.portal || prev.portal,
            pendingSettled: want('work') ? pack.pendingSettled : prev.pendingSettled
          };
          const r = results[keyOf(course)];
          log('[' + course.name + '] 重试完成：作业/考试 '
            + ((r.work ? r.work.length : 0) + (r.exam ? r.exam.length : 0))
            + ' 条，未完成章节 ' + (r.chapter ? r.chapter.length : 0)
            + ' 个' + (r.failed.length ? '（仍失败：' + r.failed.join('/') + '）' : ''));
        } catch (err) {
          log('[' + course.name + '] 重试仍失败：' + (err && err.message ? err.message : '失败'));
        }
      });
    }
    if (gen !== scanGen) return;
    // 汇总：每门课只贡献一次
    const nextRows = [];
    const nextEnded = [];
    const nextChapters = [];
    const nextSettled = [];
    let noDataCount = 0;
    let partialCount = 0;
    courses.forEach(function (c) {
      const r = results[keyOf(c)];
      if (!r) return;
      if (r.work) nextRows.push.apply(nextRows, r.work);
      if (r.workEnded) nextEnded.push.apply(nextEnded, r.workEnded);
      if (r.exam) nextRows.push.apply(nextRows, r.exam);
      if (r.chapter) nextChapters.push.apply(nextChapters, r.chapter);
      if (r.pendingSettled) nextSettled.push.apply(nextSettled, r.pendingSettled);
      // 「没有数据」和「读取失败」是两回事，汇总里必须分开报
      if (r.noData) noDataCount += 1;
      if (r.failed && r.failed.length) partialCount += 1;
    });
    rows = nextRows;
    endedRows = nextEnded;
    chapterRows = nextChapters;
    loading = false;
    setScanBtn('↻ 重新扫描', false);
    render();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const noDueCount = nextRows.filter(function (r) { return r.deadline == null; }).length;
    log('===== 扫描结束：作业/考试 ' + nextRows.length + ' 条'
      + (noDueCount ? '（其中无截止时间 ' + noDueCount + ' 条）' : '')
      + '，最近30天已结束未作答 ' + nextEnded.length + ' 条，未完成章节 '
      + nextChapters.length + ' 个，无数据 ' + noDataCount + ' 门，部分失败 ' + partialCount
      + ' 门，读取失败 ' + errors.length + ' 门，用时 ' + secs
      + ' 秒（v' + VERSION + '，' + courses.length + ' 门课） =====');
    log('请求分布（共 ' + totalHits + ' 次）：' + (Object.keys(hostHits).sort(function (a, b) {
      return hostHits[b] - hostHits[a];
    }).map(function (k) {
      return k.replace('.chaoxing.com', '') + '=' + hostHits[k];
    }).join(' ') || '无')
      + ' | GM 内部跳转落点：' + (Object.keys(landHits).map(function (k) {
        return k.replace('.chaoxing.com', '') + '=' + landHits[k];
      }).join(' ') || '无'));
    footEl.textContent = errors.length
      ? ('有 ' + errors.length + ' 门没读全，点 ☰ 看详细日志')
      : '拖动蓝条移动、拖边框调整大小。7天内未完成标红，无截止时间标橙，已完成/待批阅标绿，最近30天已结束单列。';
    // 后台补查不 await：结果已经渲染完，确认出来的「无截止/未到期」作业会陆续补进列表。
    confirmSettledRows(nextSettled, gen);
  }

  /* =====================================================================
   * 更新检查（菜单「更新」）
   * 与仓库里的翻译脚本一致：只走油猴菜单，不在页面上放更新按钮。
   * ===================================================================== */

  const UPDATE_TOAST_CSS = `
    :host { all: initial; }
    .toast {
      box-sizing: border-box;
      max-width: min(360px, calc(100vw - 32px));
      padding: 9px 14px;
      border-radius: 10px;
      background: rgba(23, 25, 29, .94);
      color: #f3f4f6;
      border: 1px solid rgba(255, 255, 255, .08);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .3);
      font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      text-align: center;
      animation: cx-toast-in .14s ease-out;
    }
    @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
    @keyframes cx-toast-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: none; }
    }
  `;

  let updateToastHost = null;
  let updateToastShadow = null;
  let updateToastText = null;

  function ensureUpdateToast() {
    if (updateToastHost || !document.documentElement) return;
    updateToastHost = document.createElement('div');
    updateToastHost.setAttribute('data-cx-update-toast', '1');
    updateToastHost.style.cssText = 'all:initial;position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:none;pointer-events:none;';
    updateToastShadow = updateToastHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UPDATE_TOAST_CSS;
    updateToastShadow.appendChild(style);
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    updateToastText = toast;
    updateToastShadow.appendChild(toast);
    document.documentElement.appendChild(updateToastHost);
  }

  function showUpdateToast(message) {
    ensureUpdateToast();
    if (!updateToastHost) return;
    updateToastText.textContent = message;
    updateToastHost.style.display = 'block';
  }

  function hideUpdateToast() {
    if (updateToastHost) updateToastHost.style.display = 'none';
  }

  function cmpVersion(a, b) {
    const parse = function (v) {
      return String(v == null ? '' : v)
        .trim()
        .replace(/^v/i, '')
        .split('-')[0]
        .split('.')
        .map(function (x) {
          const n = parseInt(x, 10);
          return Number.isFinite(n) ? n : 0;
        });
    };
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  function parseRemoteVersion(text) {
    const src = String(text || '');
    const start = src.indexOf('==UserScript==');
    const end = src.indexOf('==/UserScript==');
    const scope = start >= 0
      ? src.slice(start, end > start ? end : Math.min(src.length, start + 4000))
      : src.slice(0, 4000);
    const m = scope.match(/^[ \t]*\/\/[ \t]*@version[ \t]+(\S+)/m);
    return m ? m[1] : '';
  }

  function rawScriptUrl(branch) {
    return 'https://raw.githubusercontent.com/' + UPDATE.repo + '/' + encodeURIComponent(branch)
      + '/' + UPDATE.file.split('/').map(encodeURIComponent).join('/');
  }

  function cdnScriptUrl(branch) {
    return 'https://cdn.jsdelivr.net/gh/' + UPDATE.repo + '@' + branch
      + '/' + UPDATE.file.split('/').map(encodeURIComponent).join('/');
  }

  function probeRemote(url, bust) {
    return new Promise(function (resolve) {
      let settled = false;
      let timer = 0;
      function done(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
      timer = setTimeout(function () { done({ version: '', network: true }); }, UPDATE.timeout);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url + (bust ? (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now() : ''),
          timeout: UPDATE.timeout,
          anonymous: true,
          headers: { 'Accept': 'text/plain, */*' },
          onload: function (res) {
            if (res.status !== 200) { done({ version: '', network: false }); return; }
            done({ version: parseRemoteVersion(res.responseText || ''), network: false });
          },
          onerror: function () { done({ version: '', network: true }); },
          ontimeout: function () { done({ version: '', network: true }); },
          onabort: function () { done({ version: '', network: true }); }
        });
      } catch (e) {
        done({ version: '', network: true });
      }
    });
  }

  function withDeadline(promise, ms) {
    let timer = 0;
    const deadline = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        const err = new Error('deadline');
        err.network = true;
        reject(err);
      }, ms);
    });
    return Promise.race([promise, deadline]).finally(function () { clearTimeout(timer); });
  }

  async function fetchLatestVersion() {
    const primaryBranch = UPDATE.branches[0];
    const primaryUrl = rawScriptUrl(primaryBranch);
    const primary = await probeRemote(primaryUrl, true);
    if (primary.version) return { version: primary.version, url: primaryUrl };

    const candidates = [];
    UPDATE.branches.forEach(function (branch) {
      ['raw', 'cdn'].forEach(function (source) {
        if (branch === primaryBranch && source === 'raw') return;
        candidates.push({
          url: source === 'raw' ? rawScriptUrl(branch) : cdnScriptUrl(branch)
        });
      });
    });
    const results = await Promise.all(candidates.map(async function (c) {
      const probe = await probeRemote(c.url, false);
      return { url: c.url, version: probe.version, network: probe.network };
    }));
    const hit = results.find(function (r) { return r.version; });
    if (hit) return { version: hit.version, url: hit.url };

    const reachable = !primary.network || results.some(function (r) { return !r.network; });
    if (!reachable) {
      const err = new Error('github unreachable');
      err.network = true;
      throw err;
    }
    throw new Error('remote version not found');
  }

  let updateChecking = false;

  function openScriptPage(url) {
    try {
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(url, { active: true, insert: true });
        return;
      }
    } catch (e) { /* ignore */ }
    window.open(url, '_blank', 'noopener');
  }

  // 子框架里 Chrome 可能拦截 alert（菜单点击不算框架内的用户手势），改用提示条保证有反馈
  function notifyUpdate(message) {
    let isTop = false;
    try { isTop = window.top === window; } catch (e) { isTop = false; }
    if (isTop) {
      alert(message);
      return;
    }
    showUpdateToast(message);
    setTimeout(hideUpdateToast, 4000);
  }

  async function checkForUpdate() {
    if (updateChecking) {
      showUpdateToast('正在检查更新…');
      return;
    }
    updateChecking = true;
    showUpdateToast('正在检查更新…');
    try {
      const latest = await withDeadline(fetchLatestVersion(), UPDATE.deadline);
      hideUpdateToast();
      if (!latest || !latest.version || cmpVersion(latest.version, VERSION) <= 0) {
        notifyUpdate('已是最新版本 v' + VERSION);
        return;
      }
      openScriptPage(latest.url);
    } catch (e) {
      hideUpdateToast();
      notifyUpdate(e && e.network
        ? '检查失败：网络异常或访问 GitHub 超时，请检查网络后重试。'
        : '检查失败：未能获取版本信息，请稍后重试。');
    } finally {
      updateChecking = false;
    }
  }

  function registerUpdateMenu() {
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('更新', function () { checkForUpdate().catch(function () {}); });
      }
    } catch (e) { /* ignore */ }
  }

  setInterval(function () {
    if (!loading && (rows.length || endedRows.length || chapterRows.length)) render();
  }, 30000);

  // v2.5.0：不再自动扫描。
  // 以前是「页面一加载 + DOM 一变化 + 切学期筛选」就自动跑，刷新一次就白扫一遍，
  // 还会在用户没要求的时候先打出去几十个请求。现在改成纯手动：点「▶ 扫描」才发请求。
  registerUpdateMenu();
  log('脚本 v' + VERSION + ' 已就绪（' + location.host + '），点「▶ 扫描」开始读取；不会自动读取');
  renderIdle();
})();
