// ==UserScript==
// @name         学堂在线自动刷课 + AI 自动做题
// @namespace    https://www.xuetangx.com/
// @version      1.7.0
// @description  通用版：自动刷视频进度（真静音、暂停自动续播）；进到章节作业后自动提取题目、请求 AI、选择答案并真实提交，提交后页面自动切到下一题（支持单选 / 多选 / 判断题）。腾讯点选文字验证码自动识别（需支持视觉的模型）。以当前所在页面为准，换任何一门课都能直接用。
// @author       local
// @match        https://www.xuetangx.com/*
// @match        https://turing.captcha.gtimg.com/*
// @match        https://turing.captcha.qcloud.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @updateURL    https://raw.githubusercontent.com/SpecDock/MyScript/master/学堂在线刷课AI做题.user.js
// @downloadURL  https://raw.githubusercontent.com/SpecDock/MyScript/master/学堂在线刷课AI做题.user.js
// @supportURL   https://github.com/SpecDock/MyScript/issues
// @connect      *
// @run-at       document-start
// ==/UserScript==

/* =========================================================================
 * 一、需要你填写的变量（也可以直接在页面右下角的面板里填，会存进油猴存储）
 * ========================================================================= */
const CONFIG = {
  // AI 接口地址（OpenAI 兼容格式），例如：
  //   DeepSeek : https://api.deepseek.com/v1/chat/completions
  //   智谱 GLM : https://open.bigmodel.cn/api/paas/v4/chat/completions
  //   通义千问 : https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
  //   Kimi     : https://api.moonshot.cn/v1/chat/completions
  AI_API_URL: "",

  // AI 接口 Key
  AI_API_KEY: "",

  // 模型名（留空 = 用面板里填的；面板里填的会被油猴记住）
  AI_MODEL: "",

  // 课程地址（留空 = 自动跟随你当前所在的学习页）
  // 脚本以「当前页面」为准：打开任意一门课的 learn/space 页面，点开始即可
  COURSE_URL: "",

  // "both" 刷课+做题 | "video" 只刷课 | "exercise" 只做题
  MODE: "both",

  // 执行顺序固定为「以当前所在页面为先」：启动后先处理你当前停在这一页的章节，
  // 再从当前位置接着往后做。运行中你手动切页，脚本会跟着当前页走。

  // 播放倍速。注意平台会检测快进/拖拽，>1 可能不计进度
  PLAYBACK_RATE: 1.0,

  // 【内部调试开关，面板上没有这个选项】
  // true = 只演练：提交会被拦截，不消耗作答机会（仅供自测）
  // false = 真实提交：每题只有 1 次机会，提交后不能撤回
  DRY_RUN: false,

  // AI 调不通（没填 Key / Key 错 / 接口报错）时是否立刻中止整个任务。
  // false（默认）= 只跳过这一题，继续做后面的题
  // true = 立刻停下并报错，避免"跑完一圈却一题没提交"
  // （面板里随时可以改；改了会被记住）
  ABORT_ON_AI_ERROR: false,

  // 播放期间的检查间隔（毫秒）
  POLL_MS: 5000,

  // 最多刷几个视频，0 = 不限
  MAX_VIDEOS: 0,

  // 单题最多请求 AI 几次
  MAX_ROUNDS: 3,

  // AI 给的答案不合规时，最多追加几次"纠正提示词"重试（不算第一次请求）。
  // 2 = 最多 3 次请求：首发 1 次 + 纠正重试 2 次。
  MAX_FIX_ROUNDS: 2,

  // 进入页面后是否自动开始
  AUTO_START: false,
};

/* ---------------------------------------------------------------------------
 * GitHub 自动更新
 * ---------------------------------------------------------------------------
 * 油猴（Tampermonkey 5.x）的原生更新机制：
 *   ① 油猴会定期去 @updateURL 拉脚本，比较 @version；发现更高版本就下载 @downloadURL 并安装。
 *      油猴默认设置里 `scriptUpdateAutomaticInstall = true`（自动安装），
 *      检查间隔默认 24 小时，可以在 油猴 → 设置 → 常规 → 脚本更新 里改成「每次运行」。
 *   ② 但油猴**接管 URL**（即"点链接直接弹出安装/更新页"）只认结尾是 `.user.js` / `.tamper.js` 的地址
 *      （实测油猴 5.5.1 源码里的判定：/[^/]{1}\.user\.(js#|js\?|js$)/）。
 *      所以仓库里的文件名必须是 .user.js 结尾，面板里的「更新」按钮才能一键交给油猴。
 *
 * 因此配两个地址：
 *   url         —— 主地址（仓库文件改名后的 .user.js），和 @updateURL / @downloadURL 保持一致
 *   fallbackUrl —— 旧文件名（.txt），改名完成前仍然能用（面板照样能查到版本）
 * ------------------------------------------------------------------------- */
const UPDATE = {
  // 主地址：仓库里文件名改成 *.user.js 之后的地址（必须和元数据里的 @updateURL / @downloadURL 一致）
  url: "https://raw.githubusercontent.com/SpecDock/MyScript/master/学堂在线刷课AI做题.user.js",
  // 兜底地址：改名之前的旧文件名。改名还没做完时，面板照样能查到远程版本
  fallbackUrl: "https://raw.githubusercontent.com/SpecDock/MyScript/master/学堂在线刷课AI做题.txt",
  // 仓库主页（降级指引里给用户点）
  repoUrl: "https://github.com/SpecDock/MyScript",
  // 两次自动检查之间的最小间隔（毫秒），避免每次翻页都打一次 GitHub
  checkIntervalMs: 5 * 60 * 1000,
};

/* =========================================================================
 * 二、基础工具
 * ========================================================================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 学习页 URL 有两种形态（实测）：
 *   新版：/learn/space/{sign}/{sign}/{cid}/{kind}/{leafId}
 *   旧版：/learn/{sign}/{sign}/{cid}/{kind}/{leafId}      （少了 space 段）
 * kind 取值：video / exercise / exam / discussion
 */
const PAGE_RE = /\/learn\/(?:space\/)?([^/]+)\/([^/]+)\/(\d+)\/(video|exercise|exam|discussion)\/(\d+)/;

function pageInfo() {
  const m = PAGE_RE.exec(location.pathname);
  if (!m) return null;
  return { sign: m[1], cid: m[3], kind: m[4], leafId: m[5] };
}

const STORE_KEY = "xtx_settings_v1";
const RUN_KEY = "xtx_run_state_v1";
const RELOAD_KEY = "xtx_reload_count_v1";

function gmGet(k, def) {
  try { const v = GM_getValue(k, def); return v === undefined || v === null ? def : v; } catch (e) { return def; }
}
function gmSet(k, v) { try { GM_setValue(k, v); } catch (e) { /* ignore */ } }
function gmDel(k) { try { GM_deleteValue(k); } catch (e) { /* ignore */ } }

/** 接口地址补全：只填到 /v1 这类根路径时，自动补上 /chat/completions */
function normalizeAiUrl(u) {
  const s = String(u || "").trim();
  if (!s) return s;
  if (/\/chat\/completions\/?$/i.test(s)) return s;
  if (/\/v\d+[a-z]*\/?$/i.test(s)) return s.replace(/\/+$/, "") + "/chat/completions";
  return s;
}

/* 「AI 出错时」的偏好版本号。
 * 这个选项存在 Tampermonkey 存储里，更新脚本不会清空，
 * 所以光改 CONFIG 里的默认值对老安装不生效（存的还是旧值 true）。
 * 用一次性迁移把它改成「跳过该题继续」，迁移只做一次，
 * 之后你自己在面板里的手动选择会被正常记住。 */
const ABORT_PREF_VERSION = 1;
let abortPrefMigrated = false;

function loadSettings() {
  const s = gmGet(STORE_KEY, {}) || {};
  const num = (v, d) => { const n = Number(v); return (v !== "" && v !== null && v !== undefined && isFinite(n) && n > 0) ? n : d; };
  // 一次性迁移：把旧的默认「中止报错」改成「跳过该题继续」
  if (s.abortPrefVersion !== ABORT_PREF_VERSION) {
    s.ABORT_ON_AI_ERROR = false;
    s.abortPrefVersion = ABORT_PREF_VERSION;
    abortPrefMigrated = true;
    gmSet(STORE_KEY, s);
  }
  return {
    // 面板里填过的值优先于源码里的默认值（所以模型名改了会被记住）
    AI_API_URL: normalizeAiUrl(s.AI_API_URL || CONFIG.AI_API_URL || ""),
    AI_API_KEY: String(s.AI_API_KEY || CONFIG.AI_API_KEY || "").trim(),
    AI_MODEL: String(s.AI_MODEL || CONFIG.AI_MODEL || "deepseek-chat").trim(),
    MODE: s.MODE || CONFIG.MODE || "both",
    PLAYBACK_RATE: num(s.PLAYBACK_RATE || CONFIG.PLAYBACK_RATE, 1),
    // 演练模式只在源码里改，面板没有这个开关
    DRY_RUN: !!CONFIG.DRY_RUN,
    ABORT_ON_AI_ERROR: (s.ABORT_ON_AI_ERROR !== undefined)
      ? (s.ABORT_ON_AI_ERROR === true || s.ABORT_ON_AI_ERROR === "1")
      : !!CONFIG.ABORT_ON_AI_ERROR,
    // 带上版本号，避免被 readPanel() 存回去时丢掉（丢了会重复迁移、覆盖你的手动选择）
    abortPrefVersion: ABORT_PREF_VERSION,
    POLL_MS: num(CONFIG.POLL_MS || s.POLL_MS, 5000),
    MAX_VIDEOS: Number(CONFIG.MAX_VIDEOS || s.MAX_VIDEOS || 0),
    MAX_ROUNDS: num(CONFIG.MAX_ROUNDS || s.MAX_ROUNDS, 3),
  };
}
function saveSettings(s) { gmSet(STORE_KEY, s); }

/* =========================================================================
 * 三、日志面板
 *    设计：暗色 OLED 主题 / 密集排版 / 单一主操作（开始 ↔ 停止）
 *    面板不可关闭，只能最小化；最小化后仅剩标题栏。
 * ========================================================================= */
let panel = null, logBox = null, statusEl = null, ctaBtn = null;

const ICON_PLAY = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5 3.4v9.2L13 8z" fill="currentColor"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor"/></svg>';
const ICON_MIN  = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function ensurePanel() {
  if (panel) return;
  panel = document.createElement("div");
  panel.id = "xtx-bot-panel";
  panel.innerHTML = `
    <style>
      #xtx-bot-panel{
        position:fixed;right:16px;bottom:16px;width:320px;z-index:2147483647;
        font:12px/1.5 Inter,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
        color:#F8FAFC;background:#0F172A;border:1px solid #1E293B;border-radius:12px;
        box-shadow:0 16px 48px rgba(0,0,0,.55);overflow:hidden;
        transition:width .2s ease}
      #xtx-bot-panel *{box-sizing:border-box}
      #xtx-bot-panel .xtx-hd{display:flex;align-items:center;justify-content:space-between;
        gap:8px;padding:10px 10px 10px 12px;border-bottom:1px solid #1E293B;
        cursor:grab;user-select:none}
      #xtx-bot-panel .xtx-hd:active{cursor:grabbing}
      #xtx-bot-panel .xtx-brand{display:flex;align-items:center;gap:8px;min-width:0}
      #xtx-bot-panel .xtx-led{width:8px;height:8px;flex:none;border-radius:50%;
        background:#475569;transition:background .2s ease}
      #xtx-bot-panel.is-running .xtx-led{background:#22C55E;animation:xtx-blink 1.4s ease-in-out infinite}
      #xtx-bot-panel .xtx-title{font-size:12.5px;font-weight:600;letter-spacing:.2px;
        color:#F8FAFC;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #xtx-bot-panel .xtx-icon{flex:none;width:26px;height:26px;display:grid;place-items:center;
        border:0;border-radius:7px;background:transparent;color:#94A3B8;cursor:pointer;
        transition:background .16s ease,color .16s ease}
      #xtx-bot-panel .xtx-icon:hover{background:#1E293B;color:#F8FAFC}
      #xtx-bot-panel .xtx-icon:focus-visible{outline:2px solid #22C55E;outline-offset:1px}
      #xtx-bot-panel .xtx-body{display:grid;gap:8px;padding:12px}
      #xtx-bot-panel.xtx-collapsed{width:auto;min-width:200px}
      #xtx-bot-panel.xtx-collapsed .xtx-body{display:none}
      #xtx-bot-panel.xtx-collapsed .xtx-hd{border-bottom:0}
      #xtx-bot-panel .xtx-field{display:grid;gap:4px}
      #xtx-bot-panel .xtx-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      #xtx-bot-panel .xtx-row-single{grid-template-columns:1fr}
      #xtx-bot-panel label{font-size:11px;color:#94A3B8;letter-spacing:.3px}
      #xtx-bot-panel input,#xtx-bot-panel select{width:100%;padding:7px 9px;border-radius:8px;
        border:1px solid #334155;background:#1E293B;color:#F8FAFC;font:12px/1.5 inherit;
        transition:border-color .16s ease,box-shadow .16s ease}
      #xtx-bot-panel input::placeholder{color:#64748B}
      #xtx-bot-panel input:focus,#xtx-bot-panel select:focus{outline:none;
        border-color:#22C55E;box-shadow:0 0 0 3px rgba(34,197,94,.16)}
      #xtx-bot-panel .xtx-cta{width:100%;height:40px;display:flex;align-items:center;
        justify-content:center;gap:8px;border:0;border-radius:9px;cursor:pointer;
        background:#22C55E;color:#05240f;font:600 13px/1 inherit;
        transition:background .18s ease,transform .12s ease,box-shadow .18s ease}
      #xtx-bot-panel .xtx-cta:hover{box-shadow:0 0 0 3px rgba(34,197,94,.18)}
      #xtx-bot-panel .xtx-cta:active{transform:translateY(1px)}
      #xtx-bot-panel .xtx-cta:focus-visible{outline:2px solid #F8FAFC;outline-offset:2px}
      #xtx-bot-panel.is-running .xtx-cta{background:#EF4444;color:#fff;
        box-shadow:0 0 0 0 rgba(239,68,68,.5);animation:xtx-glow 1.6s ease-out infinite}
      #xtx-bot-panel .xtx-cta-ico{display:grid;place-items:center}
      #xtx-bot-panel.is-running .xtx-cta-ico{animation:xtx-pulse 1.4s ease-in-out infinite}
      #xtx-bot-panel .xtx-status{font-size:11px;color:#94A3B8;min-height:16px;
        flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #xtx-bot-panel .xtx-statusrow{display:flex;align-items:center;gap:8px}
      #xtx-bot-panel .xtx-link{flex:none;border:0;background:transparent;color:#94A3B8;
        font:11px/1.4 inherit;cursor:pointer;padding:6px 8px;border-radius:8px;
        min-height:24px;display:inline-flex;align-items:center;
        transition:color .16s ease,background .16s ease}
      #xtx-bot-panel .xtx-link:hover{color:#F8FAFC;background:#1E293B}
      #xtx-bot-panel .xtx-link:focus-visible{outline:2px solid #22C55E;outline-offset:1px}
      #xtx-bot-panel .xtx-link[disabled]{opacity:.5;cursor:default}
      #xtx-bot-panel .xtx-log{height:190px;overflow:auto;background:#0B1220;
        border:1px solid #1E293B;border-radius:8px;padding:8px;white-space:pre-wrap;
        word-break:break-word;font:11px/1.6 ui-monospace,"Cascadia Code",Consolas,monospace;
        color:#CBD5E1}
      /* ---- 版本徽章（标题栏） ---- */
      #xtx-bot-panel .xtx-ver{flex:none;font:500 10px/1 ui-monospace,"Cascadia Code",Consolas,monospace;
        letter-spacing:.3px;color:#94A3B8;background:#0B1220;border:1px solid #1E293B;
        border-radius:6px;padding:4px 8px;transition:color .16s ease,border-color .16s ease}
      #xtx-bot-panel .xtx-ver.has-update{color:#22C55E;border-color:rgba(34,197,94,.45)}
      /* 有新版时：颜色之外再加"圆点 + ↑"两个非颜色线索（颜色不能是唯一区分手段，
         色觉障碍用户和快速扫一眼的用户都要能看出来）。最小化后徽章仍然可见。 */
      #xtx-bot-panel .xtx-ver.has-update::before{content:"";display:inline-block;
        width:5px;height:5px;border-radius:50%;background:#22C55E;margin-right:5px;vertical-align:1px}
      /* ---- 更新横幅 ---- */
      #xtx-bot-panel .xtx-upd{display:flex;align-items:center;gap:8px;padding:8px 12px;
        border-bottom:1px solid #1E293B;background:#131E33}
      #xtx-bot-panel .xtx-upd[hidden]{display:none}
      #xtx-bot-panel.xtx-collapsed .xtx-upd{display:none}
      #xtx-bot-panel .xtx-upd-ico{flex:none;width:24px;height:24px;display:grid;place-items:center;
        border-radius:7px;background:#1E293B;color:#94A3B8}
      #xtx-bot-panel .xtx-upd[data-state=available] .xtx-upd-ico{color:#22C55E;background:rgba(34,197,94,.12)}
      #xtx-bot-panel .xtx-upd[data-state=latest] .xtx-upd-ico{color:#22C55E;background:rgba(34,197,94,.12)}
      #xtx-bot-panel .xtx-upd[data-state=error] .xtx-upd-ico{color:#EF4444;background:rgba(239,68,68,.12)}
      #xtx-bot-panel .xtx-upd[data-state=older] .xtx-upd-ico{color:#F59E0B;background:rgba(245,158,11,.12)}
      #xtx-bot-panel .xtx-upd[data-state=checking] .xtx-upd-ico{color:#94A3B8;background:#1E293B}
      /* 真的转起来（prefers-reduced-motion 下面会被全局 animation:none 关掉） */
      #xtx-bot-panel .xtx-upd[data-state=checking] .xtx-upd-ico svg{animation:xtx-spin 1s linear infinite}
      #xtx-bot-panel .xtx-upd-txt{flex:1;min-width:0;display:grid;gap:2px}
      #xtx-bot-panel .xtx-upd-title{font-size:11.5px;font-weight:600;color:#F8FAFC;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #xtx-bot-panel .xtx-upd-sub{font-size:10.5px;line-height:1.45;color:#94A3B8;
        display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
      #xtx-bot-panel .xtx-upd-btn{flex:none;height:28px;padding:0 12px;border:0;border-radius:8px;
        cursor:pointer;background:#22C55E;color:#05240f;font:600 11px/1 inherit;
        transition:background .16s ease,box-shadow .16s ease,transform .12s ease}
      #xtx-bot-panel .xtx-upd-btn:hover{box-shadow:0 0 0 3px rgba(34,197,94,.18)}
      #xtx-bot-panel .xtx-upd-btn:active{transform:translateY(1px)}
      #xtx-bot-panel .xtx-upd-btn:focus-visible{outline:2px solid #F8FAFC;outline-offset:2px}
      #xtx-bot-panel .xtx-upd-btn[hidden]{display:none}
      #xtx-bot-panel .xtx-upd-btn.ghost{background:transparent;color:#94A3B8;border:1px solid #334155}
      #xtx-bot-panel .xtx-upd-btn.ghost:hover{color:#F8FAFC;border-color:#475569;box-shadow:none}
      /* ---- 手动更新指引 ---- */
      #xtx-bot-panel .xtx-guide{display:grid;gap:8px;padding:12px;border-bottom:1px solid #1E293B;
        background:#0B1220}
      #xtx-bot-panel .xtx-guide[hidden]{display:none}
      #xtx-bot-panel.xtx-collapsed .xtx-guide{display:none}
      #xtx-bot-panel .xtx-guide ol{margin:0;padding-left:16px;font-size:10.5px;line-height:1.7;color:#94A3B8}
      #xtx-bot-panel .xtx-guide ol b{color:#F8FAFC;font-weight:600}
      #xtx-bot-panel .xtx-guide code{font:10.5px/1.4 ui-monospace,"Cascadia Code",Consolas,monospace;
        color:#22C55E;background:rgba(34,197,94,.1);border-radius:4px;padding:1px 4px}
      #xtx-bot-panel .xtx-guide-act{display:flex;gap:8px}
      @keyframes xtx-blink{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(34,197,94,.55)}
        50%{opacity:.55;box-shadow:0 0 0 5px rgba(34,197,94,0)}}
      @keyframes xtx-glow{0%{box-shadow:0 0 0 0 rgba(239,68,68,.45)}
        70%{box-shadow:0 0 0 9px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
      @keyframes xtx-pulse{0%,100%{transform:scale(1)}50%{transform:scale(.8)}}
      @keyframes xtx-spin{to{transform:rotate(360deg)}}
      @media (prefers-reduced-motion:reduce){
        #xtx-bot-panel,#xtx-bot-panel *{animation:none!important;transition:none!important}}
    </style>

    <header class="xtx-hd" id="xtx-hd">
      <span class="xtx-brand">
        <span class="xtx-led"></span>
        <span class="xtx-title">学堂在线自动刷课 / 做题</span>
      </span>
      <span class="xtx-ver" id="xtx-ver" title="脚本版本">v—</span>
      <button class="xtx-icon" id="xtx-minimize" type="button" title="最小化" aria-label="最小化面板">${ICON_MIN}</button>
    </header>

    <div class="xtx-upd" id="xtx-upd" data-state="idle" role="status" aria-live="polite" hidden>
      <span class="xtx-upd-ico" id="xtx-upd-ico"></span>
      <div class="xtx-upd-txt">
        <div class="xtx-upd-title" id="xtx-upd-title"></div>
        <div class="xtx-upd-sub" id="xtx-upd-sub"></div>
      </div>
      <button class="xtx-upd-btn" id="xtx-upd-btn" type="button" hidden></button>
    </div>

    <div class="xtx-guide" id="xtx-guide" hidden>
      <ol>
        <li>油猴只会接管 <code>.user.js</code> 结尾的链接。把 GitHub 上的文件改名为
          <code>学堂在线刷课AI做题.user.js</code>（内容不用动），以后点「更新」就能一键装好。</li>
        <li>或者：复制下面的新版本全文 → 打开油猴面板 → 编辑这个脚本 → 全选替换 → 保存。</li>
      </ol>
      <div class="xtx-guide-act">
        <button class="xtx-upd-btn ghost" id="xtx-guide-copy" type="button">复制新版本全文</button>
        <button class="xtx-upd-btn ghost" id="xtx-guide-repo" type="button">去 GitHub 改名</button>
      </div>
    </div>

    <div class="xtx-body">
      <div class="xtx-field">
        <label for="xtx-url">AI 接口地址</label>
        <input id="xtx-url" spellcheck="false" placeholder="https://api.deepseek.com/v1/chat/completions">
      </div>
      <div class="xtx-field">
        <label for="xtx-key">AI Key</label>
        <input id="xtx-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-...">
      </div>
      <div class="xtx-field">
        <label for="xtx-model">模型</label>
        <input id="xtx-model" spellcheck="false" placeholder="deepseek-chat">
      </div>
      <div class="xtx-row xtx-row-single">
        <div class="xtx-field">
          <label for="xtx-mode">模式</label>
          <select id="xtx-mode">
            <option value="both">刷课 + 做题</option>
            <option value="video">只刷课</option>
            <option value="exercise">只做题</option>
          </select>
        </div>
      </div>
      <div class="xtx-row">
        <div class="xtx-field">
          <label for="xtx-rate">倍速</label>
          <input id="xtx-rate" type="number" step="0.25" min="0.5" max="4" placeholder="1">
        </div>
        <div class="xtx-field">
          <label for="xtx-abort">AI 出错时</label>
          <select id="xtx-abort">
            <option value="1">中止报错</option>
            <option value="0">跳过继续</option>
          </select>
        </div>
      </div>
      <button class="xtx-cta" id="xtx-cta" type="button">
        <span class="xtx-cta-ico">${ICON_PLAY}</span><span id="xtx-cta-label">开始</span>
      </button>
      <div class="xtx-statusrow">
        <div class="xtx-status" id="xtx-status">未开始</div>
        <button class="xtx-link" id="xtx-selftest" type="button" title="发一条最小请求，检查接口地址和 Key 是否可用">检测接口</button>
        <button class="xtx-link" id="xtx-updcheck" type="button" title="检查 GitHub 上有没有新版本">检查更新</button>
      </div>
      <div class="xtx-log" id="xtx-bot-log"></div>
    </div>`;
  document.body.appendChild(panel);

  logBox = panel.querySelector("#xtx-bot-log");
  statusEl = panel.querySelector("#xtx-status");
  ctaBtn = panel.querySelector("#xtx-cta");

  // 单一主操作：开始 ↔ 停止
  ctaBtn.addEventListener("click", () => {
    if (state.running) {
      state.stopped = true;
      state.token++;                 // 让正在跑的循环立刻失效
      state.running = false;
      setRunningUI(false);
      log("⏹ 已停止");
    } else {
      readPanel();
      start();
    }
  });

  // 最小化（面板不可关闭，最小化后只剩标题栏）
  panel.querySelector("#xtx-minimize").addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("xtx-collapsed");
  });

  // 接口自检：发一条最小请求，确认地址和 Key 可用
  panel.querySelector("#xtx-selftest").addEventListener("click", (e) => {
    e.stopPropagation();
    aiSelfTest();
  });

  // 手动检查更新（忽略缓存，强制去 GitHub 问一次）
  panel.querySelector("#xtx-updcheck").addEventListener("click", (e) => {
    e.stopPropagation();
    checkForUpdate(true).catch(() => {});
  });

  // 手动更新指引：复制新版本全文 / 去 GitHub 改名
  panel.querySelector("#xtx-guide-copy").addEventListener("click", (e) => {
    e.stopPropagation();
    copyToClipboard(updateFullText).then((ok) => {
      log(ok ? "已复制新版本全文，去油猴面板里粘贴保存"
              : "复制失败，请手动打开脚本地址复制全文");
      if (ok) setStatus("新版本全文已复制");
    });
  });
  panel.querySelector("#xtx-guide-repo").addEventListener("click", (e) => {
    e.stopPropagation();
    openInNewTab(UPDATE.repoUrl);
  });

  // 设置改动即保存（模型名等都会被记住）
  panel.querySelectorAll("#xtx-bot-panel input, #xtx-bot-panel select").forEach((el) => {
    el.addEventListener("change", () => saveSettings(readPanel()));
    el.addEventListener("blur", () => saveSettings(readPanel()));
  });

  bindDrag(panel);
  syncPanel(loadSettings());
}

/** 运行中/空闲的按钮与指示灯状态 */
function setRunningUI(running) {
  if (!panel) return;
  panel.classList.toggle("is-running", !!running);
  const label = panel.querySelector("#xtx-cta-label");
  const ico = panel.querySelector(".xtx-cta-ico");
  if (label) label.textContent = running ? "停止" : "开始";
  if (ico) ico.innerHTML = running ? ICON_STOP : ICON_PLAY;
  ctaBtn.setAttribute("aria-label", running ? "停止脚本" : "开始脚本");
}

function syncPanel(s) {
  if (!panel) return;
  panel.querySelector("#xtx-url").value = s.AI_API_URL;
  panel.querySelector("#xtx-key").value = s.AI_API_KEY;
  panel.querySelector("#xtx-model").value = s.AI_MODEL;
  panel.querySelector("#xtx-mode").value = s.MODE;
  panel.querySelector("#xtx-rate").value = s.PLAYBACK_RATE;
  panel.querySelector("#xtx-abort").value = s.ABORT_ON_AI_ERROR ? "1" : "0";
}
function readPanel() {
  const s = loadSettings();
  s.AI_API_URL = normalizeAiUrl(panel.querySelector("#xtx-url").value.trim() || s.AI_API_URL);
  s.AI_API_KEY = panel.querySelector("#xtx-key").value.trim() || s.AI_API_KEY;
  s.AI_MODEL = panel.querySelector("#xtx-model").value.trim() || s.AI_MODEL;
  s.MODE = panel.querySelector("#xtx-mode").value;
  s.PLAYBACK_RATE = Number(panel.querySelector("#xtx-rate").value) || 1;
  s.ABORT_ON_AI_ERROR = panel.querySelector("#xtx-abort").value === "1";
  saveSettings(s);
  syncPanel(s);
  return s;
}

/** 面板里的「检测接口」：发一条最小请求，确认地址和 Key 可用 */
async function aiSelfTest() {
  const btn = panel ? panel.querySelector("#xtx-selftest") : null;
  const s = panel ? readPanel() : loadSettings();
  if (btn) { btn.disabled = true; btn.textContent = "检测中…"; }
  setStatus("正在检测接口…");
  log("🔌 检测接口：" + (s.AI_API_URL || "(没填地址)"));
  try {
    if (!s.AI_API_URL || !s.AI_API_KEY) {
      log("   !! 没填 AI 接口地址或 Key");
      setStatus("没填地址或 Key");
      return;
    }
    const body = {
      model: s.AI_MODEL,
      messages: [{ role: "user", content: "只回复一个数字：1" }],
      temperature: 0,
      max_tokens: 8,
    };
    const r = await gmRequest("POST", s.AI_API_URL,
      { "Content-Type": "application/json", "Authorization": "Bearer " + s.AI_API_KEY },
      JSON.stringify(body));
    const raw = String(r.responseText || "");
    if (/^\s*</.test(raw)) {
      log("   ✘ 返回的是网页不是 JSON —— " + describeAiError(r.status, raw));
      log("      接口地址要填完整路径，例如 .../v1/chat/completions");
      setStatus("接口自检失败：地址写错了");
      return;
    }
    if (r.status !== 200) {
      log("   ✘ " + describeAiError(r.status, raw));
      setStatus("接口自检失败（HTTP " + r.status + "）");
      return;
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* ignore */ }
    const c = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : "";
    log("   ✔ 接口正常，模型返回：" + String(c).slice(0, 40));
    setStatus("接口正常 ✔");
  } catch (e) {
    log("   ✘ 请求异常：" + (e && e.message ? e.message : e));
    setStatus("接口自检异常");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "检测接口"; }
  }
}

function bindDrag(el) {
  const hd = el.querySelector(".xtx-hd") || el.querySelector(".hd");
  if (!hd) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  hd.addEventListener("mousedown", (e) => {
    if (e.target.closest && e.target.closest("#xtx-minimize")) return;
    drag = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx)) + "px";
    el.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy)) + "px";
    el.style.right = "auto"; el.style.bottom = "auto";
  });
  document.addEventListener("mouseup", () => { drag = false; });
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${msg}`;
  console.log("[xtx-bot] " + line);
  if (!logBox) return;
  logBox.textContent += line + "\n";
  logBox.scrollTop = logBox.scrollHeight;
}
function setStatus(t) { if (statusEl) statusEl.textContent = t; }

/* ---- 更新横幅的渲染（更新逻辑在第八节，这里只管显示） ---- */

/** 设置横幅内容。btnLabel 为空则不显示按钮；onClick 为空则按钮只显示不可用。 */
function setUpdateBanner(state, title, sub, btnLabel, onClick) {
  if (!panel) return;
  const box = panel.querySelector("#xtx-upd");
  if (!box) return;
  const ico = panel.querySelector("#xtx-upd-ico");
  const ttl = panel.querySelector("#xtx-upd-title");
  const sb = panel.querySelector("#xtx-upd-sub");
  const btn = panel.querySelector("#xtx-upd-btn");
  box.dataset.state = state;
  if (ico) {
    ico.innerHTML = state === "checking" ? ICON_UPD_SPIN
      : state === "available" ? ICON_UPD_DOWNLOAD
      : state === "error" ? ICON_UPD_ERROR
      : state === "older" ? ICON_UPD_INFO : ICON_UPD_OK;
  }
  if (ttl) ttl.textContent = title || "";
  if (sb) sb.textContent = sub || "";
  if (btn) {
    if (btnLabel) {
      btn.hidden = false;
      btn.textContent = btnLabel;
      btn.classList.toggle("ghost", state !== "available");
      btn.disabled = !onClick;
      btn.onclick = onClick ? (e) => { e.stopPropagation(); onClick(e); } : null;
    } else {
      btn.hidden = true;
      btn.onclick = null;
    }
  }
  box.hidden = false;
}

/** 隐藏横幅 */
function hideUpdateBanner() {
  if (!panel) return;
  const box = panel.querySelector("#xtx-upd");
  if (box) box.hidden = true;
  const guide = panel.querySelector("#xtx-guide");
  if (guide) guide.hidden = true;
}

/** 把一次检查结果画到面板上。
 *  manual=true 是用户手动点的 → 显示"正在检查…"；自动检查时不显示，避免闪一下。 */
function renderUpdate(res, manual) {
  const r = res || { state: "idle" };
  // checking 状态不要把上一次的 url 弄丢：否则用户在检查过程中点「更新」会没反应
  updateInfo = (r.state === "checking" && updateInfo && updateInfo.url)
    ? Object.assign({}, updateInfo, { state: "checking", local: r.local })
    : r;
  if (!panel) return;
  const ver = panel.querySelector("#xtx-ver");
  if (ver) {
    // 有新版时徽章除了变色，还加一个 "↑"（颜色不能是唯一区分手段）
    ver.textContent = "v" + (r.local ? r.local : "—") + (r.state === "available" ? " ↑" : "");
    ver.classList.toggle("has-update", r.state === "available");
    ver.title = r.state === "available"
      ? `有新版 v${r.remote}（当前 v${r.local}），点面板里的「更新」`
      : (r.remote ? `本地 v${r.local} / 远程 v${r.remote}` : "脚本版本");
  }
  const guide = panel.querySelector("#xtx-guide");
  // 每次重画都先把手动指引收起来：它只在 performUpdate() 里按需重新打开，
  // 否则状态一变（比如用户把文件改名了），旧的"需要手动更新"文案会残留
  if (guide) guide.hidden = true;

  const st = r.state;
  if (st === "checking") {
    if (manual) setUpdateBanner("checking", "正在检查更新…", UPDATE.url, "", null);
    return;
  }
  if (st === "available") {
    setUpdateBanner("available", `发现新版本 v${r.remote}`,
      `当前 v${r.local} · 点「更新」交给油猴安装`, "更新", () => { performUpdate(); });
    if (manual) log(`发现新版本 v${r.remote}（当前 v${r.local}）`);
    return;
  }
  if (st === "older") {
    setUpdateBanner("older", `远程 v${r.remote} 比本地旧`,
      `本地 v${r.local}，已忽略`, "", null);
    return;
  }
  if (st === "latest") {
    // 手动检查必须有反馈：否则用户点了「检查更新」什么也看不到，以为没反应
    if (manual) {
      setUpdateBanner("latest", "已经是最新版本", `本地 v${r.local}`, "", null);
      log(`已经是最新版本（v${r.local}）`);
      clearTimeout(latestBannerTimer);
      latestBannerTimer = setTimeout(() => {
        if (updateInfo && updateInfo.state === "latest") hideUpdateBanner();
      }, 5000);
    } else {
      hideUpdateBanner();
    }
    return;
  }
  if (st === "error") {
    setUpdateBanner("error", "检查更新失败",
      r.reason || "网络不通", "重试", () => { checkForUpdate(true).catch(() => {}); });
    return;
  }
  hideUpdateBanner();
}

/* =========================================================================
 * 四、网络记录器
 *    目的：抓两样东西
 *      1) 作业接口地址 /api/v1/lms/exercise/get_exercise_list/{exercise_id}/{sku_id}/
 *         （exercise_id 只能从这里拿到，别的接口不给）
 *      2) 站点自己发请求时用的请求头（含 CSRF），提交时直接复用
 * ========================================================================= */
const NET = { exerciseUrl: null, headers: {}, exerciseHits: {}, exerciseSeq: 0 };

function headersToObject(h) {
  const out = {};
  try {
    if (!h) return out;
    if (typeof h.forEach === "function" && typeof h.get === "function") {
      h.forEach((v, k) => { out[k] = v; });   // Headers
    } else if (Array.isArray(h)) {
      h.forEach(([k, v]) => { out[k] = v; });
    } else {
      Object.assign(out, h);
    }
  } catch (e) { /* ignore */ }
  return out;
}

function installNetRecorder() {
  if (window.__xtxNetRecorder) return;
  window.__xtxNetRecorder = true;

  const XHR = window.XMLHttpRequest;
  const oOpen = XHR.prototype.open, oSend = XHR.prototype.send, oSetH = XHR.prototype.setRequestHeader;
  XHR.prototype.open = function (m, u) {
    this.__m = m; this.__u = String(u); this.__h = {};
    return oOpen.apply(this, arguments);
  };
  XHR.prototype.setRequestHeader = function (k, v) {
    this.__h[k] = v;
    return oSetH.apply(this, arguments);
  };
  XHR.prototype.send = function (b) {
    try {
      if (this.__u && this.__u.indexOf("/api/") >= 0) {
        if (this.__u.indexOf("/exercise/get_exercise_list/") >= 0) {
          NET.exerciseUrl = this.__u;
          NET.exerciseSeq++;
          const url = this.__u, self = this;
          // 把站点自己返回的题目列表也留下来（按题干就能认出是不是本页这份）
          try {
            self.addEventListener("load", function () {
              try {
                const t = self.responseText;
                if (!t) return;
                const j = JSON.parse(t);
                if (j && j.success && j.data) {
                  NET.exerciseHits[url] = { url: url, data: j.data, ts: Date.now() };
                }
              } catch (e) { /* ignore */ }
            });
          } catch (e) { /* ignore */ }
        }
        const hs = headersToObject(this.__h);
        if (Object.keys(hs).length) NET.headers = Object.assign({}, NET.headers, hs);
      }
    } catch (e) { /* ignore */ }
    return oSend.apply(this, arguments);
  };

  const of = window.fetch;
  window.fetch = function (input, init) {
    const u = (typeof input === "string" ? input : (input && input.url)) || "";
    const p = of.apply(this, arguments);
    try {
      if (u.indexOf("/exercise/get_exercise_list/") >= 0) {
        NET.exerciseUrl = u;
        NET.exerciseSeq++;
        const url = u;
        try {
          p.then((res) => {
            try {
              res.clone().text().then((t) => {
                try {
                  const j = JSON.parse(t);
                  if (j && j.success && j.data) {
                    NET.exerciseHits[url] = { url: url, data: j.data, ts: Date.now() };
                  }
                } catch (e) { /* ignore */ }
              }).catch(() => {});
            } catch (e) { /* ignore */ }
          }).catch(() => {});
        } catch (e) { /* ignore */ }
      }
      const hs = headersToObject(init && init.headers);
      if (Object.keys(hs).length) NET.headers = Object.assign({}, NET.headers, hs);
    } catch (e) { /* ignore */ }
    return p;
  };
}

/** 演练模式：把提交请求拦下来，不真的交卷 */
function installDryRunGuard() {
  if (window.__xtxDryGuard) return;
  window.__xtxDryGuard = true;
  const MARK = "/exercise/problem_apply/";

  const of = window.fetch;
  window.fetch = function (input, init) {
    const u = (typeof input === "string" ? input : (input && input.url)) || "";
    if (u.indexOf(MARK) >= 0) {
      console.log("[xtx-bot] 演练模式：拦截提交(fetch)", u);
      return Promise.resolve(new Response(
        JSON.stringify({ msg: "", data: {}, success: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return of.apply(this, arguments);
  };

  const XHR = window.XMLHttpRequest;
  const oOpen = XHR.prototype.open, oSend = XHR.prototype.send;
  XHR.prototype.open = function (m, u) { this.__u = String(u); return oOpen.apply(this, arguments); };
  XHR.prototype.send = function (b) {
    if (this.__u && this.__u.indexOf(MARK) >= 0) {
      console.log("[xtx-bot] 演练模式：拦截提交(xhr)", this.__u, b);
      setTimeout(() => {
        const payload = '{"msg":"","data":{},"success":true}';
        try {
          Object.defineProperty(this, "readyState", { value: 4, configurable: true });
          Object.defineProperty(this, "status", { value: 200, configurable: true });
          Object.defineProperty(this, "responseText", { value: payload, configurable: true });
          Object.defineProperty(this, "response", { value: payload, configurable: true });
        } catch (e) { /* ignore */ }
        try { this.dispatchEvent(new Event("readystatechange")); } catch (e) { /* ignore */ }
        try { this.dispatchEvent(new Event("load")); } catch (e) { /* ignore */ }
      }, 30);
      return;
    }
    return oSend.apply(this, arguments);
  };
}

/* =========================================================================
 * 五、AI 请求
 * ========================================================================= */
function gmRequest(method, url, headers, data) {
  return new Promise((resolve, reject) => {
    const fn = (typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest) ||
               (typeof GM !== "undefined" && GM && GM.xmlHttpRequest);
    if (!fn) { reject(new Error("GM_xmlhttpRequest 不可用")); return; }
    fn({
      method, url, headers, data, timeout: 60000,
      onload: (r) => resolve(r),
      onerror: (e) => reject(new Error("网络错误: " + (e && e.error))),
      ontimeout: () => reject(new Error("请求超时")),
    });
  });
}

/** 把接口的异常响应翻译成人能看懂的提示 */
function describeAiError(status, text) {
  const t = String(text || "");
  if (/^\s*</.test(t) || /text\/html/i.test(t)) {
    return "接口返回的是网页而不是 JSON —— 接口地址写错了。" +
           "要填完整路径，例如 https://api.huanling.icu/v1/chat/completions";
  }
  if (status === 401 || status === 403) return "接口拒绝（HTTP " + status + "）：Key 不对、过期或没有权限";
  if (status === 404) return "接口不存在（HTTP 404）：地址或路径写错了";
  if (status === 429) return "请求太频繁被限流（HTTP 429），稍后再试";
  if (status >= 500) return "服务端错误（HTTP " + status + "）";
  return "HTTP " + status + "：" + t.slice(0, 160);
}

/* 发给 AI 之前的"输出规范"提示词：先把输出格式框死，
 * 这样 AI 第一次就能给规范答案，脚本不用反复纠正。
 * 注意：这段是加在题目【之前】的，AI 一上来就知道该怎么答。 */
const OUTPUT_RULE = {
  single:
    "【输出格式（必须严格遵守）】\n" +
    "只输出正确选项的一个大写字母，例如：A\n" +
    "除这一个字母外，不要输出任何其它内容——不要解释、不要理由、不要标点、不要空行、不要重复题目。\n",
  multiple:
    "【输出格式（必须严格遵守）】\n" +
    "只输出所有正确选项的字母，多个用英文逗号分隔，例如：A,C\n" +
    "除字母和逗号外，不要输出任何其它内容——不要解释、不要理由、不要标点、不要空行、不要重复题目。\n",
  judge:
    "【输出格式（必须严格遵守）】\n" +
    "只输出『正确』或『错误』这两个词中的一个。\n" +
    "除这个词外，不要输出任何其它内容——不要解释、不要理由、不要标点、不要空行、不要重复题目。\n",
};

/** 答案不合规时追加的"纠正提示词"：带上上一轮的原话和判定原因，
 *  要求 AI 只改格式、别改答案（否则纠一次可能把对的答成错的）。 */
function buildCorrectionPrompt(prev, kind) {
  const fmt = kind === "judge" ? "『正确』或『错误』"
             : (kind === "multiple" ? "A,C 这样用英文逗号分隔的字母" : "一个大写字母，例如 A");
  return (
    "\n\n【上一轮的回答】\n" + String(prev.raw || "").slice(0, 300) + "\n\n" +
    "【上一轮的问题】" + (prev.reason || "输出格式不符合要求") + "\n" +
    (prev.cand && prev.cand.length
      ? "我从中识别出的答案是：" + prev.cand.join(",") + "\n"
      : "我从中没能识别出答案。\n") +
    "如果你认为上一轮的答案本身是对的，请**只把格式改对**（" + fmt + "），不要改变你的选择；" +
    "如果你认为上一轮答错了，请重新判断。\n\n" +
    "答案："
  );
}

/** 请求 AI 拿答案。
 *  prev = 上一轮的不合规结果（raw / reason / cand），有它就会追加纠正提示词。
 *  返回 { ok, ans, raw, reason, cand, fatal }
 *    ok    = 答案通过校验
 *    ans   = 解析出的答案（多选是数组，单选是字母，判断是 "true"/"false"）
 *    cand  = 宽松解析出的候选字母（格式不规范时也尽量给出来，供兜底提交用）
 *    fatal = 接口级失败（重试也没用，不浪费次数） */
async function aiAnswer(settings, question, options, kind, prev) {
  if (!settings.AI_API_URL || !settings.AI_API_KEY) {
    log("!! 没填 AI 接口地址或 Key，先在面板里填一下");
    return { ok: false, ans: null, raw: "", reason: "接口没配好", cand: [], fatal: true };
  }
  const isMulti = kind === "multiple";
  const isJudge = kind === "judge";
  const opts = options.map((o) => `${o.letter}. ${o.text}`).join("\n");
  const allow = allowedLetters(options);
  const rule = OUTPUT_RULE[kind] || OUTPUT_RULE.single;

  let prompt, sys;
  if (isJudge) {
    // 判断题：选项是 true/false
    prompt = rule + "\n" +
      "下面是一道判断题。请判断题干的说法是否正确。\n\n" +
      "题目：\n" + question + "\n\n答案：";
    sys = "你是判断题作答助手。只回答『正确』或『错误』，一个字都不能多。";
  } else if (isMulti) {
    prompt = rule + "\n" +
      "下面是一道多项选择题（可能有多个正确选项）。请选出所有正确的选项。\n\n" +
      "题目：\n" + question + "\n\n选项：\n" + opts + "\n\n答案：";
    sys = "你是选择题作答助手。多选题要回答所有正确选项的字母，只输出字母，多个用英文逗号分隔。";
  } else {
    prompt = rule + "\n" +
      "下面是一道单项选择题。请只输出正确选项的一个字母。\n\n" +
      "题目：\n" + question + "\n\n选项：\n" + opts + "\n\n答案：";
    sys = "你是选择题作答助手，只回答一个选项字母。";
  }
  // 上一轮不合规 → 追加纠正提示词
  if (prev && prev.raw) prompt += buildCorrectionPrompt(prev, kind);

  const body = {
    model: settings.AI_MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: prompt },
    ],
    temperature: 0,
  };
  try {
    const r = await gmRequest("POST", settings.AI_API_URL,
      { "Content-Type": "application/json", "Authorization": "Bearer " + settings.AI_API_KEY },
      JSON.stringify(body));
    if (r.status !== 200) {
      log("!! AI 返回 " + r.status + "：" + describeAiError(r.status, r.responseText));
      return { ok: false, ans: null, raw: "", reason: "AI 接口返回 " + r.status, cand: [], fatal: true };
    }
    const raw = String(r.responseText || "");
    if (/^\s*</.test(raw)) {
      log("!! AI 接口返回的是网页不是 JSON：" + describeAiError(r.status, raw));
      log("   检查面板里的『AI 接口地址』是否写全（要带 /chat/completions）");
      return { ok: false, ans: null, raw: "", reason: "接口地址写错了（返回的是网页）", cand: [], fatal: true };
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      log("!! AI 返回的内容不是合法 JSON：" + describeAiError(r.status, raw));
      return { ok: false, ans: null, raw: "", reason: "AI 返回不是合法 JSON", cand: [], fatal: true };
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : "";
    if (!content) {
      log("!! AI 返回里没有内容：" + raw.slice(0, 160));
      return { ok: false, ans: null, raw: "", reason: "AI 没返回内容", cand: [], fatal: true };
    }

    // 解析 + 合法性校验
    let cand, ans;
    if (isJudge) {
      const j = extractJudge(content);
      cand = j ? [j] : [];
      ans = j;
    } else {
      cand = extractLetters(content, allow) || [];
      ans = isMulti ? cand : (cand.length === 1 ? cand[0] : null);
    }
    const v = validateAnswer(content, cand, options, kind);
    return { ok: v.ok, ans: v.ok ? ans : null, raw: content, reason: v.reason, cand: v.cand, fatal: false };
  } catch (e) {
    log("!! AI 请求失败: " + (e && e.message ? e.message : e));
    return { ok: false, ans: null, raw: "", reason: "AI 请求失败", cand: [], fatal: true };
  }
}

/** 本题允许的选项字母（以页面/接口给出的选项为准，支持到 A~Z；取不到就退回 A~D）
 *  这样就不再把字母写死成 A~D，五个选项的题也能正常解析和校验。 */
function allowedLetters(options) {
  const out = [];
  const list = Array.isArray(options) ? options : [];
  for (const o of list) {
    const L = String((o && o.letter) || "").trim().toUpperCase();
    if (/^[A-Z]$/.test(L) && out.indexOf(L) < 0) out.push(L);
  }
  if (!out.length) for (let i = 0; i < 4; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

/** 原文里所有"独立"的大写字母（前后都不是字母）
 *  "答案是 A 和 C" -> ["A","C"]；"Based on analysis" 里的 B 不算（后面还跟着字母） */
function standaloneLetters(content) {
  const s = String(content || "");
  const out = [];
  const re = /(?<![A-Za-z])([A-Z])(?![A-Za-z])/g;
  let m;
  while ((m = re.exec(s)) !== null) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

/** 原文中被明确否定的字母："B 不对" / "B is wrong" / "错误的是 B" -> ["B"] */
function negatedLetters(content) {
  const s = String(content || "");
  const out = [];
  const pats = [
    /([A-Z])\s*(?:不对|不正确|错误|错|不选|排除|去掉|错的)/g,
    /([A-Z])\s+is\s+(?:wrong|incorrect|not\b)/gi,
    /(?:不对|不正确|错误|不选|排除|去掉|wrong|incorrect)\s*[:：,，]?\s*(?:选项|option)?\s*([A-Z])(?![A-Za-z])/gi,
  ];
  for (const p of pats) {
    let m;
    while ((m = p.exec(s)) !== null) {
      const L = m[1].toUpperCase();
      if (out.indexOf(L) < 0) out.push(L);
    }
  }
  return out;
}

/** 只保留允许集合里的字母，且去重、保持顺序 */
function keepAllowed(letters, allow) {
  const out = [];
  for (const x of (letters || [])) {
    const L = String(x).toUpperCase();
    if (allow.indexOf(L) >= 0 && out.indexOf(L) < 0) out.push(L);
  }
  return out;
}

/** 提取多个字母（多选题用；单选也用它拿候选集）：返回 ["A","C"] 这样的数组
 *  allowed = 本题允许的字母集合（默认 A~D）
 *  解析策略按可靠度排序：
 *    ① 整串就是大写字母（"AC" / "A,C" / "A, C"）—— 最常见最可靠
 *    ② JSON（{"answer":"AC"} / {"answer":["A","C"]}）
 *    ③ 原文里所有独立大写字母，减去被明确否定的
 *       （"答案是 A 和 C"、"A、C 正确，B 不对"、"Based on the analysis ... A and C."）
 *    ④ 引导词后的一串字母（允许"和/及/与/and"等连接词）
 *    ⑤ 兜底：全文里的字母 */
function extractLetters(content, allowed) {
  if (!content) return null;
  const s = String(content).trim();
  const allow = (allowed && allowed.length) ? allowed : ["A", "B", "C", "D"];

  // ① 整串就是大写字母（必须全大写，否则 "Correct" 这种词会被误当成答案）
  if (/^[A-Z](?:[,\s]*[A-Z])*$/.test(s)) {
    const arr = keepAllowed(s.match(/[A-Z]/g) || [], allow);
    if (arr.length) return arr;
  }
  // ② JSON 形式 {"answer":"AC"} / {"answer":["A","C"]}
  let m = s.match(/"answer"\s*:\s*\[([^\]]*)\]/i);
  if (m) {
    const arr = keepAllowed(m[1].match(/[A-Za-z]/g) || [], allow);
    if (arr.length) return arr;
  }
  m = s.match(/"answer"\s*:\s*"?([A-Za-z](?:\s*[,、，]?\s*[A-Za-z])*)"?/i);
  if (m) {
    const arr = keepAllowed(m[1].match(/[A-Za-z]/g) || [], allow);
    if (arr.length) return arr;
  }
  // ③ 原文里所有独立大写字母，减去被明确否定的
  const std = standaloneLetters(s);
  const neg = negatedLetters(s);
  const cand = keepAllowed(std.filter((L) => neg.indexOf(L) < 0), allow);
  if (cand.length) return cand;
  // ④ 引导词后的一串字母（允许"和/及/与/and"等连接词）
  m = s.match(/(?:答案|正确选项|选项|选择|answer|选)\s*[:：是]?\s*\(?([A-Za-z](?:\s*[,、，和及与]?\s*[A-Za-z])*)\)?/i);
  if (m) {
    const arr = keepAllowed(m[1].match(/[A-Za-z]/g) || [], allow);
    if (arr.length) return arr;
  }
  // ⑤ 兜底：全文里的字母
  const all = keepAllowed(s.match(/[A-Za-z]/g) || [], allow);
  return all.length ? all : null;
}

/** 校验 AI 的回复：答案必须在本题选项集内，且格式要规范
 *  返回 { ok, reason, cand }
 *  cand = 宽松解析出的候选字母；即使格式不规范也尽量给出来，供最后的兜底提交用 */
function validateAnswer(raw, cand, options, kind) {
  const s = String(raw || "").trim();
  if (kind === "judge") {
    const c = Array.isArray(cand) ? cand : [];
    if (!c.length) return { ok: false, reason: "判断题答案不是『正确』或『错误』", cand: c };
    if (!/^(正确|错误|对|错|是|否|true|false|correct|incorrect|right|wrong)$/i.test(s)) {
      return { ok: false, reason: "输出格式不规范（判断题只能输出『正确』或『错误』）", cand: c };
    }
    return { ok: true, reason: "", cand: c };
  }
  const c = Array.isArray(cand) ? cand : [];
  if (!c.length) return { ok: false, reason: "没有识别出任何选项字母", cand: c };
  const allow = allowedLetters(options);
  for (const L of c) {
    if (allow.indexOf(String(L).toUpperCase()) < 0) {
      return { ok: false, reason: `选项 ${L} 不在本题的选项里（本题只有 ${allow.join("、")}）`, cand: c };
    }
  }
  if (kind === "single" && c.length !== 1) {
    return { ok: false, reason: `这是单选题，但回复里有 ${c.length} 个候选字母（${c.join("、")}）`, cand: c };
  }
  const fmt = kind === "single" ? /^[A-Z]$/.test(s) : /^[A-Z](?:[,\s]*[A-Z])*$/.test(s);
  if (!fmt) {
    return { ok: false, reason: `输出格式不规范（应为 ${kind === "multiple" ? "A,C" : "A"} 这样的纯字母）`, cand: c };
  }
  return { ok: true, reason: "", cand: c };
}

/** 提取判断题答案：返回 "true" / "false" / null */
function extractJudge(content) {
  if (!content) return null;
  const s = String(content).trim();
  // 1) 整串就是答案（true/false/T/F/对/错/正确/错误/是/否/Correct/Incorrect）
  if (/^(true|false|T|F|对|错|正确|错误|是|否|correct|incorrect|right|wrong)$/i.test(s)) {
    return judgeToBool(s);
  }
  // 2) JSON 形式 {"answer":"true"}
  let m = s.match(/"answer"\s*:\s*"?\s*(true|false|对|错|正确|错误|是|否|correct|incorrect)\s*"?/i);
  if (m) return judgeToBool(m[1]);
  // 3) 引导词后跟答案
  m = s.match(/(?:答案|判断|正确|错误|answer)\s*[:：是]?\s*\(?\s*(true|false|对|错|正确|错误|是|否|T|F|correct|incorrect)\s*\)?/i);
  if (m) return judgeToBool(m[1]);
  // 4) 否定/肯定关键词（先看否定，避免"不正确"被当成"正确"）
  if (/incorrect|wrong|false|错误|不正确|不对|假的|不是/.test(s)) return "false";
  if (/correct|true|正确|是的|对的|真的/.test(s)) return "true";
  return null;
}

function judgeToBool(s) {
  const t = String(s).trim();
  if (/^(true|t|对|正确|是|correct|right)$/i.test(t)) return "true";
  if (/^(false|f|错|错误|否|incorrect|wrong)$/i.test(t)) return "false";
  return null;
}

/* =========================================================================
 * 六、页面操作
 * ========================================================================= */
async function waitFor(fn, timeout = 20000, step = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let v = null;
    try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    await sleep(step);
  }
  return null;
}

function dismissPopups() {
  try {
    const wrappers = [...document.querySelectorAll(".el-dialog__wrapper")].filter((w) => {
      const st = getComputedStyle(w);
      return st.display !== "none" && w.getBoundingClientRect().height > 0;
    });
    for (const w of wrappers) {
      const btn = w.querySelector(".d-close, .el-dialog__headerbtn, .el-dialog__close");
      if (btn) btn.click();
    }
    return wrappers.length;
  } catch (e) { return 0; }
}

/** 从侧栏 DOM 读章节列表（各课程结构一致：#unit-item-{id} + .item-type/.item-name/.item-status） */
function getLeaves() {
  return [...document.querySelectorAll('[id^=unit-item-]')].map((e) => {
    const t = e.querySelector(".item-type");
    const n = e.querySelector(".item-name");
    const st = e.querySelector(".item-status");
    const type = t ? t.innerText.trim() : "";
    return {
      id: (e.id || "").replace("unit-item-", ""),
      type: type,
      name: n ? n.innerText.replace(/\s+/g, " ").trim() : "",
      finished: !!(st && st.querySelector(".is-finish")),
      kind: leafKindOf(type) || "",
    };
  }).filter((x) => x.id);
}

/** 侧栏拿不到时的兜底：调站点自己的章节接口（实测所有课程都有这个接口）
 *  GET /api/v1/lms/learn/course/chapter?cid=&sign=
 *  返回 course_chapter -> (section_leaf_list | leaf_list) -> 叶子 */
async function getLeavesFromApi(info) {
  try {
    const r = await fetch(`/api/v1/lms/learn/course/chapter?cid=${info.cid}&sign=${info.sign}`,
      { credentials: "include", headers: apiHeaders() });
    const j = await r.json();
    const cc = (j && j.data && j.data.course_chapter) || [];
    const out = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      // 当前节点自己可能是叶子（有 id + leaf_type）
      if (node.id && node.leaf_type !== undefined && node.leaf_type !== null) {
        const kind = leafKindOf("", node.leaf_type);
        if (kind) {
          out.push({
            id: String(node.id), type: node.name || "", name: (node.name || "").trim(),
            finished: false, kind: kind, leafType: node.leaf_type,
          });
        }
      }
      for (const key of ["section_leaf_list", "leaf_list", "chapter_list", "sections"]) {
        const arr = node[key];
        if (Array.isArray(arr)) for (const c of arr) walk(c);
      }
    };
    for (const ch of cc) walk(ch);
    // 去重
    const seen = new Set();
    return out.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  } catch (e) {
    return [];
  }
}

/** 侧栏/接口里的类型文字 -> URL kind 与脚本内部 kind
 *  实测各课程侧栏 .item-type 取值：视频 / 作业 / 考试 / 讨论 */
const LEAF_KIND_MAP = {
  "视频": "video",
  "作业": "exercise",
  "考试": "exam",
  "讨论": "discussion",
};

/** 接口 course/chapter 的 leaf_type 数字码 -> 内部 kind（实测：0=视频 6=作业 4=讨论 5=考试） */
const LEAF_TYPE_NUM = {
  0: "video", 4: "discussion", 5: "exam", 6: "exercise",
};

function leafKindOf(typeText, leafTypeNum) {
  if (typeText && LEAF_KIND_MAP[typeText]) return LEAF_KIND_MAP[typeText];
  if (leafTypeNum !== undefined && leafTypeNum !== null && LEAF_TYPE_NUM[leafTypeNum]) {
    return LEAF_TYPE_NUM[leafTypeNum];
  }
  return null;
}

function leafUrl(info, leaf) {
  const kind = leaf.kind || "video";
  // 用当前页面学到的前缀形态（新版带 space / 旧版不带），避免跳到不存在的 URL
  const prefix = /\/learn\/space\//.test(location.pathname) ? "space/" : "";
  return `${location.origin}/learn/${prefix}${info.sign}/${info.sign}/${info.cid}/${kind}/${leaf.id}`;
}

let lastSchedule = null, lastScheduleAt = 0;
async function refreshSchedule(info, force) {
  const now = Date.now();
  if (!force && lastSchedule && now - lastScheduleAt < 20000) return lastSchedule;
  try {
    const r = await fetch(`/api/v1/lms/learn/course/schedule?cid=${info.cid}&sign=${info.sign}`,
      { credentials: "include", headers: apiHeaders() });
    const j = await r.json();
    lastSchedule = (j && j.data && j.data.leaf_schedules) || {};
    lastScheduleAt = now;
  } catch (e) { /* ignore */ }
  return lastSchedule || {};
}

async function isFinished(info, leafId, force) {
  const el = document.querySelector("#unit-item-" + leafId);
  if (el && el.querySelector(".item-status .is-finish")) return true;
  const sched = await refreshSchedule(info, force);
  const v = sched[String(leafId)];
  return v !== undefined && v !== null && Number(v) >= 1;
}

/** 切到某个章节：优先点侧栏（不刷新页面），失败再整页跳转 */
async function gotoLeaf(info, leaf) {
  if (location.pathname.endsWith("/" + leaf.id)) return true;
  const item = document.querySelector("#unit-item-" + leaf.id);
  if (item) {
    item.scrollIntoView({ block: "center" });
    item.click();
    const ok = await waitFor(() => location.pathname.endsWith("/" + leaf.id), 12000, 250);
    if (ok) { await sleep(500); return true; }
  }
  gmSet(RUN_KEY, { sign: info.sign, cid: info.cid, leafId: leaf.id, ts: Date.now() });
  location.href = leafUrl(info, leaf);
  return false;
}

/* ------------------------------ 刷视频 ------------------------------ */
/** 取播放器真正在用的那个 video（页面上可能存在多个 video 元素） */
function getVideo() {
  const inPlayer = document.querySelector(".xt_video_player_container video, .xt_video_player");
  if (inPlayer) return inPlayer;
  const vs = [...document.querySelectorAll("video")].filter((v) => v.getClientRects().length > 0);
  return vs[0] || document.querySelector("video");
}

/** HTMLMediaElement 的原生 muted / volume 存取器（用于真正改到媒体内部状态） */
const MEDIA_DESC = {
  muted: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted"),
  volume: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume"),
};

/** 读 video 内部真实的静音状态（绕开我们自己装的 getter） */
function realMuted(v) {
  try { return MEDIA_DESC.muted.get.call(v); } catch (e) { return v.muted; }
}
function realVolume(v) {
  try { return MEDIA_DESC.volume.get.call(v); } catch (e) { return v.volume; }
}

/** 自动静音：播放器会周期性把自己的音量状态同步回 video，
 *  单纯赋值会被改回去，所以把 muted / volume 属性锁死。
 *  关键：setter 必须转发给原生 setter，否则媒体内部状态根本没被置静音，播放器照样出声。
 *  每次检测进度时都会调用。 */
function muteVideo(v) {
  try {
    if (!v.__xtxMuted) {
      Object.defineProperty(v, "muted", {
        configurable: true, enumerable: true,
        get() { return true; },
        set() { try { MEDIA_DESC.muted.set.call(this, true); } catch (e) { /* ignore */ } },
      });
      Object.defineProperty(v, "volume", {
        configurable: true, enumerable: true,
        get() { return 0; },
        set() { try { MEDIA_DESC.volume.set.call(this, 0); } catch (e) { /* ignore */ } },
      });
      v.__xtxMuted = true;
    }
    v.muted = true;      // 走我们的 setter → 转发到原生 → 内部真的静音
    v.volume = 0;
  } catch (e) {
    try { v.muted = true; v.volume = 0; } catch (x) { /* ignore */ }
  }
}

/** 每次检测进度都检查静音状态：发现没静音就立刻重新禁音。
 *  返回 true = 本来就是静音；false = 刚才不是静音、已重新禁上。 */
function ensureMuted(v) {
  if (!v) return true;
  const wasMuted = (realMuted(v) === true) && (Number(realVolume(v)) === 0);
  if (!wasMuted) muteVideo(v);
  return wasMuted;
}

/** 视频被暂停了 → 恢复播放。
 *  播放器的按钮是自定义元素（xt-bigbutton / xt-playbutton），脚本合成的点击对它无效，
 *  所以主力是 video.play()（静音后浏览器允许脚本直接续播），点按钮只作兜底。 */
async function resumePlayback(vid) {
  if (!vid) return false;
  if (!vid.paused) return true;

  // ① 直接续播
  try {
    const pr = vid.play();
    if (pr && typeof pr.catch === "function") pr.catch(() => {});
  } catch (e) { /* ignore */ }
  await sleep(700);
  if (!vid.paused) { muteVideo(vid); return true; }

  // ② 兜底：点播放器的大播放按钮（自定义元素，可能只认真实鼠标事件序列）
  const b = document.querySelector(".xt_video_bit_play_btn");
  if (b) {
    try { b.click(); } catch (e) { /* ignore */ }
    try {
      ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => {
        b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      });
    } catch (e) { /* ignore */ }
    await sleep(1200);
  }
  muteVideo(vid);
  return !vid.paused;
}

async function playVideo(settings, info, leaf) {
  log(`▶ 播放视频：${leaf.name} (${leaf.id})`);
  const v = await waitFor(getVideo, 30000);
  if (!v) { log("   !! 没找到 video 元素"); return false; }
  dismissPopups();
  muteVideo(v);
  log(`   🔇 已静音（内部状态 muted=${realMuted(v)} volume=${realVolume(v)}）`);
  if (settings.PLAYBACK_RATE && settings.PLAYBACK_RATE !== 1) {
    try { v.playbackRate = settings.PLAYBACK_RATE; } catch (e) { /* ignore */ }
  }
  let stall = 0, lastCt = -1;
  while (!state.stopped) {
    const vid = getVideo();
    if (!vid) { log("   !! video 消失，退出本章"); break; }
    muteVideo(vid);                       // 每次检测进度都重新静音
    if (!ensureMuted(vid)) log("   🔈 检测到未静音，已重新禁音");
    await waitCaptchaDone();              // 有验证码就先等它处理完
    const cur = pageInfo();
    if (cur && cur.leafId !== leaf.id) { log("   → 页面已被切走，停止当前视频"); break; }
    if (vid.ended) { log("   ✔ 播放完毕：" + leaf.name); break; }
    if (await isFinished(info, leaf.id)) { log("   ✔ 平台已标记完成：" + leaf.name); break; }

    // 暂停 → 立刻恢复播放
    if (vid.paused) {
      log("   ⏸ 检测到视频暂停，正在恢复播放…");
      const ok = await resumePlayback(vid);
      if (!ok) log("   !! 暂时没能恢复播放，继续盯着");
      await sleep(800);
    }

    const ct = vid.currentTime || 0;
    if (lastCt >= 0 && ct - lastCt < 0.3) {
      stall++;
      // 进度不动：可能是"暂停"但状态没同步，再试着恢复一次
      if (stall === 2 || stall === 4) {
        const bigBtn = document.querySelector(".xt_video_bit_play_btn");
        if (bigBtn) {
          log("   ! 进度没有推进，尝试恢复播放…");
          await resumePlayback(vid);
          await sleep(800);
        }
      }
      if (stall >= 6) { log("   !! 播放停滞，刷新本章"); location.reload(); stall = 0; }
    } else { stall = 0; }
    lastCt = vid.currentTime || 0;
    const dur = vid.duration || 0;
    log(`   ${vid.paused ? "⏸ 已暂停" : "播放中"} ${fmt(ct)} / ${fmt(dur)}` + (dur ? ` (${(ct / dur * 100).toFixed(1)}%)` : ""));
    await sleep(settings.POLL_MS);
  }
  for (let i = 0; i < 12; i++) {
    if (await isFinished(info, leaf.id, true)) { log("   ✔ 进度已记录"); return true; }
    await sleep(2000);
  }
  log("   ! 平台暂未标记完成（可能被判定为快进/无效播放）");
  return false;
}

function fmt(sec) {
  sec = Number(sec) || 0;
  if (!isFinite(sec) || sec <= 0) return "--:--";
  return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
}

/* ------------------------------ 做题 ------------------------------ */
function stripHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function readQuestion() {
  const q = document.querySelector(".leftQuestion .fuwenben");
  if (!q) return null;
  const titleEl = document.querySelector(".question p.title");
  const opts = [...document.querySelectorAll(".leftQuestion p.leftradio")].map((p) => {
    const l = p.querySelector(".radio_xtb");
    const body = p.querySelector("div");
    return {
      letter: l ? l.innerText.trim() : "",
      text: body ? body.innerText.replace(/\s+/g, " ").trim() : p.innerText.replace(/\s+/g, " ").trim(),
    };
  });
  const cur = document.querySelector(".tabbar .curent");
  const total = document.querySelector(".tabbar .total");
  const prog = document.querySelector(".tabbar .defen_xtb");
  const sel = document.querySelector(".answerList .radio_xtb.active, .answerList .radio_xtb.selected");
  const titleTxt = titleEl ? titleEl.innerText.replace(/\s+/g, " ").trim() : "";
  return {
    question: q.innerText.replace(/\s+/g, " ").trim(),
    title: titleTxt,
    // 题型：单选 / 多选 / 判断（判断题在题目区没有选项，选项在作答区）
    kind: /判断/.test(titleTxt) ? "judge"
          : (/多选/.test(titleTxt) ? "multiple" : "single"),
    options: opts,
    index: cur ? parseInt(cur.innerText, 10) || 0 : 0,
    total: total ? parseInt((total.innerText.match(/\d+/) || ["0"])[0], 10) : 0,
    progress: prog ? prog.innerText.replace(/\s+/g, " ").trim() : "",
    selected: sel ? sel.innerText.trim() : "",
  };
}

/** 点击一个选项（单选/多选通用）。多选时逐个点即可，平台会累加高亮。 */
function clickOption(letter) {
  const items = [...document.querySelectorAll(".leftQuestion p.leftradio")];
  const hit = items.find((p) => {
    const s = p.querySelector(".radio_xtb");
    return s && s.innerText.trim().toUpperCase() === letter.toUpperCase();
  });
  if (!hit) return false;
  hit.click();
  return true;
}

/** 点击多个选项（多选题）。返回实际点上的字母。 */
function clickOptions(letters) {
  const hit = [];
  for (const L of letters) {
    if (clickOption(L)) hit.push(L);
  }
  return hit;
}

/** 判断题：选项在作答区（两个 radio_xtb，第一个 true、第二个 false） */
function clickJudge(value) {
  const marks = [...document.querySelectorAll(".answerList .radio_xtb")];
  if (marks.length < 2) return false;
  // 第一个是 true、第二个是 false（实测 class 里带 "true" 的是第一个）
  const idx = value === "true" ? 0 : 1;
  const el = marks[idx];
  if (!el) return false;
  el.click();
  return true;
}

function clickSubmitButton() {
  const b = document.querySelector("button.btn");
  if (!b) return false;
  try { b.click(); } catch (e) { return false; }
  return true;
}

async function gotoQuestionUI(index) {
  for (let i = 0; i < 60; i++) {
    const q = readQuestion();
    if (!q) return false;
    if (q.index === index) return true;
    const old = q.index;

    // ① 优先点"下一题/上一题"箭头
    const arrow = q.index < index
      ? document.querySelector(".tabbar .iconfont.right")
      : document.querySelector(".tabbar .iconfont:not(.right)");
    if (arrow) {
      arrow.click();
      const m = await waitFor(() => {
        const n = readQuestion();
        return n && n.index !== old ? n : null;
      }, 1500, 100);
      if (m) continue;
    }

    // ② 兜底：直接点题号
    const jump = [...document.querySelectorAll(".tabbar *")].find((e) =>
      e.children.length === 0 && (e.innerText || "").trim() === String(index));
    if (jump) {
      jump.click();
      const m = await waitFor(() => {
        const n = readQuestion();
        return n && n.index !== old ? n : null;
      }, 1500, 100);
      if (m) continue;
    }
    return false;
  }
  return false;
}

/** 组请求头：复用站点自己的头（含 CSRF） */
function apiHeaders() {
  const h = {};
  for (const k in NET.headers) {
    const lk = k.toLowerCase();
    if (lk === "content-length" || lk === "host" || lk === "connection") continue;
    h[k] = NET.headers[k];
  }
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1];
  if (csrf) h["X-CSRFToken"] = decodeURIComponent(csrf);
  h["x-client"] = "web";
  h["xtbz"] = "xt";
  h["django-language"] = "zh";
  h["accept"] = "application/json, text/plain, */*";
  return h;
}

/** 拉某个作业的题目列表（url 形如 .../get_exercise_list/{exercise_id}/{sku_id}/）
 *  被平台风控拦截时会返回 { error: "request blocked" } 之类的信息 */
async function fetchExerciseList(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { credentials: "include", headers: apiHeaders() });
    const j = await r.json();
    if (!j || !j.success) {
      return { url, error: (j && (j.msg || j.message)) || ("HTTP " + r.status) };
    }
    const m = url.match(/get_exercise_list\/(\d+)\/(\d+)/);
    return { url, exerciseId: m ? m[1] : null, skuId: m ? m[2] : null, data: j.data };
  } catch (e) {
    return { url, error: String(e && e.message ? e.message : e) };
  }
}

function normText(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** 在抓到的题目列表里找"当前页正在显示的那一份"（按题干比对，避免拿到别的作业的缓存） */
function scanExerciseHits(dom) {
  const urls = Object.keys(NET.exerciseHits);
  urls.sort((a, b) => (NET.exerciseHits[b].ts || 0) - (NET.exerciseHits[a].ts || 0));
  if (!urls.length) return { hit: null, matched: false };
  const q = normText(dom && dom.question).slice(0, 24);
  for (const u of urls) {
    const hit = NET.exerciseHits[u];
    const probs = (hit.data && hit.data.problems) || [];
    if (!probs.length) continue;
    const p = probs.find((x) => x.index === (dom && dom.index)) || probs[0];
    const body = normText(p && p.content && p.content.Body).slice(0, 24);
    if (body && q && (body === q || body.indexOf(q) === 0 || q.indexOf(body) === 0)) {
      return { hit, matched: true };
    }
  }
  return { hit: NET.exerciseHits[urls[0]], matched: false };
}

/** 等站点把"本页这份"题目列表请求出来 */
async function resolveCurrentExercise(dom) {
  let best = null, matched = false;
  const scan = () => {
    const r = scanExerciseHits(dom);
    if (r.hit && r.matched) { best = r.hit; matched = true; return true; }
    if (r.hit && !best) best = r.hit;
    return false;
  };
  if (!scan()) await waitFor(() => scan(), 10000, 300);
  return { hit: best, matched };
}

/** 直接调站点的提交接口（页面上那个"提交"按钮是 el-popover，脚本合成的点击事件点不动它）
 *  answers: 字符串数组。单选 ["A"] / 多选 ["A","C"] / 判断 ["true"] 或 ["false"] */
async function submitViaApi(info, leafId, exerciseId, problemId, answers) {
  const arr = Array.isArray(answers) ? answers : [answers];
  const body = {
    leaf_id: Number(leafId),
    classroom_id: Number(info.cid),
    exercise_id: Number(exerciseId),
    problem_id: Number(problemId),
    sign: info.sign,
    answers: {},
    answer: arr,
  };
  const headers = apiHeaders();
  headers["Content-Type"] = "application/json";
  try {
    const r = await fetch("/api/v1/lms/exercise/problem_apply/", {
      method: "POST", credentials: "include", headers, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    return { ok: !!(j && j.success), msg: (j && j.msg) || "", data: (j && j.data) || null };
  } catch (e) {
    return { ok: false, msg: String(e && e.message ? e.message : e), data: null };
  }
}

/** 题型归类：single 单选 / multiple 多选 / judge 判断 / null 不支持 */
function questionKind(p) {
  const c = (p && p.content) || {};
  const t = c.TypeText || "";
  const ty = c.Type || "";
  if (/判断/.test(t) || ty === "Judgement") return "judge";
  if (/多选/.test(t) || ty === "MultipleChoice") return "multiple";
  if (/单选/.test(t) || ty === "SingleChoice") return "single";
  return null;
}

/** 只有单选和多选是"选项题"（判断题选项是 true/false，页面结构完全不同） */
function isOptionQ(p) {
  const k = questionKind(p);
  return k === "single" || k === "multiple";
}

async function solveExercise(settings, info, leaf, token) {
  log(`📝 进入作业：${leaf.name} (${leaf.id})`);

  // 先探一下做题接口：被平台风控拦了就没必要干等页面渲染
  await waitFor(() => NET.exerciseUrl, 8000, 300);
  if (NET.exerciseUrl) {
    const probe = await fetchExerciseList(NET.exerciseUrl);
    if (probe && probe.error) {
      log(`   !! 平台把做题接口拦了：${probe.error}`);
      log("   !! 常见于风控：先手动过一次『安全验证』，或退出重新登录换一个会话。");
      return false;
    }
  }

  const ok = await waitFor(() => document.querySelector(".leftQuestion .fuwenben"), 45000);
  if (!ok) { log("   !! 没检测到题目，跳过"); return false; }
  await sleep(800);
  dismissPopups();

  if (settings.DRY_RUN) {
    log("   (内部调试：演练模式，提交会被拦截，不消耗作答机会)");
    installDryRunGuard();
  }

  // AI 都没配好就别往下走，避免"跑完一圈一题没提交"
  if (!settings.AI_API_URL || !settings.AI_API_KEY) {
    log("   !! 没填 AI 接口地址 / Key，无法作答。请在面板里填好后重新开始。");
    state.stopped = true;
    return false;
  }

  // 找到"当前页这一份"题目列表（按题干比对，避免拿到别的作业的缓存）
  const dom0 = readQuestion();
  const res = await resolveCurrentExercise(dom0);
  if (!res.hit) {
    // 看看是不是平台把做题接口拦了（风控 / 需要先过安全验证）
    if (NET.exerciseUrl) {
      const probe = await fetchExerciseList(NET.exerciseUrl);
      if (probe && probe.error) {
        log(`   !! 平台把做题接口拦了：${probe.error}` +
            "（常见于风控：先手动过一次『安全验证』，或退出重新登录换一个会话）");
      }
    }
    const rc = Number(gmGet(RELOAD_KEY, 0)) || 0;
    if (rc >= 3) { gmSet(RELOAD_KEY, 0); log("   !! 多次刷新仍拿不到题目列表，本作业跳过"); return false; }
    gmSet(RELOAD_KEY, rc + 1);
    log("   !! 没抓到本站的题目列表，刷新本页重试…");
    gmSet(RUN_KEY, { sign: info.sign, cid: info.cid, leafId: leaf.id, ts: Date.now() });
    location.reload();
    return false;
  }
  gmSet(RELOAD_KEY, 0);
  let list = await fetchExerciseList(res.hit.url);
  if (!list || list.error) {
    if (list && list.error) log(`   !! 题目列表接口被拒：${list.error}`);
    const m1 = res.hit.url.match(/get_exercise_list\/(\d+)/) || [];
    const m2 = res.hit.url.match(/get_exercise_list\/\d+\/(\d+)/) || [];
    list = { url: res.hit.url, exerciseId: m1[1], skuId: m2[1], data: res.hit.data };
  }
  if (!res.matched) log("   ! 题目列表与当前页不完全匹配，按最新一份处理");

  const problems = (list.data && list.data.problems) || [];
  const kindCount = {};
  for (const p of problems) {
    const k = questionKind(p) || "other";
    kindCount[k] = (kindCount[k] || 0) + 1;
  }
  log(`   本作业共 ${problems.length} 题` +
      `（单选 ${kindCount.single || 0} / 多选 ${kindCount.multiple || 0} / 判断 ${kindCount.judge || 0}` +
      `${kindCount.other ? " / 其他 " + kindCount.other : ""}）`);

  let answered = 0;
  for (const p of problems) {
    if (state.stopped || (token && state.token !== token)) break;
    await waitCaptchaDone();                 // 有验证码就先等它处理完
    const curPage = pageInfo();
    if (curPage && curPage.leafId !== leaf.id) { log("   → 页面已被切走，停止本作业"); break; }
    const idx = p.index;
    const kind = questionKind(p);
    if (!kind) { log(`   ⏭ 第 ${idx} 题题型不支持（${(p.content && p.content.TypeText) || "未知"}），跳过`); continue; }
    if (p.user && p.user.my_count > 0) { log(`   第 ${idx} 题已作答，跳过`); continue; }

    // 把页面切到这一题，取页面上的文字
    await gotoQuestionUI(idx);
    await sleep(500);
    const dom = readQuestion();
    const useDom = dom && dom.index === idx &&
      (kind === "judge" ? true : dom.options.length > 0);
    const question = useDom ? dom.question : stripHtml(p.content.Body);
    // 判断题没有选项列表，选项固定是 正确/错误
    const options = kind === "judge"
      ? [{ letter: "true", text: "正确" }, { letter: "false", text: "错误" }]
      : (useDom ? dom.options
        : ((p.content.Options || []).map((o) => ({ letter: o.key, text: stripHtml(o.value) }))));

    const kindTag = kind === "multiple" ? "多选" : (kind === "judge" ? "判断" : "单选");
    log(`   第 ${idx}/${problems.length} 题（${kindTag}）：${question.slice(0, 60)}`);

    /* 请求 AI 并校验答案。
     * 不合规（比如回"A 和 C"、回散文、回了不在选项里的字母）时，
     * 带上【上一轮的回答 + 问题原因】追加纠正提示词重试，最多 MAX_FIX_ROUNDS 次。 */
    let ans = null;
    let prev = null;
    const maxAttempts = Math.max(1, Math.min(settings.MAX_ROUNDS || 3, 1 + CONFIG.MAX_FIX_ROUNDS));
    for (let i = 0; i < maxAttempts; i++) {
      const r = await aiAnswer(settings, question, options, kind, prev);
      if (r.ok) { ans = r.ans; break; }
      if (r.fatal) {
        // 接口级失败：重试也没用，不浪费次数
        log(`   .. AI 接口不可用，本题不提交（${r.reason}）`);
        prev = null;
        break;
      }
      log(`   ! 答案不合规：${r.reason}`);
      log(`     AI 原话：${String(r.raw || "").slice(0, 120).replace(/\s+/g, " ")}`);
      prev = { raw: r.raw, reason: r.reason, cand: r.cand };
      if (i < maxAttempts - 1) {
        log(`   .. 追加纠正提示词重试（${i + 1}/${maxAttempts - 1}）`);
        await sleep(1500);
      }
    }
    if (!ans && prev && prev.cand && prev.cand.length) {
      /* 兜底：AI 一直不肯按规范格式输出，但宽松解析出的候选是完整合法的 →
       * 照样提交，别白白浪费这唯一一次机会 */
      const c = prev.cand;
      let loose = null;
      if (kind === "judge") {
        if (c.length === 1 && (c[0] === "true" || c[0] === "false")) loose = c[0];
      } else {
        const allow = allowedLetters(options);
        const okAll = c.every((L) => allow.indexOf(String(L).toUpperCase()) >= 0);
        if (okAll && (kind !== "single" || c.length === 1)) loose = kind === "single" ? c[0] : c;
      }
      if (loose !== null) {
        ans = loose;
        log(`   ! AI 始终没按规范格式输出，已按宽松规则解析出 ${c.join("、")} 并照此提交`);
      }
    }
    if (!ans) {
      log("   !! 没拿到可靠答案，本题不提交");
      if (settings.ABORT_ON_AI_ERROR) {
        log("   !! 已中止整个任务（可在面板把『AI 出错时』改成『跳过该题继续』）");
        state.stopped = true;
        break;
      }
      continue;
    }

    // 统一成答案数组：单选 ["A"] / 多选 ["A","C"] / 判断 ["true"]
    let answerArr;
    if (kind === "judge") {
      answerArr = [ans === "true" ? "true" : "false"];
    } else if (kind === "multiple") {
      answerArr = Array.isArray(ans) ? ans : [ans];
    } else {
      answerArr = [ans];
    }
    log(`   → AI 答案：${answerArr.join("、")}`);

    // 1) 在页面上把答案选上（作答区会同步高亮，肉眼可见）
    if (kind === "judge") {
      if (!clickJudge(answerArr[0])) log(`   !! 页面上没找到判断题的选项`);
    } else {
      const hitList = clickOptions(answerArr);
      if (hitList.length !== answerArr.length) {
        log(`   !! 页面上没找到选项：缺少 ${answerArr.filter((x) => !hitList.includes(x)).join("、")}`);
      }
    }
    await sleep(600);   // 等 Vue 把高亮刷到作答区
    const selAll = [...document.querySelectorAll(".answerList .radio_xtb.active, .answerList .radio_xtb.selected")]
      .map((e) => e.innerText.trim()).filter(Boolean);
    if (selAll.length) {
      const okAll = answerArr.every((a) => selAll.some((s) => s.toUpperCase() === String(a).toUpperCase()));
      if (!okAll) log(`   ! 作答区没有同步上全部选项（不影响提交）`);
    }

    // 2) 提交：调站点自己的提交接口（页面那个"提交"按钮是 el-popover，脚本合成的点击点不动它）
    const r = await submitViaApi(info, leaf.id, list.exerciseId, p.problem_id, answerArr);
    if (!r.ok) {
      log(`   !! 提交失败：${r.msg || "未知错误"}`);
      if (settings.ABORT_ON_AI_ERROR) {
        log("   !! 已中止整个任务，避免继续消耗机会");
        state.stopped = true;
      }
      break;
    }

    // 3) 回查服务端，确认这题真的记上了（不能只看接口返回）
    if (settings.DRY_RUN) {
      answered++;
      log(`   ✔ 第 ${idx} 题已提交（演练：请求被拦截，未真正落库）`);
    } else {
      const chk = await fetchExerciseList(list.url);
      const cp = chk && chk.data && (chk.data.problems || []).find((x) => x.problem_id === p.problem_id);
      const confirmed = !!(cp && cp.user && cp.user.my_count > 0);
      if (confirmed) {
        answered++;
        const sc = (r.data && (r.data.my_score !== undefined ? r.data.my_score : r.data.score));
        const right = (r.data && r.data.is_right !== undefined) ? r.data.is_right : null;
        log(`   ✔ 第 ${idx} 题已提交并落库` +
            (right === true ? "（判为正确）" : (right === false ? "（判为错误）" : "")) +
            (sc !== undefined && sc !== null ? ` 得分 ${sc}` : ""));
      } else {
        log(`   !! 第 ${idx} 题提交后服务端没有记录，判定为未提交`);
        if (settings.ABORT_ON_AI_ERROR) { log("   !! 已中止整个任务"); state.stopped = true; }
        break;
      }
    }

    // 4) 页面同步切到下一题
    await sleep(400);
    const nxt = problems.find((x) => x.index > idx && isOptionQ(x) && !(x.user && x.user.my_count > 0));
    if (nxt) {
      const moved = await gotoQuestionUI(nxt.index);
      log(moved ? `   → 页面已切到第 ${nxt.index} 题` : `   ! 没能切到第 ${nxt.index} 题`);
    } else {
      const arrow = document.querySelector(".tabbar .iconfont.right");
      if (arrow) { arrow.click(); await sleep(500); }
    }
  }
  log(`   作业处理完成，本次提交 ${answered} 题`);
  return true;
}

/* =========================================================================
 * 七、腾讯点选文字验证码（安全验证）
 *    站点用腾讯天御 TCaptcha，弹窗在跨域 iframe 里：
 *      https://turing.captcha.gtimg.com/1/template/drag_ele.html
 *    主页面读不到题面和图片，所以脚本在 iframe 内部也跑（靠 @match 命中）：
 *      在里面读题面 → 导图 → 问视觉模型要坐标 → 依次点击 → 点「确定」。
 *    识别不可靠时一律不点，交给人工（乱点会白白消耗验证次数）。
 * ========================================================================= */
const CAPTCHA_HOST_RE = /(^|\.)(turing\.captcha\.gtimg\.com|turing\.captcha\.qcloud\.com)$/;

function isCaptchaFrame() { return CAPTCHA_HOST_RE.test(location.hostname); }

/** 主页面：验证码弹窗是否正在显示 */
function captchaVisible() {
  const wrap = document.querySelector("#tcaptcha_transform_dy");
  if (!wrap) return false;
  const st = getComputedStyle(wrap);
  if (st.display === "none" || st.visibility === "hidden") return false;
  if (Number(st.opacity) === 0) return false;
  const r = wrap.getBoundingClientRect();
  if (r.width < 50 || r.height < 50) return false;
  if (r.top < -1000 || r.left < -1000) return false;   // 隐藏时会被挪到很远
  return true;
}

/** 题面「请依次点击: 扒 步 驰」→ ["扒","步","驰"] */
function parseClickTargets(instr) {
  const m = String(instr || "").match(/依次点击[:：]\s*(.+)$/);
  if (!m) return [];
  return m[1].split(/[\s,，、]+/).map((x) => x.trim()).filter((x) => x.length === 1);
}

/** 验证码图片：背景 img + 可能叠在上面的 canvas */
function pickCaptchaImage() {
  const area = document.querySelector(".tc-imgarea") || document;
  const cs = [...area.querySelectorAll("canvas")].filter((c) => c.width > 50 && c.height > 50);
  const bg = [...area.querySelectorAll("img")].find((i) => (i.naturalWidth || 0) > 50);
  if (bg) {
    return { bg, canvas: cs[0] || null, clickEl: bg,
             W: bg.naturalWidth, H: bg.naturalHeight };
  }
  if (cs.length) {
    return { bg: null, canvas: cs[0], clickEl: cs[0],
             W: cs[0].width, H: cs[0].height };
  }
  return null;
}

/** 把验证码区域导成 PNG data URL（同源，不会污染画布） */
function exportCaptchaImage(pick) {
  const W = pick.W, H = pick.H;
  if (!W || !H) return null;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  try {
    if (pick.bg) g.drawImage(pick.bg, 0, 0, W, H);
    if (pick.canvas) g.drawImage(pick.canvas, 0, 0, W, H);
  } catch (e) { return null; }
  try { return { dataUrl: c.toDataURL("image/png"), W, H }; } catch (e) { return null; }
}

/** 解析模型返回的坐标，并逐项校验（对不上就宁可不点） */
function parsePoints(content, targets, W, H) {
  if (!content) return null;
  let s = String(content).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return null; }
  const pts = obj && obj.points;
  if (!Array.isArray(pts) || pts.length !== targets.length) return null;
  const out = [];
  for (let i = 0; i < targets.length; i++) {
    const p = pts[i];
    if (!p) return null;
    const ch = String(p.char || "").trim();
    if (ch && ch !== targets[i]) return null;      // 字符/顺序对不上 → 结果不可信
    const x = Number(p.x), y = Number(p.y);
    if (!isFinite(x) || !isFinite(y)) return null;
    if (x < 0 || y < 0 || x > W || y > H) return null;
    out.push({ x, y });
  }
  return out;
}

/** 让视觉模型给出每个目标汉字在图中的中心坐标 */
async function aiLocateChars(settings, dataUrl, targets, W, H) {
  const list = targets.join("、");
  const prompt =
    "这是一张验证码图片，尺寸 " + W + "x" + H + " 像素。\n" +
    "验证码要求：依次点击图中的这些汉字：" + list + "。\n" +
    "请在图里找出这些汉字（同一个字可能重复出现，请分别定位），" +
    "给出每个要点击汉字的中心坐标，坐标以图片左上角为原点 (0,0)，x 向右、y 向下。\n" +
    "只输出下面这种 JSON，不要任何其它文字：\n" +
    '{"points":[{"char":"' + targets[0] + '","x":123,"y":45},{"char":"' + (targets[1] || targets[0]) + '","x":88,"y":200}]}';
  const body = {
    model: settings.AI_MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
    temperature: 0,
  };
  try {
    const r = await gmRequest("POST", settings.AI_API_URL,
      { "Content-Type": "application/json", "Authorization": "Bearer " + settings.AI_API_KEY },
      JSON.stringify(body));
    if (r.status !== 200) {
      log("   !! 视觉接口返回 " + r.status + "：" + describeAiError(r.status, r.responseText));
      return null;
    }
    const raw = String(r.responseText || "");
    if (/^\s*</.test(raw)) {
      log("   !! 视觉接口返回的是网页不是 JSON：" + describeAiError(r.status, raw));
      log("   检查面板里的『AI 接口地址』是否写全（要带 /chat/completions）");
      return null;
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { log("   !! 视觉返回不是合法 JSON"); return null; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : "";
    return parsePoints(content, targets, W, H);
  } catch (e) {
    log("   !! 视觉请求失败: " + e.message);
    return null;
  }
}

/** 在元素上按图片坐标点击（图片像素 → 元素内的 CSS 坐标） */
function clickPoint(el, x, y, W, H) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const cx = r.left + (x / W) * r.width;
  const cy = r.top + (y / H) * r.height;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
  try { el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ buttons: 1 }, base))); } catch (e) { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent("mousedown", Object.assign({ buttons: 1 }, base))); } catch (e) { /* ignore */ }
  try { el.dispatchEvent(new PointerEvent("pointerup", Object.assign({ buttons: 0 }, base))); } catch (e) { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent("mouseup", Object.assign({ buttons: 0 }, base))); } catch (e) { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent("click", Object.assign({ buttons: 0 }, base))); } catch (e) { /* ignore */ }
  return true;
}

/** 解一次点选文字题：识别 → 点击 → 确定。返回 true 表示通过了 */
async function solveOnce(settings, task) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const pick = await waitFor(() => pickCaptchaImage(), 15000, 300);
    if (!pick) { log("   !! 找不到验证码图片，请手动完成"); return false; }
    const shot = exportCaptchaImage(pick);
    if (!shot) { log("   !! 验证码图片导出失败，请手动完成"); return false; }
    const pts = await aiLocateChars(settings, shot.dataUrl, task.targets, shot.W, shot.H);
    if (!pts) {
      log("   .. 没拿到可靠坐标，不点击（避免白白消耗验证次数），请手动完成");
      return false;
    }
    for (const p of pts) {
      clickPoint(pick.clickEl, p.x, p.y, shot.W, shot.H);
      await sleep(400);
    }
    await sleep(500);
    const btn = document.querySelector(".verify-btn") || document.querySelector(".verify-btn-text");
    if (btn) {
      const r = btn.getBoundingClientRect();
      clickPoint(btn, r.width / 2, r.height / 2, r.width, r.height);
    }
    await sleep(1500);
    const wrap = document.querySelector("#tcWrap");
    const still = wrap && getComputedStyle(wrap).display !== "none";
    if (!still) { log("   ✔ 验证码已通过"); return true; }
    log("   .. 第 " + attempt + " 次点击未通过" + (attempt < 2 ? "，再试一次" : "，请手动完成"));
    await sleep(1500);
  }
  return false;
}

/** 在验证码 iframe 内部运行：识别 + 点击。
 *  腾讯会复用同一个 iframe 下发下一次挑战，所以这里要循环等下一题。 */
async function runCaptchaSolver() {
  let fails = 0;
  for (let round = 1; round <= 30; round++) {
    const task = await waitFor(() => {
      const wrap = document.querySelector("#tcWrap");
      if (!wrap) return null;
      const st = getComputedStyle(wrap);
      if (st.display === "none" || st.visibility === "hidden") return null;
      const instrEl = document.querySelector("#instructionText");
      const instr = instrEl ? (instrEl.innerText || "").trim() : "";
      const targets = parseClickTargets(instr);
      if (!targets.length) return null;          // 不是点选文字题（滑块等）→ 交给人
      return { instr, targets };
    }, 300000, 500);
    if (!task) return;

    log("🔐 捕获到点选文字验证码：" + task.instr);
    const settings = loadSettings();
    if (!settings.AI_API_URL || !settings.AI_API_KEY) {
      log("   !! 没配 AI 接口 / Key，请手动完成验证码");
      return;
    }

    const ok = await solveOnce(settings, task);
    if (ok) {
      fails = 0;
    } else {
      fails++;
      if (fails >= 3) {
        log("   !! 连续 3 次没通过，停止自动处理，请手动完成验证码");
        return;
      }
    }
    // 等弹窗关掉，再等下一轮挑战
    await waitFor(() => {
      const wrap = document.querySelector("#tcWrap");
      return !(wrap && getComputedStyle(wrap).display !== "none");
    }, 20000, 500);
  }
}

/** 主页面：等验证码处理完（最多 5 分钟） */
async function waitCaptchaDone() {
  if (!captchaVisible()) return;
  log("   ⚠ 检测到安全验证，等待处理…");
  await waitFor(() => !captchaVisible(), 300000, 1000);
  log("   ✔ 安全验证窗口已关闭");
}

/* =========================================================================
 * 八、GitHub 自动更新
 * ========================================================================= */
const UPDATE_CACHE_KEY = "xtx_update_cache_v1";
/* 探测顺序：优先主地址（.user.js，油猴能接管 → 点更新就是油猴自己的更新页），
   其次兜底地址（旧 .txt 文件名，改名完成前仍然能查到版本） */
const UPDATE_URLS = [UPDATE.url, UPDATE.fallbackUrl];

const ICON_UPD_DOWNLOAD =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5"/>' +
  '<path d="M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>';
const ICON_UPD_ERROR =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 9v4"/><path d="M12 17h.01"/>' +
  '<path d="M10.3 3.6 1.9 18.2A2 2 0 0 0 3.6 21h16.8a2 2 0 0 0 1.7-2.8L13.7 3.6a2 2 0 0 0-3.4 0Z"/></svg>';
const ICON_UPD_INFO =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';
const ICON_UPD_OK =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/></svg>';
const ICON_UPD_SPIN =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 4.5v5h-5"/></svg>';

/** 本地已安装的脚本版本（油猴的 GM_info） */
function localVersion() {
  try {
    if (typeof GM_info !== "undefined" && GM_info && GM_info.script) {
      return String(GM_info.script.version || "").trim() || null;
    }
  } catch (e) { /* ignore */ }
  return null;
}

/** 比较版本号：a>b → 1，a<b → -1，一样 → 0
 *  按点分段数字比（1.10 > 1.9）；带 -beta 之类的预发布标记算比正式版旧。
 *  预发布段按 semver 规则比（rc.10 > rc.9；非数字段按 ASCII 字典序，数字段比非数字段旧）。
 *  预发布比较刻意内联在这里：整个函数自包含，不依赖外部 helper。 */
function compareVersions(a, b) {
  const norm = (v) => String(v == null ? "" : v).trim().replace(/^v/i, "");
  const pa = norm(a).split("-"), pb = norm(b).split("-");
  const na = pa[0].split(".").map((x) => parseInt(x, 10) || 0);
  const nb = pb[0].split(".").map((x) => parseInt(x, 10) || 0);
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const x = na[i] || 0, y = nb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  const preA = pa.length > 1, preB = pb.length > 1;
  if (preA !== preB) return preA ? -1 : 1;      // 预发布版比正式版旧
  if (preA && preB) {
    const qa = pa[1].split("."), qb = pb[1].split(".");
    const n = Math.max(qa.length, qb.length);
    for (let i = 0; i < n; i++) {
      const x = qa[i], y = qb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const ix = /^\d+$/.test(x), iy = /^\d+$/.test(y);
      if (ix && iy) {
        const d = (parseInt(x, 10) || 0) - (parseInt(y, 10) || 0);
        if (d) return d > 0 ? 1 : -1;
        continue;
      }
      if (ix) return -1;                        // 数字段比非数字段旧
      if (iy) return 1;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }
  return 0;
}

/** 从脚本文本里解析 @version。
 *  只认元数据块（==UserScript== ... ==/UserScript==）里的 @version：
 *  正文里随便写一行 "// @version x" 不算数（否则版本判定会被正文劫持）。 */
function parseScriptVersion(text) {
  const s = String(text || "");
  const i = s.indexOf("==UserScript==");
  const j = s.indexOf("==/UserScript==");
  // 找得到元数据块就只在块里找；只有开始标记（文件被截断）就从标记往后取 2KB；
  // 连开始标记都没有（不是油猴脚本）就退回头部 2KB
  const scope = (i >= 0)
    ? s.slice(i, (j > i ? j : Math.min(s.length, i + 2000)))
    : s.slice(0, 2000);
  const m = scope.match(/^[ \t]*\/\/[ \t]*@version[ \t]+(\S+)/m);
  return m ? m[1] : null;
}

/** GET 一个文本地址。带 Range 头时只取头部几 KB，省流量。 */
function gmFetchText(url, headers) {
  return new Promise((resolve, reject) => {
    const fn = (typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest) ||
               (typeof GM !== "undefined" && GM && GM.xmlHttpRequest);
    if (!fn) { reject(new Error("GM_xmlhttpRequest 不可用")); return; }
    fn({
      method: "GET", url: url, headers: headers || {}, timeout: 20000,
      onload: (r) => resolve({ status: r.status, text: String(r.responseText || "") }),
      onerror: (e) => reject(new Error("网络错误: " + (e && e.error))),
      ontimeout: () => reject(new Error("请求超时")),
    });
  });
}

/** 打开一个新标签页（优先用油猴的 API，失败退回 window.open） */
function openInNewTab(url) {
  try {
    if (typeof GM_openInTab === "function") {
      GM_openInTab(url, { active: true, insert: true, setParent: true });
      return true;
    }
  } catch (e) { /* ignore */ }
  try { window.open(url, "_blank", "noopener"); return true; } catch (e) { /* ignore */ }
  return false;
}

/** 复制文本到剪贴板（优先用 Clipboard API，失败退回 execCommand） */
async function copyToClipboard(text) {
  const t = String(text || "");
  if (!t) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, t.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) { return false; }
}

/** 当前更新状态（供面板渲染用） */
let updateInfo = { state: "idle", local: null, remote: null, url: null, at: 0 };
/** 手动更新指引里待复制的完整脚本 */
let updateFullText = "";
/** 正在飞行的更新检查（防止连点「检查更新」重复打 GitHub） */
let updateChecking = null;
/** 手动触发标记：请求在飞的时候用户又点了「检查更新」，这一轮也要按手动处理 */
let updateForcePending = false;
/** 「已经是最新版本」横幅的自动收起定时器 */
let latestBannerTimer = null;

/** 检查远程版本。
 *  force=true 时忽略缓存（面板上点「检查更新」用）。
 *  返回 { state, local, remote, url, reason, at } */
async function checkForUpdate(force) {
  if (force) updateForcePending = true;
  // 已经在查了：直接等它，不要重复打 GitHub
  if (updateChecking) return updateChecking;
  updateChecking = runUpdateCheck();
  try {
    return await updateChecking;
  } finally {
    updateChecking = null;
    updateForcePending = false;
  }
}

/** 真正去问远程版本的那一段 */
async function runUpdateCheck() {
  const local = localVersion();
  if (!local) {
    const r = { state: "idle", local: null, remote: null, url: null, at: Date.now() };
    gmSet(UPDATE_CACHE_KEY, r);
    renderUpdate(r, updateForcePending);
    return r;
  }

  const cached = gmGet(UPDATE_CACHE_KEY, null);
  const cacheFresh = cached && cached.state !== "checking" &&
    Date.now() - (cached.at || 0) < UPDATE.checkIntervalMs;
  // 本地版本变了 → 说明脚本刚被更新过，缓存里的结论作废，得重新问一次
  const localChanged = !!(cached && cached.local && cached.local !== local);

  if (!updateForcePending && cacheFresh && !localChanged) {
    // 缓存还在有效期内：不用重新拉远程，但要用【当前本地版本】重新判定状态
    const r = Object.assign({}, cached, { local: local });
    if (cached.state === "error") {
      r.state = "error";
    } else if (cached.remote) {
      const c = compareVersions(cached.remote, local);
      r.state = c > 0 ? "available" : (c < 0 ? "older" : "latest");
    }
    renderUpdate(r, false);
    return r;
  }

  renderUpdate({ state: "checking", local: local }, updateForcePending);

  // 重新去问远程 → 之前缓存的"新版本全文"可能已经过期，作废
  updateFullText = "";

  let remote = null, url = null, reason = "";
  for (const u of UPDATE_URLS) {
    try {
      const r = await gmFetchText(u, { "Range": "bytes=0-3071" });
      if (r.status === 200 || r.status === 206) {
        const v = parseScriptVersion(r.text);
        if (v) { remote = v; url = u; break; }
        reason = "远程文件里没有 @version";
      } else if (r.status === 404) {
        reason = "远程地址不存在（404）";
      } else {
        reason = "远程返回 " + r.status;
      }
    } catch (e) {
      reason = (e && e.message) ? e.message : String(e);
    }
  }

  const res = { state: "idle", local: local, remote: remote, url: url, reason: reason, at: Date.now() };
  if (!remote) {
    res.state = "error";
  } else {
    const c = compareVersions(remote, local);
    res.state = c > 0 ? "available" : (c < 0 ? "older" : "latest");
  }
  gmSet(UPDATE_CACHE_KEY, res);
  renderUpdate(res, updateForcePending);
  // 手动检查且远程仍比本地新、但仓库文件仍不是 .user.js 结尾 → 继续给手动指引
  // （自动检查不弹，避免每次打开页面都糊一块指引）
  if (updateForcePending && res.state === "available" && res.url && !/\.user\.js(\?|#|$)/i.test(res.url)) {
    await showManualUpdateGuide(res.url, res.remote);
  }
  return res;
}

/** 点「更新」：油猴能接管的（.user.js）交给油猴，否则给手动指引 */
let updateBusy = false;
async function performUpdate() {
  if (updateBusy) return;
  const info = updateInfo;
  if (!info || !info.url) return;
  updateBusy = true;
  try {
    if (/\.user\.js(\?|#|$)/i.test(info.url)) {
      const ok = openInNewTab(info.url);
      if (ok) {
        setUpdateBanner("available", "已打开油猴的更新页",
          "在油猴的页面点「更新」，然后刷新本页即可生效", "", null);
        log("已打开油猴的更新页：" + info.url);
        return;
      }
    }
    await showManualUpdateGuide(info.url, info.remote);
  } finally {
    updateBusy = false;
  }
}

/** 降级路径：仓库文件不是 .user.js 结尾，油猴接管不了 → 给出手动步骤 */
async function showManualUpdateGuide(url, remote) {
  if (!updateFullText) {
    try {
      const r = await gmFetchText(url, null);
      if (r.status === 200) updateFullText = r.text || "";
    } catch (e) { /* 拿不到就只给步骤 */ }
  }
  const guide = panel && panel.querySelector("#xtx-guide");
  if (guide) guide.hidden = false;
  // 横幅主按钮改成「重新检查」：用户按指引把文件改名后，点它就能重新判定
  setUpdateBanner("available", "需要手动更新一下" + (remote ? "（远程 v" + remote + "）" : ""),
    "仓库文件还没改成 .user.js 结尾，油猴接管不了这个链接", "重新检查", () => {
      checkForUpdate(true).catch(() => {});
    });
  log("油猴无法接管这个地址（不是 .user.js 结尾），已给出手动更新步骤");
}

/* =========================================================================
 * 九、主流程
 * ========================================================================= */
const state = { stopped: false, running: false, token: 0, doneVideos: 0, doneExams: 0 };

const ORDER_TEXT = "以当前所在页面为先，然后接着往后做";

function wantType(settings, leaf) {
  if (settings.MODE === "video") return leaf.kind === "video";
  if (settings.MODE === "exercise") return leaf.kind === "exercise";
  return true;
}

/** 挑下一个还没处理的章节：从当前页往后接着做，末尾绕回开头 */
function pickNext(leaves, handled, cur) {
  const pending = (l) => !handled.has(l.id);
  const idx = leaves.findIndex((l) => cur && l.id === cur.leafId);
  if (idx < 0) return leaves.filter(pending)[0] || null;
  for (let k = 1; k <= leaves.length; k++) {
    const l = leaves[(idx + k) % leaves.length];
    if (pending(l)) return l;
  }
  return null;
}

/** 处理一个章节（视频刷进度 / 作业做题提交） */
async function handleLeaf(settings, info, leaf, alreadyHere, token) {
  if (leaf.kind === "video") {
    if (settings.MAX_VIDEOS && state.doneVideos >= settings.MAX_VIDEOS) {
      log(`达到 MAX_VIDEOS(${settings.MAX_VIDEOS})，停止刷课`);
      state.stopped = true;
      return null;
    }
    if (await isFinished(info, leaf.id)) { log(`⏭ 已完成，跳过：${leaf.name}`); return null; }
    if (!alreadyHere) {
      const ok = await gotoLeaf(info, leaf);
      if (!ok) { log("   → 整页跳转中，等新页面继续"); return null; }
      await sleep(600);
    }
    if (state.stopped) return null;
    const ok = await playVideo(settings, info, leaf);
    if (ok) state.doneVideos++;
    return ok ? "video" : null;

  } else if (leaf.kind === "exercise") {
    if (!alreadyHere) {
      const ok = await gotoLeaf(info, leaf);
      if (!ok) { log("   → 整页跳转中，等新页面继续"); return null; }
      await sleep(600);
    }
    if (state.stopped) return null;
    await solveExercise(settings, info, leaf, token);
    state.doneExams++;
    return "exercise";
  }
  // 讨论 / 考试 等其它类型：脚本不做（考试有次数限制，讨论要发帖）
  return null;
}

async function runAll(settings, token) {
  const info = pageInfo();
  if (!info) { log("!! 当前不是课程学习页"); return; }
  setStatus(`运行中 · 课程 ${info.cid}`);

  // ① 先看侧栏 DOM（各课程结构一致）
  let leaves = await waitFor(() => {
    const ls = getLeaves();
    return ls.length ? ls : null;
  }, 15000);

  // ② 侧栏没有（课程已结束 / 未加入 / 老页面结构不同）→ 退到站点的章节接口
  if (!leaves) {
    log("   侧栏没渲染出来，改用章节接口获取课程结构…");
    leaves = await getLeavesFromApi(info);
    if (leaves.length) {
      log(`   ✔ 接口取到 ${leaves.length} 个章节`);
    } else {
      const body = document.body ? document.body.innerText.replace(/\s+/g, " ") : "";
      if (/课程服务已结束|不能继续学习|新学期已开课/.test(body)) {
        log("!! 这门课的课程服务已结束，平台不允许继续学习");
        log("   （换一门正在开课、且你已加入的课程再试）");
      } else if (/加入学习|立即加入/.test(body) && !/learn\/space/.test(location.pathname)) {
        log("!! 还没加入这门课，请先点『加入学习』再运行脚本");
      } else {
        log("!! 没找到章节列表：可能课程未加入 / 已结束，或页面结构与本站不同");
      }
      setStatus("无法读取课程结构");
      return;
    }
  }

  const videos = leaves.filter((l) => l.kind === "video");
  const exams = leaves.filter((l) => l.kind === "exercise");
  const others = leaves.filter((l) => l.kind !== "video" && l.kind !== "exercise");
  log(`共 ${leaves.length} 个章节（视频 ${videos.length} / 作业 ${exams.length}` +
      `${others.length ? " / 其它 " + others.length : ""}）`);
  log(`执行顺序：${ORDER_TEXT}`);

  const handled = new Set();
  const maxTurns = leaves.length * 3 + 30;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (state.stopped || state.token !== token) break;
    const cur = pageInfo();
    if (!cur) break;

    // ① 当前所在页面优先：用户手动切到哪一页，就先做哪一页
    const curLeaf = leaves.find((l) => l.id === cur.leafId);
    if (curLeaf && !handled.has(curLeaf.id)) {
      if (!wantType(settings, curLeaf)) {
        log(`⏭ 当前页类型（${curLeaf.type || curLeaf.kind}）不在当前模式里，跳过：${curLeaf.name}`);
        handled.add(curLeaf.id);
        continue;
      }
      handled.add(curLeaf.id);
      await handleLeaf(settings, info, curLeaf, true, token);
      continue;
    }

    // ② 否则从当前位置往后接着做
    const next = pickNext(leaves, handled, cur);
    if (!next) break;
    if (!wantType(settings, next)) { handled.add(next.id); continue; }
    handled.add(next.id);
    await handleLeaf(settings, info, next, false, token);
  }

  setStatus(`完成 · 视频 ${state.doneVideos} 节 / 作业 ${state.doneExams} 个`);
  log(`全部任务结束 ✔（视频 ${state.doneVideos} 节 / 作业 ${state.doneExams} 个）`);
}

function start() {
  if (state.running) { log("已经在运行了"); return; }
  const settings = readPanel();
  state.stopped = false;
  state.token++;
  const token = state.token;
  state.running = true;
  state.doneVideos = 0;
  state.doneExams = 0;
  setRunningUI(true);
  setStatus("运行中…");
  log("===== 开始运行 =====");
  log(`模式=${settings.MODE}  模型=${settings.AI_MODEL}  倍速=${settings.PLAYBACK_RATE}`);
  if (settings.AI_API_URL) log(`接口地址=${settings.AI_API_URL}`);
  if (settings.DRY_RUN) log("（内部调试）演练模式：提交会被拦截，不消耗作答机会。");
  else log("⚠ 真实提交模式：每题只有 1 次机会，提交后不能撤回，AI 答错就是答错。");
  if ((settings.MODE === "both" || settings.MODE === "exercise") &&
      (!settings.AI_API_URL || !settings.AI_API_KEY)) {
    log("!! 做题需要 AI 接口地址和 Key，先在面板里填一下（不填也能只刷课）");
  }
  runAll(settings, token).catch((e) => {
    log("!! 运行出错: " + (e && e.message ? e.message : e));
  }).finally(() => {
    if (state.token === token) {
      state.running = false;
      setRunningUI(false);
    }
  });
}

/* ---------------- 启动 ---------------- */
(async function init() {
  try {
    // 必须抢在站点自己发请求之前装记录器：exercise_id 只能从站点的题目列表请求里拿到
    installNetRecorder();

    // ① 验证码 iframe 内部：只跑验证码识别
    if (isCaptchaFrame()) { runCaptchaSolver().catch(() => {}); return; }

    // ② 其它子框架（AI 聊天窗等）：一律不管
    if (window.top !== window) return;

    if (document.readyState === "loading") {
      await new Promise((r) => document.addEventListener("DOMContentLoaded", r));
    }
    if (!document.body) {
      await new Promise((r) => {
        const t = setInterval(() => { if (document.body) { clearInterval(t); r(); } }, 100);
      });
    }
    if (!pageInfo()) return;
    ensurePanel();
    syncPanel(loadSettings());
    if (abortPrefMigrated) {
      log("已把『AI 出错时』改成『跳过该题继续』：AI 答不出答案时只跳过这一题，不影响后面的题。");
    }

    // 每次打开页面都顺手查一次 GitHub 上有没有新版本（5 分钟内不重复问）
    checkForUpdate(false).catch(() => { /* 更新检查失败不影响主功能 */ });

    const run = gmGet(RUN_KEY, null);
    if (run && Date.now() - (run.ts || 0) < 30 * 60 * 1000) {
      gmDel(RUN_KEY);
      log(`检测到上次未跑完，自动继续（leaf=${run.leafId}）`);
      setTimeout(start, 2000);
      return;
    }
    if (CONFIG.AUTO_START) setTimeout(start, 1500);
  } catch (e) {
    console.error("[xtx-bot] 初始化失败", e);
    try { log("!! 初始化失败: " + (e && e.message ? e.message : e)); } catch (x) { /* ignore */ }
  }
})();
