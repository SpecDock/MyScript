// ==UserScript==
// @name         Selection Translator
// @namespace    specdock.my-script.selection-translator
// @version      1.1.0
// @description  静默划词翻译：中文→英文，其他→中文。Google → Microsoft → LLM 自动回退；GitHub 版本检测与一键更新。
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
  const FALLBACK_VERSION = '1.1.0';
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
  const GOOGLE_TIMEOUT = 1500;
  const MS_TOKEN_TIMEOUT = 1800;
  const MS_TIMEOUT = 3000;
  const LLM_TIMEOUT = 20000;
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
    updateState: 'st.update.state',
    updateHide: 'st.update.hide',
  };

  const cfg = {
    url: String(GM_getValue(K.llmUrl, '') || ''),
    key: String(GM_getValue(K.llmKey, '') || ''),
    model: String(GM_getValue(K.llmModel, 'deepseek-flash') || 'deepseek-flash'),
  };

  const downUntil = Object.create(null);
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