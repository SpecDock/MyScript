// ==UserScript==
// @name         Selection Translator
// @namespace    specdock.my-script.selection-translator
// @version      1.1.0
// @description  静默划词翻译：中文→英文，其他→中文。Google → Microsoft → LLM 自动回退；GitHub 版本检测与一键更新。
// @version      1.2.0
// @description  静默划词翻译：中文→英文，其他→中文。Google → Microsoft → LLM 自动回退；可视化设置面板；GitHub 版本检测与一键更新。
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
// @connect      *
// @updateURL    https://raw.githubusercontent.com/SpecDock/MyScript/master/selection-translator.user.js
// @downloadURL  https://raw.githubusercontent.com/SpecDock/MyScript/master/selection-translator.user.js
// ==/UserScript==

(() => {
  'use strict';

  /* ================= 1. 常量与配置 ================= */

  const SCRIPT_NAME = 'Selection Translator';
  const SCRIPT_NS = 'specdock.my-script.selection-translator';
  const FALLBACK_VERSION = '1.1.0';
  const FALLBACK_VERSION = '1.2.0';
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

  const ENGINE_ORDER = ['google', 'ms', 'llm'];
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
          timeout: 0,
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

  /* ================= 8. 选区读取与事件 ================= */
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