// ==UserScript==
// @name         Selection Translator
// @namespace    specdock.my-script.selection-translator
// @version      1.3.0
// @description  静默划词翻译：中文→英文，其他→中文。Google → Microsoft → 腾讯翻译 → MyMemory → LLM 多级自动回退；可视化设置面板；GitHub 版本检测与一键更新。
// @author       SpecDock
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_info
// @connect      translate.googleapis.com
// @connect      edge.microsoft.com
// @connect      api-edge.cognitive.microsofttranslator.com
// @connect      transmart.qq.com
// @connect      api.mymemory.translated.net
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      api.github.com
// @connect      *
// @updateURL    https://raw.githubusercontent.com/SpecDock/MyScript/master/selection-translator.user.js
// @downloadURL  https://raw.githubusercontent.com/SpecDock/MyScript/master/selection-translator.user.js
// ==/UserScript==

(() => {
  'use strict';

  /* ================= 1. 常量与配置 ================= */

  const SCRIPT_NAME = 'Selection Translator';
  const SCRIPT_NS = 'specdock.my-script.selection-translator';
  const FALLBACK_VERSION = '1.3.0';
  const SCRIPT_VERSION = (() => {
    try {
      return (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || FALLBACK_VERSION;
    } catch (e) {
      return FALLBACK_VERSION;
    }
  })();
  const IS_TOP = (() => {
    try { return window.top === window; } catch (e) { return false; }
  })();

  const ENGINE_ORDER = ['google', 'ms', 'tencent', 'mymemory', 'llm'];
  const GOOGLE_TIMEOUT = 1500;
  const MS_TOKEN_TIMEOUT = 1800;
  const MS_TIMEOUT = 3000;
  const TENCENT_TIMEOUT = 2500;
  const MYMEMORY_TIMEOUT = 2500;
  const LLM_TIMEOUT = 20000;
  const TENCENT_URL = 'https://transmart.qq.com/api/imt';
  const TENCENT_CLIENT_KEY = 'browser-chrome-120.0.0.0-Windows-6f1c2c9e-3f0b-4c3e-9d1a-2b7e5c8f4a11';
  const DOWN_MS = 5 * 60 * 1000;
  const MAX_LEN = 2500;
  const BUBBLE_GAP = 8;
  const VIEW_MARGIN = 8;
  const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  // 更新源：仓库根目录、main 分支、文件名需与这里一致（改文件名时同步修改 metadata 的 updateURL/downloadURL）
  const UPDATE = {
    repo: 'SpecDock/MyScript',
    file: 'selection-translator.user.js',
    branches: ['master', 'main'],
    // 检查结果缓存时长：避免每个页面都请求 GitHub；设为 0 表示每次打开都实时检查
    ttl: 60 * 1000,
    timeout: 8000,
  };

  const K = {
    llmUrl: 'st.llm.url',
    llmKey: 'st.llm.key',
    llmModel: 'st.llm.model',
    msToken: 'st.ms.token',
    enginesDown: 'st.engines.down',
    updateState: 'st.update.state',
    updateHide: 'st.update.hide',
  };

  const cfg = {
    url: String(GM_getValue(K.llmUrl, '') || ''),
    key: String(GM_getValue(K.llmKey, '') || ''),
    model: String(GM_getValue(K.llmModel, 'deepseek-flash') || 'deepseek-flash'),
  };

  const downUntil = (() => {
    const out = Object.create(null);
    const now = Date.now();
    const saved = GM_getValue(K.enginesDown, null);
    if (saved && typeof saved === 'object') {
      for (const name of Object.keys(saved)) {
        const at = Number(saved[name]);
        if (at > now && at <= now + DOWN_MS) out[name] = at;
      }
    }
    return out;
  })();
  const inflight = new Map();
  const cache = new Map();
  let msToken = '';
  let msTokenAt = 0;
  let msTokenPromise = null;

  /* ================= 2. 通用工具 ================= */

  function make(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function adopt(shadow, css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      return;
    } catch (e) {
      // 回退到 <style>
    }
    const style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
  }

  function langBase(value) {
    const m = String(value || '').toLowerCase().match(/^[a-z]{2}/);
    return m ? m[0] : '';
  }

  function sameLang(a, b) {
    const x = langBase(a);
    return !!x && x === langBase(b);
  }

  function detectTarget(text) {
    const cjk = (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const kana = (text.match(/[\u3040-\u30FF]/g) || []).length;
    const hangul = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (kana > 0 || hangul > 0) return 'zh'; // 日/韩 → 中文
    if (cjk > 0 && cjk / Math.max(1, cjk + latin) >= 0.25) return 'en'; // 中文 → 英文
    return 'zh';
  }

  function cmpVersion(a, b) {
    const parse = v => String(v == null ? '' : v)
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map(x => {
        const n = parseInt(x, 10);
        return Number.isFinite(n) ? n : 0;
      });
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

  function maskKey(key) {
    if (!key) return '未设置';
    if (key.length <= 8) return key.slice(0, 1) + '****' + key.slice(-1);
    return key.slice(0, 4) + '****' + key.slice(-4);
  }

  function parseMeta(src) {
    const block = String(src || '').slice(0, 30000).match(/==UserScript==([\s\S]*?)==\/UserScript==/);
    if (!block) return null;
    const meta = {};
    const lines = block[1].split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^[^\S\r\n]*\/\/\s*@([\w:-]+)[ \t]+(.+?)[ \t]*$/);
      if (m && !(m[1].toLowerCase() in meta)) {
        meta[m[1].toLowerCase()] = m[2];
      }
    }
    return meta;
  }

  function isSameScript(meta) {
    if (!meta) return false;
    if (meta.namespace && meta.namespace === SCRIPT_NS) return true;
    if (meta.name && meta.name === SCRIPT_NAME) return true;
    return false;
  }

  function encodePath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/');
  }

  function rawUrl(branch, path) {
    return 'https://raw.githubusercontent.com/' + UPDATE.repo + '/' + encodeURIComponent(branch) + '/' + encodePath(path);
  }

  function cdnUrl(branch, path) {
    return 'https://cdn.jsdelivr.net/gh/' + UPDATE.repo + '@' + branch + '/' + encodePath(path);
  }

  /* ================= 3. 网络请求 ================= */

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let req = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { if (req && req.abort) req.abort(); } catch (e) {}
        reject(new Error('timeout'));
      }, opts.timeout || 15000);
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      try {
        req = GM_xmlhttpRequest({
          url: opts.url,
          method: opts.method || 'GET',
          headers: opts.headers,
          data: opts.data,
          anonymous: true,
          onload: res => done(resolve, res),
          onerror: () => done(reject, new Error('network error')),
          ontimeout: () => done(reject, new Error('timeout')),
          onabort: () => done(reject, new Error('aborted')),
        });
      } catch (e) {
        done(reject, e);
      }
    });
  }

  /* ================= 4. 翻译引擎 ================= */

  async function googleTranslate(text, target) {
    const tl = target === 'en' ? 'en' : 'zh-CN';
    const base = 'https://translate.googleapis.com/translate_a/single';
    const params = 'client=gtx&sl=auto&tl=' + tl + '&dt=t';
    const q = encodeURIComponent(text);
    let res;
    if (base.length + params.length + q.length + 4 <= 1900) {
      res = await gmRequest({ url: base + '?' + params + '&q=' + q, timeout: GOOGLE_TIMEOUT });
    } else {
      res = await gmRequest({
        url: base + '?' + params,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        data: 'q=' + q,
        timeout: GOOGLE_TIMEOUT,
      });
    }
    if (res.status !== 200) throw new Error('google http ' + res.status);
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      throw new Error('google parse');
    }
    const segs = data && Array.isArray(data[0]) ? data[0] : [];
    const out = segs.map(s => (Array.isArray(s) ? s[0] : '') || '').join('').trim();
    if (!out) throw new Error('google empty');
    return { text: out, detected: typeof data[2] === 'string' ? data[2] : '' };
  }

  async function getMsToken(force) {
    if (!force) {
      if (msToken && Date.now() - msTokenAt < 8 * 60 * 1000) return msToken;
      const saved = GM_getValue(K.msToken, null);
      if (saved && typeof saved.t === 'string' && typeof saved.at === 'number' && Date.now() - saved.at < 8 * 60 * 1000) {
        msToken = saved.t;
        msTokenAt = saved.at;
        return msToken;
      }
    }
    if (msTokenPromise) return msTokenPromise;
    msTokenPromise = (async () => {
      const res = await gmRequest({ url: 'https://edge.microsoft.com/translate/auth', timeout: MS_TOKEN_TIMEOUT });
      if (res.status !== 200) throw new Error('ms auth http ' + res.status);
      const token = String(res.responseText || '').trim().replace(/^"|"$/g, '');
      if (token.length < 100) throw new Error('ms auth invalid');
      msToken = token;
      msTokenAt = Date.now();
      GM_setValue(K.msToken, { t: token, at: msTokenAt });
      return token;
    })();
    try {
      return await msTokenPromise;
    } finally {
      msTokenPromise = null;
    }
  }

  async function msCall(token, text, to) {
    const res = await gmRequest({
      url: 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' + to,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      data: JSON.stringify([{ Text: text }]),
      timeout: MS_TIMEOUT,
    });
    if (res.status !== 200) {
      const err = new Error('ms http ' + res.status);
      err.status = res.status;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      throw new Error('ms parse');
    }
    const item = data && data[0];
    const out = item && item.translations && item.translations[0] && item.translations[0].text;
    if (!out) throw new Error('ms empty');
    return {
      text: String(out).trim(),
      detected: item.detectedLanguage && typeof item.detectedLanguage.language === 'string' ? item.detectedLanguage.language : '',
    };
  }

  async function msTranslate(text, target) {
    const to = target === 'en' ? 'en' : 'zh-Hans';
    let token = await getMsToken(false);
    try {
      return await msCall(token, text, to);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        token = await getMsToken(true);
        return await msCall(token, text, to);
      }
      throw e;
    }
  }

  async function tencentTranslate(text, target) {
    const body = {
      header: { fn: 'auto_translation', client_key: TENCENT_CLIENT_KEY },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'auto', text_list: [text] },
      target: { lang: target === 'en' ? 'en' : 'zh' },
    };
    const res = await gmRequest({
      url: TENCENT_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
      timeout: TENCENT_TIMEOUT,
    });
    if (res.status !== 200) throw new Error('tencent http ' + res.status);
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      throw new Error('tencent parse');
    }
    const out = data && Array.isArray(data.auto_translation) ? String(data.auto_translation[0] || '').trim() : '';
    if (!out) throw new Error('tencent empty');
    return { text: out, detected: typeof data.src_lang === 'string' ? data.src_lang : '' };
  }

  async function myMemoryTranslate(text, target) {
    // 免费接口仅支持 500 字节内的明确语种对，超长或非中英语种直接交给 LLM
    if (text.length > 400) throw new Error('mymemory too long');
    if (target === 'zh' && !/[A-Za-z]/.test(text)) throw new Error('mymemory source unknown');
    const pair = target === 'en' ? 'zh-CN|en' : 'en|zh-CN';
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + encodeURIComponent(pair);
    const res = await gmRequest({ url, timeout: MYMEMORY_TIMEOUT });
    if (res.status !== 200) throw new Error('mymemory http ' + res.status);
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      throw new Error('mymemory parse');
    }
    const out = data && data.responseData && typeof data.responseData.translatedText === 'string'
      ? data.responseData.translatedText.trim()
      : '';
    if (!out || Number(data.responseStatus) !== 200) throw new Error('mymemory empty');
    return { text: out, detected: target === 'en' ? 'zh' : 'en' };
  }

  function llmReady() {
    return !!(cfg.url && cfg.key);
  }

  function llmEndpoint() {
    let url = cfg.url.trim().replace(/\/+$/, '');
    if (!/\/chat\/completions$/i.test(url)) url += '/chat/completions';
    return url;
  }

  async function llmTranslate(text, target) {
    const langName = target === 'en' ? 'English' : 'Simplified Chinese';
    const body = {
      model: cfg.model || 'deepseek-flash',
      messages: [
        {
          role: 'system',
          content: 'You are a precise translation engine. Translate the user text faithfully. Output only the translated text, without quotes, labels or explanations.',
        },
        {
          role: 'user',
          content: 'Translate the following text into ' + langName + ':\n\n' + text,
        },
      ],
      temperature: 0.2,
      stream: false,
    };
    const res = await gmRequest({
      url: llmEndpoint(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.key,
      },
      data: JSON.stringify(body),
      timeout: LLM_TIMEOUT,
    });
    if (res.status < 200 || res.status >= 300) {
      const err = new Error('llm http ' + res.status);
      err.status = res.status;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      throw new Error('llm parse');
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const out = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
    if (!out) throw new Error('llm empty');
    return { text: out, detected: '' };
  }

  const ENGINES = {
    google: googleTranslate,
    ms: msTranslate,
    tencent: tencentTranslate,
    mymemory: myMemoryTranslate,
    llm: llmTranslate,
  };

  /* ================= 5. 引擎调度与缓存 ================= */

  function cacheGet(key) {
    const hit = cache.get(key);
    return hit && typeof hit.text === 'string' ? hit : null;
  }

  function cacheSet(key, value) {
    cache.set(key, value);
    while (cache.size > 300) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function saveDownState() {
    const now = Date.now();
    const out = {};
    for (const name of Object.keys(downUntil)) {
      if (downUntil[name] > now) out[name] = downUntil[name];
      else delete downUntil[name];
    }
    try { GM_setValue(K.enginesDown, out); } catch (e) {}
  }

  function markDown(name) {
    downUntil[name] = Date.now() + DOWN_MS;
    saveDownState();
  }

  function markUp(name) {
    if (!(name in downUntil)) return;
    delete downUntil[name];
    saveDownState();
  }

  async function runChain(text, target) {
    let lastErr = null;
    for (const name of ENGINE_ORDER) {
      if (name === 'llm' && !llmReady()) continue;
      const down = downUntil[name];
      if (down && down > Date.now()) continue;
      try {
        const res = await ENGINES[name](text, target);
        if (!res || !res.text) throw new Error('empty');
        markUp(name);
        return res;
      } catch (e) {
        markDown(name);
        lastErr = e;
      }
    }
    throw lastErr || new Error('没有可用的翻译引擎');
  }

  async function getTranslation(text, target) {
    const key = target + '\n' + text;
    const hit = cacheGet(key);
    if (hit) return hit;
    const running = inflight.get(key);
    if (running) return running;

    const task = (async () => {
      try {
        let result = await runChain(text, target);
        if (sameLang(result.detected, target)) {
          const swapped = target === 'en' ? 'zh' : 'en';
          try { result = await runChain(text, swapped); } catch (e) {}
        }
        cacheSet(key, result);
        return result;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    return task;
  }

  /* ================= 6. 翻译气泡 UI ================= */

  const BUBBLE_CSS = `
    :host { all: initial; }
    .card {
      box-sizing: border-box;
      max-width: min(400px, calc(100vw - 24px));
      max-height: min(42vh, 420px);
      overflow: auto;
      overscroll-behavior: contain;
      padding: 10px 14px;
      border-radius: 12px;
      background: #ffffff;
      color: #16181d;
      border: 1px solid rgba(15, 23, 42, .08);
      box-shadow: 0 16px 40px rgba(15, 23, 42, .16), 0 3px 8px rgba(15, 23, 42, .06);
      font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.6;
      letter-spacing: .01em;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      user-select: text;
      -webkit-user-select: text;
      cursor: text;
      min-width: 48px;
      animation: st-card-in .12s ease-out;
    }
    .text:empty { display: none; }
    .dots { display: none; align-items: center; gap: 5px; padding: 4px 0; color: #64748b; }
    .card.loading { min-width: 64px; }
    .card.loading .dots { display: inline-flex; }
    .dots i {
      width: 5px; height: 5px;
      border-radius: 50%;
      background: currentColor;
      animation: st-blink 1.1s ease-in-out infinite;
    }
    .dots i:nth-child(2) { animation-delay: .15s; }
    .dots i:nth-child(3) { animation-delay: .3s; }
    .card.error { color: #dc2626; }
    .card::-webkit-scrollbar { width: 8px; height: 8px; }
    .card::-webkit-scrollbar-thumb { background: rgba(15, 23, 42, .18); border-radius: 4px; }
    .card::-webkit-scrollbar-thumb:hover { background: rgba(15, 23, 42, .3); }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #26282c;
        color: #e8eaed;
        border-color: rgba(255, 255, 255, .09);
        box-shadow: 0 16px 40px rgba(0, 0, 0, .55), 0 3px 8px rgba(0, 0, 0, .3);
      }
      .dots { color: #9ca3af; }
      .card.error { color: #f87171; }
      .card::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .2); }
    }
    @media (prefers-reduced-motion: reduce) {
      .card { animation: none; }
      .dots i { animation: none; opacity: .6; }
    }
    @keyframes st-card-in {
      from { opacity: .4; transform: translateY(-2px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes st-blink {
      0%, 80%, 100% { opacity: .25; }
      40% { opacity: .9; }
    }
  `;

  let bubbleHost = null;
  let bubbleShadow = null;
  let bubbleCard = null;
  let bubbleText = null;
  let lastRange = null;
  let lastShownKey = '';
  let activeSeq = 0;
  let hideTimer = 0;
  let repositionRaf = 0;
  let isMouseSelecting = false;
  let selectionTimer = 0;

  function bubbleIsVisible() {
    return !!(bubbleHost && bubbleHost.style.display !== 'none');
  }

  function ensureBubble() {
    if (bubbleHost || !document.documentElement) return;
    bubbleHost = document.createElement('div');
    bubbleHost.setAttribute('data-st-ui', 'bubble');
    bubbleHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;display:none;width:max-content;max-width:calc(100vw - 16px);';
    bubbleShadow = bubbleHost.attachShadow({ mode: 'open' });
    adopt(bubbleShadow, BUBBLE_CSS);

    bubbleCard = make('div', 'card');
    bubbleCard.setAttribute('role', 'status');
    bubbleCard.setAttribute('aria-live', 'polite');
    bubbleText = make('div', 'text');
    const dots = make('div', 'dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.appendChild(make('i'));
    dots.appendChild(make('i'));
    dots.appendChild(make('i'));
    bubbleCard.appendChild(bubbleText);
    bubbleCard.appendChild(dots);
    bubbleShadow.appendChild(bubbleCard);

    ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(type => {
      bubbleHost.addEventListener(type, e => e.stopPropagation());
    });
    document.documentElement.appendChild(bubbleHost);
  }

  function setCardLoading() {
    if (!bubbleCard) return;
    bubbleCard.classList.remove('error');
    bubbleCard.classList.add('loading');
    bubbleText.textContent = '';
  }

  function setCardText(text) {
    if (!bubbleCard) return;
    bubbleCard.classList.remove('loading', 'error');
    bubbleText.textContent = text;
  }

  function setCardError() {
    if (!bubbleCard) return;
    bubbleCard.classList.remove('loading');
    bubbleCard.classList.add('error');
    bubbleText.textContent = '翻译失败';
  }

  function positionBubble(rect) {
    if (!bubbleIsVisible() || !rect) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const w = bubbleHost.offsetWidth;
    const h = bubbleHost.offsetHeight;
    let top = rect.bottom + BUBBLE_GAP;
    if (top + h > vh - VIEW_MARGIN && rect.top - BUBBLE_GAP - h >= VIEW_MARGIN) {
      top = rect.top - BUBBLE_GAP - h;
    }
    top = Math.max(VIEW_MARGIN, Math.min(top, vh - VIEW_MARGIN - h));
    let left = rect.left;
    if (left + w > vw - VIEW_MARGIN) left = rect.right - w;
    left = Math.max(VIEW_MARGIN, Math.min(left, vw - VIEW_MARGIN - w));
    bubbleHost.style.left = left + 'px';
    bubbleHost.style.top = top + 'px';
  }

  function showBubbleAt(rect) {
    ensureBubble();
    if (!bubbleHost) return;
    bubbleHost.style.display = 'block';
    bubbleHost.style.visibility = 'hidden';
    positionBubble(rect);
    bubbleHost.style.visibility = '';
  }

  function repositionBubble() {
    if (!bubbleIsVisible() || !lastRange) return;
    if (repositionRaf) return;
    repositionRaf = requestAnimationFrame(() => {
      repositionRaf = 0;
      if (!bubbleIsVisible() || !lastRange) return;
      const rects = lastRange.getClientRects();
      if (!rects || !rects.length) {
        hideBubble();
        return;
      }
      const rect = rects[rects.length - 1];
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        hideBubble();
        return;
      }
      positionBubble(rect);
    });
  }

  function hideBubble() {
    if (!bubbleHost) return;
    clearTimeout(hideTimer);
    bubbleHost.style.display = 'none';
    lastRange = null;
    lastShownKey = '';
    activeSeq++;
  }

  function showTranslation(info) {
    const key = info.target + '\n' + info.text;
    if (key === lastShownKey && bubbleIsVisible()) {
      lastRange = info.range.cloneRange();
      repositionBubble();
      return;
    }

    lastShownKey = key;
    lastRange = info.range.cloneRange();
    const seq = ++activeSeq;
    clearTimeout(hideTimer);

    const cached = cacheGet(key);
    if (cached) {
      setCardText(cached.text);
      showBubbleAt(info.rect);
      repositionBubble();
      return;
    }

    setCardLoading();
    showBubbleAt(info.rect);

    getTranslation(info.text, info.target).then(res => {
      if (seq !== activeSeq) return;
      setCardText(res.text);
      repositionBubble();
    }).catch(() => {
      if (seq !== activeSeq) return;
      setCardError();
      repositionBubble();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideBubble, 1500);
    });
  }

  /* ================= 7. 更新检查与更新提示 ================= */

  const UPDATE_CSS = `
    :host { all: initial; }
    .pill {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: min(460px, calc(100vw - 32px));
      padding: 8px 8px 8px 12px;
      border-radius: 999px;
      background: #ffffff;
      color: #111827;
      border: 1px solid rgba(15, 23, 42, .1);
      box-shadow: 0 12px 32px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .06);
      font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 12.5px;
      line-height: 1.45;
      animation: st-upd-in .18s ease-out;
    }
    .icon { display: inline-flex; flex: none; color: #2563eb; }
    .msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btn {
      flex: none;
      border: 0;
      border-radius: 999px;
      padding: 5px 12px;
      background: #2563eb;
      color: #ffffff;
      font: inherit;
      font-weight: 600;
      line-height: 1.2;
      cursor: pointer;
      transition: background-color .15s ease-out;
    }
    .btn:hover { background: #1d4ed8; }
    .btn:active { background: #1e40af; }
    .close {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: #6b7280;
      cursor: pointer;
      transition: background-color .15s ease-out, color .15s ease-out;
    }
    .close:hover { background: rgba(15, 23, 42, .06); color: #111827; }
    .btn:focus-visible, .close:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .pill {
        background: #26282c;
        color: #e8eaed;
        border-color: rgba(255, 255, 255, .1);
        box-shadow: 0 12px 32px rgba(0, 0, 0, .5);
      }
      .btn:focus-visible, .close:focus-visible { outline-color: #60a5fa; }
      .icon { color: #60a5fa; }
      .close { color: #9ca3af; }
      .close:hover { background: rgba(255, 255, 255, .08); color: #f3f4f6; }
    }
    @media (prefers-reduced-motion: reduce) {
      .pill { animation: none; }
      .btn, .close { transition: none; }
    }
    @keyframes st-upd-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
  `;

  let updHost = null;
  let updShadow = null;
  let updMsg = null;
  let updateTarget = null;
  let updateShownVersion = '';
  let updateCheckPromise = null;

  function makeSvg(d, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  function openUrl(url) {
    try {
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(url, { active: true, insert: true });
        return;
      }
    } catch (e) {}
    window.open(url, '_blank', 'noopener');
  }

  function ensureUpdateUi() {
    if (updHost || !document.documentElement) return;
    updHost = document.createElement('div');
    updHost.setAttribute('data-st-ui', 'update');
    updHost.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;display:none;';
    updShadow = updHost.attachShadow({ mode: 'open' });
    adopt(updShadow, UPDATE_CSS);

    const pill = make('div', 'pill');
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');

    const icon = make('span', 'icon');
    icon.appendChild(makeSvg('M13.5 2.6v2.6h-2.6M13.5 8a5.5 5.5 0 1 1-1.61-3.89', 14));
    updMsg = make('span', 'msg');

    const btn = make('button', 'btn', '更新');
    btn.type = 'button';
    const close = make('button', 'close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭更新提示');
    close.title = '关闭';
    close.appendChild(makeSvg('M4.5 4.5l7 7M11.5 4.5l-7 7', 12));

    pill.appendChild(icon);
    pill.appendChild(updMsg);
    pill.appendChild(btn);
    pill.appendChild(close);
    updShadow.appendChild(pill);

    btn.addEventListener('click', () => {
      if (!updateTarget) return;
      const target = updateTarget;
      hideUpdatePill();
      openUrl(target.url);
    });
    close.addEventListener('click', () => {
      if (updateShownVersion) {
        try { sessionStorage.setItem(K.updateHide, updateShownVersion); } catch (e) {}
      }
      hideUpdatePill();
    });

    ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(type => {
      updHost.addEventListener(type, e => e.stopPropagation());
    });
    document.documentElement.appendChild(updHost);
  }

  function hideUpdatePill() {
    if (updHost) updHost.style.display = 'none';
  }

  function showUpdatePill(latest) {
    if (!latest || !latest.version) return;
    let hidden = '';
    try { hidden = sessionStorage.getItem(K.updateHide) || ''; } catch (e) {}
    if (hidden && cmpVersion(hidden, latest.version) === 0) return;

    ensureUpdateUi();
    if (!updHost) return;
    updateTarget = latest;
    updateShownVersion = latest.version;
    const cmp = cmpVersion(latest.version, SCRIPT_VERSION);
    updMsg.textContent = cmp > 0
      ? '脚本有新版本 v' + latest.version + '（当前 v' + SCRIPT_VERSION + '）'
      : 'GitHub 版本 v' + latest.version + ' 与当前 v' + SCRIPT_VERSION + ' 不一致';
    updMsg.title = updMsg.textContent;
    updHost.style.display = 'block';
  }

  async function githubJson(url) {
    const res = await gmRequest({
      url,
      timeout: UPDATE.timeout,
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status !== 200) throw new Error('github http ' + res.status);
    return JSON.parse(res.responseText || 'null');
  }

  async function probeMeta(url, bust) {
    try {
      const u = bust ? url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now() : url;
      const res = await gmRequest({
        url: u,
        timeout: UPDATE.timeout,
        headers: { 'Accept': 'text/plain, */*' },
      });
      if (res.status !== 200) return null;
      const meta = parseMeta(res.responseText || '');
      if (!meta || !meta.version) return null;
      return meta;
    } catch (e) {
      return null;
    }
  }

  async function discoverRemote() {
    const repo = await githubJson('https://api.github.com/repos/' + UPDATE.repo);
    const branch = repo && typeof repo.default_branch === 'string' && repo.default_branch ? repo.default_branch : 'main';
    const tree = await githubJson('https://api.github.com/repos/' + UPDATE.repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1');
    const paths = tree && Array.isArray(tree.tree)
      ? tree.tree
        .filter(x => x && x.type === 'blob' && typeof x.path === 'string' && /\.user\.js$/i.test(x.path))
        .map(x => x.path)
        .slice(0, 8)
      : [];
    if (!paths.length) throw new Error('远程仓库未找到脚本');

    const checks = [];
    for (const path of paths) {
      for (const source of ['raw', 'cdn']) {
        const url = source === 'raw' ? rawUrl(branch, path) : cdnUrl(branch, path);
        checks.push((async () => {
          const meta = await probeMeta(url, source === 'raw');
          if (meta && meta.version && isSameScript(meta)) {
            return { version: meta.version, url, branch, path, source };
          }
          return null;
        })());
      }
    }
    const found = (await Promise.all(checks)).filter(Boolean);
    if (!found.length) throw new Error('远程仓库未找到匹配脚本');
    return found[0];
  }

  async function fetchLatestFromGitHub() {
    // 主源优先：只发 1 个请求；失败后再并行探测其余分支/镜像
    const primaryBranch = UPDATE.branches[0];
    const primaryUrl = rawUrl(primaryBranch, UPDATE.file);
    const primaryMeta = await probeMeta(primaryUrl, true);
    if (primaryMeta && primaryMeta.version) {
      return { version: primaryMeta.version, url: primaryUrl, branch: primaryBranch, path: UPDATE.file, source: 'raw' };
    }

    const candidates = [];
    for (const branch of UPDATE.branches) {
      for (const source of ['raw', 'cdn']) {
        if (branch === primaryBranch && source === 'raw') continue;
        candidates.push({
          branch,
          path: UPDATE.file,
          source,
          url: source === 'raw' ? rawUrl(branch, UPDATE.file) : cdnUrl(branch, UPDATE.file),
        });
      }
    }
    const results = await Promise.all(candidates.map(async c => {
      const meta = await probeMeta(c.url, c.source === 'raw');
      return meta && meta.version
        ? { version: meta.version, url: c.url, branch: c.branch, path: c.path, source: c.source }
        : null;
    }));
    const hit = results.find(Boolean);
    if (hit) return hit;
    return discoverRemote();
  }

  async function checkUpdate(opts) {
    opts = opts || {};
    const now = Date.now();
    const state = GM_getValue(K.updateState, null);
    let latest = state && state.latest && typeof state.latest.version === 'string' ? state.latest : null;
    const fresh = !!(state && typeof state.at === 'number' && now - state.at < UPDATE.ttl);

    let failed = false;
    if (opts.force || !latest || !fresh) {
      try {
        latest = await fetchLatestFromGitHub();
        GM_setValue(K.updateState, { at: now, latest });
      } catch (e) {
        failed = true; // 失败时沿用上次缓存（如果有）
      }
    }

    if (!latest || !latest.version) {
      if (opts.onResult) opts.onResult('error', null, true);
      return { status: 'error', latest: null };
    }

    const cmp = cmpVersion(latest.version, SCRIPT_VERSION);
    if (cmp === 0) {
      if (opts.onResult) opts.onResult('latest', latest, failed);
      return { status: 'latest', latest };
    }

    showUpdatePill(latest);
    if (opts.onResult) opts.onResult('update', latest, failed);
    return { status: 'update', latest };
  }

  function scheduleUpdateCheck() {
    if (!IS_TOP) return;
    const idle = window.requestIdleCallback
      ? (fn => window.requestIdleCallback(fn, { timeout: 5000 }))
      : (fn => setTimeout(fn, 2500));
    idle(() => {
      if (updateCheckPromise) return;
      updateCheckPromise = checkUpdate({}).catch(() => {}).finally(() => {
        updateCheckPromise = null;
      });
    });
  }

  /* ================= 8. 可视化设置面板 ================= */

  const SETTINGS_CSS = `
    :host { all: initial; }
    .wrap {
      font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .panel {
      box-sizing: border-box;
      width: min(360px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      overflow: auto;
      overscroll-behavior: contain;
      padding: 16px;
      border-radius: 14px;
      background: #ffffff;
      color: #16181d;
      border: 1px solid rgba(15, 23, 42, .1);
      box-shadow: 0 18px 48px rgba(15, 23, 42, .18), 0 3px 8px rgba(15, 23, 42, .06);
      animation: st-set-in .15s ease-out;
    }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .brand { display: inline-flex; flex: none; color: #2563eb; }
    .title { flex: 1; min-width: 0; margin: 0; font-size: 14px; font-weight: 600; line-height: 1.4; color: inherit; }
    .icon-btn {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #64748b;
      cursor: pointer;
      transition: background-color .15s ease-out, color .15s ease-out;
    }
    .icon-btn:hover { background: rgba(15, 23, 42, .06); color: #111827; }
    .sub { margin: 0 0 4px; font-size: 12px; line-height: 1.55; color: #64748b; }
    .field { margin-top: 14px; }
    .label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .label { font-size: 12px; font-weight: 600; letter-spacing: .01em; color: #334155; }
    .input {
      box-sizing: border-box;
      width: 100%;
      height: 36px;
      padding: 0 10px;
      border: 1px solid rgba(15, 23, 42, .16);
      border-radius: 8px;
      background: #ffffff;
      color: #16181d;
      font: inherit;
      font-size: 13px;
      transition: border-color .15s ease-out, box-shadow .15s ease-out;
    }
    .input::placeholder { color: #64748b; }
    .input:hover { border-color: rgba(15, 23, 42, .3); }
    .input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .16); }
    .input.invalid { border-color: #dc2626; }
    .input.invalid:focus { box-shadow: 0 0 0 3px rgba(220, 38, 38, .16); }
    .hint { margin-top: 5px; font-size: 11.5px; line-height: 1.5; color: #64748b; }
    .err { display: none; margin-top: 5px; font-size: 11.5px; font-weight: 500; color: #dc2626; }
    .err.show { display: block; }
    .link-btn {
      padding: 2px 6px;
      margin: -2px -6px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      font: inherit;
      font-size: 11.5px;
      font-weight: 600;
      color: #dc2626;
      cursor: pointer;
      transition: background-color .15s ease-out;
    }
    .link-btn:hover { background: rgba(220, 38, 38, .08); }
    .btn {
      height: 34px;
      padding: 0 16px;
      border: 0;
      border-radius: 8px;
      background: #2563eb;
      color: #ffffff;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color .15s ease-out;
    }
    .btn:hover { background: #1d4ed8; }
    .btn:active { background: #1e40af; }
    .icon-btn:focus-visible, .link-btn:focus-visible, .btn:focus-visible, .fab:focus-visible {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
    }
    .foot { display: flex; align-items: center; gap: 10px; margin-top: 20px; }
    .status {
      flex: 1;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: #15803d;
      opacity: 0;
      transition: opacity .15s ease-out;
    }
    .status.show { opacity: 1; }
    .status .ic { display: inline-flex; flex: none; }
    .status .txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fab {
      display: none;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      padding: 0;
      border: 1px solid rgba(15, 23, 42, .1);
      border-radius: 50%;
      background: #ffffff;
      color: #2563eb;
      cursor: pointer;
      box-shadow: 0 10px 28px rgba(15, 23, 42, .2), 0 2px 6px rgba(15, 23, 42, .08);
      transition: transform .15s ease-out, background-color .15s ease-out;
    }
    .fab:hover { background: #f8fafc; }
    .fab:active { transform: scale(.96); }
    @media (prefers-color-scheme: dark) {
      .panel {
        background: #26282c;
        color: #e8eaed;
        border-color: rgba(255, 255, 255, .1);
        box-shadow: 0 18px 48px rgba(0, 0, 0, .55), 0 3px 8px rgba(0, 0, 0, .3);
      }
      .brand { color: #60a5fa; }
      .sub, .hint { color: #9ca3af; }
      .label { color: #cbd5e1; }
      .icon-btn { color: #9ca3af; }
      .icon-btn:hover { background: rgba(255, 255, 255, .08); color: #f3f4f6; }
      .input { background: #1f2125; color: #e8eaed; border-color: rgba(255, 255, 255, .14); }
      .input::placeholder { color: #9ca3af; }
      .input:hover { border-color: rgba(255, 255, 255, .26); }
      .input:focus { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(96, 165, 250, .22); }
      .input.invalid { border-color: #f87171; }
      .input.invalid:focus { box-shadow: 0 0 0 3px rgba(248, 113, 113, .2); }
      .err, .link-btn { color: #f87171; }
      .link-btn:hover { background: rgba(248, 113, 113, .12); }
      .status { color: #4ade80; }
      .icon-btn:focus-visible, .link-btn:focus-visible, .btn:focus-visible, .fab:focus-visible {
        outline-color: #60a5fa;
      }
      .fab { background: #26282c; color: #60a5fa; border-color: rgba(255, 255, 255, .1); }
      .fab:hover { background: #2f3237; }
    }
    @media (prefers-reduced-motion: reduce) {
      .panel { animation: none; }
      .input, .icon-btn, .link-btn, .btn, .status, .fab { transition: none; }
    }
    @keyframes st-set-in {
      from { opacity: .5; transform: translateY(-4px); }
      to { opacity: 1; transform: none; }
    }
  `;

  let setHost = null;
  let setShadow = null;
  let setPanel = null;
  let setFab = null;
  let setUrl = null;
  let setKey = null;
  let setModel = null;
  let setStatusEl = null;
  let setStatusText = null;
  let setUrlErr = null;
  let setClearBtn = null;
  let setStatusTimer = 0;
  let lastFocus = null;

  function isHttpUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function settingsOpen() {
    return !!(setHost && setHost.style.display !== 'none');
  }

  function flashStatus(message) {
    if (!setStatusEl) return;
    clearTimeout(setStatusTimer);
    setStatusText.textContent = message;
    setStatusEl.classList.add('show');
    setStatusTimer = setTimeout(() => setStatusEl.classList.remove('show'), 1800);
  }

  function refreshKeyField() {
    if (!setKey) return;
    setKey.value = '';
    setKey.placeholder = cfg.key ? '已保存 ' + maskKey(cfg.key) + '（留空保持不变）' : '未设置';
    if (setClearBtn) setClearBtn.style.display = cfg.key ? '' : 'none';
  }

  function showUrlError(show) {
    if (!setUrl || !setUrlErr) return;
    if (show) setUrl.classList.add('invalid');
    else setUrl.classList.remove('invalid');
    if (show) setUrlErr.classList.add('show');
    else setUrlErr.classList.remove('show');
    setUrl.setAttribute('aria-invalid', show ? 'true' : 'false');
  }

  function ensureSettingsUi() {
    if (setHost || !document.documentElement) return;
    setHost = document.createElement('div');
    setHost.setAttribute('data-st-ui', 'settings');
    setHost.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;display:none;';
    setShadow = setHost.attachShadow({ mode: 'open' });
    adopt(setShadow, SETTINGS_CSS);

    const wrap = make('div', 'wrap');

    setPanel = make('section', 'panel');
    setPanel.setAttribute('role', 'dialog');
    setPanel.setAttribute('aria-labelledby', 'st-set-title');

    const head = make('div', 'head');
    const brand = make('span', 'brand');
    brand.appendChild(makeSvg('M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13M1.5 8h13M8 1.5c1.8 1.6 2.8 4 2.8 6.5s-1 4.9-2.8 6.5c-1.8-1.6-2.8-4-2.8-6.5s1-4.9 2.8-6.5', 15));
    const title = make('h2', 'title', '划词翻译设置');
    title.id = 'st-set-title';
    const btnMin = make('button', 'icon-btn');
    btnMin.type = 'button';
    btnMin.setAttribute('aria-label', '最小化设置');
    btnMin.title = '最小化';
    btnMin.appendChild(makeSvg('M3.5 8h9', 14));
    const btnClose = make('button', 'icon-btn');
    btnClose.type = 'button';
    btnClose.setAttribute('aria-label', '关闭设置');
    btnClose.title = '关闭';
    btnClose.appendChild(makeSvg('M4.5 4.5l7 7M11.5 4.5l-7 7', 12));
    head.appendChild(brand);
    head.appendChild(title);
    head.appendChild(btnMin);
    head.appendChild(btnClose);

    const sub = make('p', 'sub', 'Google → Microsoft → 腾讯翻译 → MyMemory → LLM 自动回退。配置仅保存在篡改猴本地。');

    const urlField = make('div', 'field');
    const urlRow = make('div', 'label-row');
    const urlLabel = make('label', 'label', 'LLM 接口 URL');
    urlLabel.setAttribute('for', 'st-set-url');
    urlRow.appendChild(urlLabel);
    setUrl = make('input', 'input');
    setUrl.id = 'st-set-url';
    setUrl.type = 'url';
    setUrl.placeholder = 'https://api.deepseek.com/v1';
    setUrl.spellcheck = false;
    setUrl.autocomplete = 'off';
    setUrl.setAttribute('autocapitalize', 'off');
    setUrl.setAttribute('autocorrect', 'off');
    setUrl.setAttribute('aria-describedby', 'st-set-url-hint st-set-url-err');
    const urlHint = make('div', 'hint', 'OpenAI 兼容接口，自动补全 /chat/completions；留空则禁用 LLM 兜底。');
    urlHint.id = 'st-set-url-hint';
    setUrlErr = make('div', 'err', '请输入以 http:// 或 https:// 开头的有效地址');
    setUrlErr.id = 'st-set-url-err';
    urlField.appendChild(urlRow);
    urlField.appendChild(setUrl);
    urlField.appendChild(urlHint);
    urlField.appendChild(setUrlErr);

    const keyField = make('div', 'field');
    const keyRow = make('div', 'label-row');
    const keyLabel = make('label', 'label', 'API Key');
    keyLabel.setAttribute('for', 'st-set-key');
    setClearBtn = make('button', 'link-btn', '清除');
    setClearBtn.type = 'button';
    setClearBtn.title = '清除已保存的 API Key';
    keyRow.appendChild(keyLabel);
    keyRow.appendChild(setClearBtn);
    setKey = make('input', 'input');
    setKey.id = 'st-set-key';
    setKey.type = 'password';
    setKey.autocomplete = 'new-password';
    setKey.setAttribute('aria-describedby', 'st-set-key-hint');
    const keyHint = make('div', 'hint', '输入新 Key 并保存即替换；界面只显示脱敏值，不会上传。');
    keyHint.id = 'st-set-key-hint';
    keyField.appendChild(keyRow);
    keyField.appendChild(setKey);
    keyField.appendChild(keyHint);

    const modelField = make('div', 'field');
    const modelRow = make('div', 'label-row');
    const modelLabel = make('label', 'label', '模型名');
    modelLabel.setAttribute('for', 'st-set-model');
    modelRow.appendChild(modelLabel);
    setModel = make('input', 'input');
    setModel.id = 'st-set-model';
    setModel.type = 'text';
    setModel.placeholder = 'deepseek-flash';
    setModel.spellcheck = false;
    setModel.autocomplete = 'off';
    setModel.setAttribute('autocapitalize', 'off');
    setModel.setAttribute('autocorrect', 'off');
    modelField.appendChild(modelRow);
    modelField.appendChild(setModel);

    const foot = make('div', 'foot');
    setStatusEl = make('span', 'status');
    setStatusEl.setAttribute('role', 'status');
    setStatusEl.setAttribute('aria-live', 'polite');
    const statusIc = make('span', 'ic');
    statusIc.appendChild(makeSvg('M3 8.5l3 3 7-8', 13));
    setStatusText = make('span', 'txt');
    setStatusEl.appendChild(statusIc);
    setStatusEl.appendChild(setStatusText);
    const btnSave = make('button', 'btn', '保存设置');
    btnSave.type = 'button';
    foot.appendChild(setStatusEl);
    foot.appendChild(btnSave);

    setPanel.appendChild(head);
    setPanel.appendChild(sub);
    setPanel.appendChild(urlField);
    setPanel.appendChild(keyField);
    setPanel.appendChild(modelField);
    setPanel.appendChild(foot);

    setFab = make('button', 'fab');
    setFab.type = 'button';
    setFab.setAttribute('aria-label', '展开翻译设置');
    setFab.title = '翻译设置';
    setFab.appendChild(makeSvg('M2 4h6.5M12.5 4h1.5M12.5 4a2 2 0 1 1-4 0 2 2 0 1 1 4 0M2 8h3.5M9.5 8h4.5M9.5 8a2 2 0 1 1-4 0 2 2 0 1 1 4 0M2 12h7M13 12h1M13 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0', 17));

    wrap.appendChild(setPanel);
    wrap.appendChild(setFab);
    setShadow.appendChild(wrap);

    btnMin.addEventListener('click', minimizeSettings);
    btnClose.addEventListener('click', closeSettings);
    btnSave.addEventListener('click', saveSettings);
    setClearBtn.addEventListener('click', clearKey);
    setFab.addEventListener('click', restoreSettings);
    setUrl.addEventListener('input', () => showUrlError(false));
    setUrl.addEventListener('blur', () => {
      const v = setUrl.value.trim();
      showUrlError(!!v && !isHttpUrl(v));
    });
    setPanel.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
        e.preventDefault();
        saveSettings();
      }
    });

    ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(type => {
      setHost.addEventListener(type, e => e.stopPropagation());
    });
    document.documentElement.appendChild(setHost);
  }

  function openSettings() {
    ensureSettingsUi();
    if (!setHost) return;
    lastFocus = document.activeElement;
    setHost.style.display = 'block';
    setPanel.style.display = 'block';
    setFab.style.display = 'none';
    setUrl.value = cfg.url;
    setModel.value = cfg.model;
    refreshKeyField();
    showUrlError(false);
    clearTimeout(setStatusTimer);
    setStatusEl.classList.remove('show');
    setStatusText.textContent = '';
    requestAnimationFrame(() => {
      try { setUrl.focus(); } catch (e) {}
    });
  }

  function minimizeSettings() {
    if (!setHost) return;
    setPanel.style.display = 'none';
    setFab.style.display = 'inline-flex';
    try { setFab.focus(); } catch (e) {}
  }

  function restoreSettings() {
    if (!setHost) return;
    setPanel.style.display = 'block';
    setFab.style.display = 'none';
    try { setUrl.focus(); } catch (e) {}
  }

  function closeSettings() {
    if (!setHost || setHost.style.display === 'none') return;
    setHost.style.display = 'none';
    clearTimeout(setStatusTimer);
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) {}
    }
    lastFocus = null;
  }

  function saveSettings() {
    if (!setUrl || !setKey || !setModel) return;
    const url = setUrl.value.trim();
    if (url && !isHttpUrl(url)) {
      showUrlError(true);
      setUrl.focus();
      return;
    }
    showUrlError(false);
    const key = setKey.value.trim();
    cfg.url = url;
    cfg.model = setModel.value.trim() || 'deepseek-flash';
    if (key) cfg.key = key;
    GM_setValue(K.llmUrl, cfg.url);
    GM_setValue(K.llmModel, cfg.model);
    if (key) GM_setValue(K.llmKey, cfg.key);
    resetLlmFailure();
    refreshKeyField();
    flashStatus('已保存');
  }

  function clearKey() {
    if (!cfg.key) return;
    cfg.key = '';
    GM_setValue(K.llmKey, '');
    resetLlmFailure();
    refreshKeyField();
    flashStatus('Key 已清除');
  }

  /* ================= 9. 选区读取与事件 ================= */

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    let text = String(sel.toString() || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (!/[\p{L}]/u.test(text)) return null;
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);

    const anchor = sel.anchorNode;
    if (!anchor) return null;
    const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    if (!el) return null;
    const root = el.getRootNode();
    if (bubbleShadow && root === bubbleShadow) return null;
    if (updShadow && root === updShadow) return null;
    if (setShadow && root === setShadow) return null;
    if (el.closest(EDITABLE_SELECTOR)) return null;
    if (document.designMode && String(document.designMode).toLowerCase() === 'on') return null;

    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return null;

    return {
      text,
      target: detectTarget(text),
      range,
      rect,
    };
  }

  function onSelectionChange() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const info = readSelection();
      if (!info) return;
      if (isMouseSelecting) {
        // 拖选中只预取，不弹层
        getTranslation(info.text, info.target).catch(() => {});
        return;
      }
      showTranslation(info);
    }, 320);
  }

  function onPageMouseDown(e) {
    if (e.button === 0) isMouseSelecting = true;
    if (!bubbleIsVisible()) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (bubbleHost && path.indexOf(bubbleHost) !== -1) return;
    if (updHost && path.indexOf(updHost) !== -1) return;
    if (setHost && path.indexOf(setHost) !== -1) return;
    if (e.button === 0) hideBubble();
  }

  function onPageMouseUp(e) {
    if (e.button !== 0) return;
    isMouseSelecting = false;
    const path = e.composedPath ? e.composedPath() : [];
    if (bubbleHost && path.indexOf(bubbleHost) !== -1) return;
    if (updHost && path.indexOf(updHost) !== -1) return;
    if (setHost && path.indexOf(setHost) !== -1) return;
    setTimeout(() => {
      const info = readSelection();
      if (info) showTranslation(info);
    }, 0);
  }

  function onPageKeyDown(e) {
    if (e.key !== 'Escape') return;
    const path = e.composedPath ? e.composedPath() : [];
    const inSettings = !!(setHost && path.indexOf(setHost) !== -1);
    if (settingsOpen()) {
      if (inSettings) e.stopPropagation();
      closeSettings();
      return;
    }
    hideBubble();
    hideUpdatePill();
  }

  function onPageScroll() {
    repositionBubble();
  }

  function onWindowBlur() {
    isMouseSelecting = false;
  }

  function onPointerUp() {
    isMouseSelecting = false;
  }

  /* ================= 10. 预热与菜单 ================= */

  function warmupEngines() {
    if (!IS_TOP) return;
    const idle = window.requestIdleCallback
      ? (fn => window.requestIdleCallback(fn, { timeout: 4000 }))
      : (fn => setTimeout(fn, 1200));
    idle(() => {
      if (!(downUntil.google > Date.now())) {
        googleTranslate('hello', 'zh').then(() => markUp('google')).catch(() => markDown('google'));
      }
      if (!(downUntil.ms > Date.now())) {
        getMsToken()
          .then(() => msTranslate('hi', 'zh'))
          .then(() => markUp('ms'))
          .catch(() => markDown('ms'));
      }
    });
  }

  function resetLlmFailure() {
    markUp('llm');
  }

  function menu(label, fn) {
    try {
      if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, fn);
    } catch (e) {}
  }

  function registerMenus() {
    menu('打开设置面板', openSettings);

    menu('检查脚本更新（GitHub）', () => {
      checkUpdate({
        force: true,
        onResult: (status, latest, failed) => {
          if (status === 'error') {
            alert('检查失败：无法访问 GitHub（raw）与 jsDelivr，请检查网络后重试。');
          } else if (status === 'latest') {
            alert(failed ? '网络检查失败，沿用上次缓存：当前仍是最新版本 v' + SCRIPT_VERSION : '已是最新版本 v' + SCRIPT_VERSION);
          } else {
            alert((failed ? '网络检查失败，以下为上次缓存结果：' : '') + 'GitHub v' + latest.version + ' / 当前 v' + SCRIPT_VERSION + '。已显示更新按钮。');
          }
        },
      }).catch(() => {});
    });
  }

  /* ================= 11. 启动 ================= */

  function boot() {
    if (!document.documentElement) return;
    // 菜单只由顶层帧注册：子帧里的 prompt/alert 可能被沙箱或跨域策略拦截
    if (IS_TOP) registerMenus();
    window.addEventListener('mousedown', onPageMouseDown, true);
    window.addEventListener('mouseup', onPageMouseUp, true);
    window.addEventListener('keydown', onPageKeyDown, true);
    window.addEventListener('scroll', onPageScroll, true);
    window.addEventListener('resize', repositionBubble, { passive: true });
    window.addEventListener('blur', onWindowBlur, true);
    window.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('selectionchange', onSelectionChange);
    warmupEngines();
    scheduleUpdateCheck();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
