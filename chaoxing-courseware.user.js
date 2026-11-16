// ==UserScript==
// @name         超星课件抓取器 · PPT/PDF/页面图片 合并导出
// @namespace    specdock.my-script.chaoxing-courseware
// @version      1.1.0
// @description  在超星学习通（兼容学堂在线）课程页扫描各章节里的 PPT / PDF / 幻灯片，逐页抓取后合并成一个文件，按章节名保存到本地；学习通下可把当前页面正文里的图片收成一份高清 PDF。面板可拖动，菜单一键更新。
// @author       specdock
// @match        https://mooc1.chaoxing.com/mycourse/*
// @match        https://mooc1-2.chaoxing.com/mooc-ans/mycourse/*
// @match        https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/*
// @match        https://*.xuetangx.com/learn/*
// @match        https://*.xuetangx.com/course/*
// @icon         https://www.xuetangx.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @connect      *
// @connect      d0.cldisk.com
// @connect      p.cldisk.com
// @connect      *.cldisk.com
// @connect      *.chaoxing.com
// @connect      mooc1.chaoxing.com
// @connect      mooc1-api.chaoxing.com
// @connect      mooc2-ans.chaoxing.com
// @connect      registry.npmmirror.com
// @connect      cdn.staticfile.org
// @connect      jsd.onmicrosoft.cn
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @updateURL    https://raw.githubusercontent.com/SpecDock/MyScript/master/chaoxing-courseware.user.js
// @downloadURL  https://raw.githubusercontent.com/SpecDock/MyScript/master/chaoxing-courseware.user.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* eslint-disable no-undef */
(function () {
  "use strict";

  // =====================================================================
  // 0. 常量
  // =====================================================================
  const API = "/api/v1";
  const UA_DEFAULT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36";

  // 站点识别：学堂在线(xuetangx) / 超星学习通(chaoxing)
  // 调试用：页面里设 window.__XTD_SITE = "chaoxing" 可强制走某个站点适配
  const SITE = (() => {
    const forced = (typeof window !== "undefined" && window.__XTD_SITE) || "";
    if (forced) return String(forced);
    const h = String((typeof location !== "undefined" && location.hostname) || "").toLowerCase();
    if (/(^|\.)chaoxing\.com$/.test(h)) return "chaoxing";
    if (/(^|\.)xuetangx\.com$/.test(h)) return "xuetangx";
    return "generic";
  })();

  // 运行时按镜像列表依次回退加载，避免单个 CDN 挂掉导致脚本失效
  // 注意：npmmirror 对 pptxgenjs 这个包直接 403（策略屏蔽），所以它不能放在 pptxgenjs 列表里
  const LIB_MIRRORS = {
    "pdf-lib": [
      "https://registry.npmmirror.com/pdf-lib/1.17.1/files/dist/pdf-lib.min.js",
      "https://cdn.staticfile.org/pdf-lib/1.17.1/pdf-lib.min.js",
      "https://jsd.onmicrosoft.cn/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
      "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
      "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js",
    ],
    "pptxgenjs": [
      "https://jsd.onmicrosoft.cn/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js",
      "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js",
      "https://unpkg.com/pptxgenjs@3.12.0/dist/pptxgen.bundle.js",
    ],
  };

  const DOC_EXT = [".pdf", ".ppt", ".pptx", ".odp"];
  const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];

  // 站点有时返回相对路径（/files/x.pdf），必须按当前站点 origin 补全
  const PAGE_ORIGIN =
    (typeof location !== "undefined" && location.origin) || "https://www.xuetangx.com";

  const state = {
    libs: { "pdf-lib": null, pptxgenjs: null },
    libTried: {},
    ctx: null,
    groups: [],              // {chapter, items:[{url,kind,name,pages:[]}]}
    selected: new Set(),     // 当前勾选的 group 下标
    running: false,
    cancelRequested: false,
    scanned: false,
    canScan: true,
    warnedPerm: false,       // 跨源授权框只提醒一次
  };

  // 调试钩子：在页面控制台里可以看 window.__XTD_STATE.groups 里的真实资源地址
  if (typeof window !== "undefined") window.__XTD_STATE = state;

  // =====================================================================
  // 1. 小工具
  // =====================================================================
  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function safeName(raw, fallback) {
    fallback = fallback || "未命名";
    if (raw === null || raw === undefined) return fallback;
    let s = String(raw).replace(/[\r\n\t]+/g, " ").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    s = s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
    if (!s) return fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = "_" + s;
    return s.slice(0, 120);
  }

  /** 站点标题来自远端 HTML/JSON，插入面板前必须转义 */
  function escapeHtml(raw) {
    return String(raw == null ? "" : raw).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function extOf(url) {
    const p = String(url).split("?")[0].split("#")[0].toLowerCase();
    const m = p.match(/\.[a-z0-9]{2,5}$/);
    return m ? m[0] : "";
  }

  function isImg(url) {
    return IMG_EXT.includes(extOf(url));
  }

  function isDoc(url) {
    return DOC_EXT.includes(extOf(url));
  }

  /** 把绝对或相对 URL 统一成绝对 URL；不是 URL 的返回空串。 */
  function resolveUrl(v) {
    if (typeof v !== "string") return "";
    const s = v.trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("/")) {
      try { return new URL(s, PAGE_ORIGIN).href; } catch (e) { return ""; }
    }
    return "";
  }

  function randomName() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const bytes = new Uint8Array(4);
    const c = g.crypto || g.msCrypto;
    if (c && typeof c.getRandomValues === "function") {
      c.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return "doc_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // =====================================================================
  // 2. 库加载（带镜像回退）
  // =====================================================================
  function gmText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        timeout: 30000,
        onload: (r) => (r.status >= 200 && r.status < 400 ? resolve(r.responseText) : reject(new Error("HTTP " + r.status))),
        onerror: () => reject(new Error("网络错误")),
        ontimeout: () => reject(new Error("超时")),
      });
    });
  }

  async function ensureLib(name) {
    if (state.libs[name]) return state.libs[name];
    if (state.libTried[name]) return null;
    state.libTried[name] = true;

    const list = LIB_MIRRORS[name] || [];
    for (const url of list) {
      try {
        log(`加载库 ${name} <- ${new URL(url).host} …`);
        const code = await gmText(url);
        const exportName = name === "pdf-lib" ? "PDFLib" : "PptxGenJS";
        const fn = new Function(
          code +
            "\n;try{return (typeof " + exportName + " !== 'undefined') ? " + exportName +
            " : ((typeof window !== 'undefined' && window." + exportName + ") || null);}" +
            "catch(e){return null;}"
        );
        const lib = fn();
        if (lib) {
          state.libs[name] = lib;
          log(`库 ${name} 加载成功`);
          return lib;
        }
      } catch (e) {
        log(`镜像失败 ${new URL(url).host}: ${e.message}`);
      }
    }
    log(`库 ${name} 全部镜像失败，将跳过依赖它的功能`);
    return null;
  }

  // =====================================================================
  // 3. GM 请求（绕过 CORS）
  // =====================================================================
  function gmRequest(url, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || "GET",
        url: url,
        responseType: opts.responseType || "blob",
        timeout: opts.timeout || 120000,
        headers: opts.headers || {},
        // 超星的课件在 d1.chaoxing.com CDN 上，部分链接要求带会话
        withCredentials: true,
        anonymous: false,
        onload: (r) => {
          if (r.status >= 200 && r.status < 400) resolve(r);
          else reject(new Error(`HTTP ${r.status} ${String(url).slice(0, 90)}`));
        },
        onerror: () => reject(new Error("网络错误 " + String(url).slice(0, 90))),
        ontimeout: () => reject(new Error("超时 " + String(url).slice(0, 90))),
      });
    });
  }

  function apiGet(path, params) {
    const url = new URL(API + path, location.origin);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    return fetch(url.toString(), {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then((r) => r.json())
      .catch((e) => ({ success: false, msg: String(e) }));
  }

  // =====================================================================
  // 4. 课程上下文解析
  // =====================================================================
  function parseCtx() {
    const path = location.pathname;

    // 超星学习通：/mycourse/studentstudy?chapterId=&courseId=&clazzid=&cpi=
    if (SITE === "chaoxing") {
      const q = new URLSearchParams(location.search);
      const courseid = q.get("courseid") || q.get("courseId") || "";
      const clazzid = q.get("clazzid") || q.get("classId") || "";
      const knowledgeid = q.get("chapterId") || q.get("knowledgeid") || "";
      // clazzid 允许为空：部分页面没带，后面用 backclazzdata 反查补齐
      if (courseid) {
        return { site: "chaoxing", courseid, clazzid, knowledgeid, url: location.href };
      }
      return null;
    }

    // 新版 /learn/space/{sign}/{sign}/{cid}/{kind}/{leafId}
    // 旧版 /learn/{sign}/{sign}/{cid}/{kind}/{leafId}
    let m = path.match(/\/learn\/(?:space\/)?([^/]+)\/([^/]+)\/(\d+)\/([a-z]+)\/(\d+)/i);
    if (m) {
      return { sign: m[2], cid: m[3], kind: m[4], leafId: m[5], url: location.href };
    }
    // 课程介绍页 /course/{sign}/{cid}
    m = path.match(/\/course\/([^/]+)(?:\/(\d+))?/i);
    if (m) {
      return { sign: m[1], cid: m[2] || "", kind: "", leafId: "", url: location.href };
    }
    return null;
  }

  // =====================================================================
  // 5. 资源扫描
  // =====================================================================
  const DOC_KEYS = new Set([
    "document", "documents", "doc", "docs", "file", "files", "filename",
    "file_url", "fileurl", "download_url", "downloadurl", "ware", "courseware",
    "material", "materials", "attachment", "attachments", "resource", "resources",
    "pdf", "pdf_url", "pdfurl", "ppt", "ppt_url", "ppturl", "pptx", "slides",
    "slide", "reading", "handout", "paper", "document_url", "documenturl",
    "ware_url", "source_url", "courseware_url", "attach", "attach_url",
  ]);

  // 命名分三层，避免"文档自己的 name"（讲义.pdf）盖掉课时名
  const CHAPTER_KEYS = ["chapter_name", "section_name", "chapter", "group_name", "section_title"];
  const LEAF_KEYS = ["leaf_name", "lesson_name", "unit_name", "leaf_title"];
  const GENERIC_KEYS = ["name", "title", "document_name", "file_name"];

  // 真实站点的附件对象形如 {file_url, file_name, file_type, file_size}
  // （前端 xtAttachment 组件就是这么渲染的，下载链接是 file_url + "?attname=" + file_name）
  const FILE_TYPE_KEYS = ["file_type", "filetype", "extension", "ext"];
  const FILE_NAME_KEYS = ["file_name", "filename"];

  // 目录里有些章节名就是 video / html 这类占位词，不适合当文件名
  const GENERIC_NAMES = new Set([
    "video", "html", "article", "exercise", "quiz", "discussion",
    "audio", "live", "text", "pdf", "ware", "chapter", "unit", "section",
  ]);

  function kindByFileType(t) {
    if (!t) return "";
    const tl = String(t).toLowerCase().replace(/^\./, "");
    if (/^(png|jpg|jpeg|gif|bmp|webp|tif|tiff)$/.test(tl)) return "image";
    if (tl === "pdf") return "pdf";
    if (/^(ppt|pptx|doc|docx|odp)$/.test(tl)) return "ppt";
    return "";
  }


  function pickKey(node, keys) {
    for (const k of keys) {
      const v = node[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  /**
   * 递归扫描 JSON，抽出文档资源与"页图数组"。
   * 返回 { docs:[{url,kind,name,chapter}], pageSets:[{urls:[],name,chapter}] }
   *
   * 命名优先级：课时名(leaf_name 等) > 祖先的通用名 > 当前节点的通用名
   * —— 当前节点的通用名通常是文档自身文件名，只作最后兜底。
   */
  function scanJson(root, seedChapter, seedName, labels) {
    const docs = [];
    const pageSets = [];
    const seenDoc = new Set();
    const seenPage = new Set();

    function walk(node, chapter, leafName, genName, inDoc, labelName) {
      if (Array.isArray(node)) {
        // 数组里全是图片 -> 当成一份文档的页
        const imgs = [];
        for (const it of node) {
          const raw = typeof it === "string" ? it : (it && (it.url || it.src || it.file_url));
          const u = resolveUrl(raw);
          if (u && isImg(u)) imgs.push(u);
        }
        if (imgs.length >= 2) {
          const key = imgs.join("|");
          if (!seenPage.has(key)) {
            seenPage.add(key);
            pageSets.push({
              urls: imgs,
              name: seedName || labelName || leafName || genName || "",
              chapter: chapter || "",
            });
          }
        }
        node.forEach((it) => walk(it, chapter, leafName, genName, inDoc, labelName));
        return;
      }
      if (!node || typeof node !== "object") return;

      const ownLeaf = pickKey(node, LEAF_KEYS);
      const ownGen = pickKey(node, GENERIC_KEYS);
      const ownChapter = pickKey(node, CHAPTER_KEYS);

      // 同一对象上的附件元数据（file_name / file_type）
      const ownFileType = pickKey(node, FILE_TYPE_KEYS);
      const ownFileName = pickKey(node, FILE_NAME_KEYS);

      // 目录里按 id 查到的章节标签（页面上显示的「编号 + 标题」），沿树往下继承
      let labelHit = "";
      if (labels && node.id !== undefined && node.id !== null) {
        const idNum = parseInt(node.id, 10);
        if (!Number.isNaN(idNum) && labels.has(idNum)) labelHit = labels.get(idNum);
      }
      const curLabel = labelHit || labelName || "";

      // 本层直接带的文档 URL —— 名字优先级：
      //   章节标签(来自目录) > 课时名 > 祖先通用名 > 本层通用名（通常是文档自身文件名）
      // 章节标签优先，是因为站点大纲上「编号 + 标题」那一行才是用户认的课时名；
      // 课时详情里自带的 leaf_name 只是这一行的副标题。
      const urlName = seedName || curLabel || ownLeaf || leafName || genName || ownGen;
      for (const [k, v] of Object.entries(node)) {
        const abs = resolveUrl(v);
        if (!abs) continue;
        const kl = k.toLowerCase();
        const looksDoc = DOC_KEYS.has(kl) || (inDoc && isDoc(abs)) || isDoc(abs);
        if (!looksDoc) continue;
        // 去重按「文件 + 所属课时」：同一份文件被两个课时引用时两边都要保留
        const dedupKey = abs + "@" + urlName;
        if (seenDoc.has(dedupKey)) continue;
        seenDoc.add(dedupKey);
        docs.push({
          url: abs,
          kind: kindByFileType(ownFileType) || (isImg(abs) ? "image" : (extOf(abs) === ".pdf" ? "pdf" : "ppt")),
          name: urlName,
          chapter: chapter || seedChapter || "",
          fileName: ownFileName,
          fileType: ownFileType,
        });
      }

      // 章节上下文
      let nextChapter = ownChapter || chapter;
      if (!nextChapter && ownGen) {
        // 形如 {name:"第一章", leaf_list:[...]} 的结构
        const hasLeafList = Object.keys(node).some((kk) =>
          /leaf_list|leaves|leaflist|section_leaf|leafs/i.test(kk)
        );
        if (hasLeafList) nextChapter = ownGen;
      }
      const nextLeaf = ownLeaf || leafName;
      const nextGen = ownGen || genName;

      for (const [k, v] of Object.entries(node)) {
        walk(v, nextChapter, nextLeaf, nextGen, inDoc || DOC_KEYS.has(k.toLowerCase()), curLabel);
      }
    }

    walk(root, seedChapter || "", "", "", false, "");
    return { docs, pageSets };
  }

  /**
   * 建立 leaf_id -> 章节标签 的映射。
   *
   * 真实站点的左侧大纲里：
   *   - 章节行渲染的是 item2.path + "  " + item2.name（path 是 "1.1" 这类编号）
   *   - 课时行只渲染 item3.name
   * 文件名要跟用户看到的那一行一致，所以这里按站点同样的规则拼「编号 + 标题」。
   */
  function buildLeafLabels(root) {
    const map = new Map();

    const nameOf = (node) => (node && typeof node.name === "string" ? node.name.trim() : "");
    const pathOf = (node) => (node && typeof node.path === "string" ? node.path.trim() : "");
    const labelOf = (node) => {
      const p = pathOf(node);
      const n = nameOf(node);
      if (p && n) return p + "  " + n;
      return n || p;
    };
    const isGeneric = (s) => !s || GENERIC_NAMES.has(s.toLowerCase());

    function walk(node) {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== "object") return;

      const ownLabel = labelOf(node);
      const ownId = node.id !== undefined && node.id !== null ? parseInt(node.id, 10) : NaN;
      if (!Number.isNaN(ownId) && ownLabel && !map.has(ownId)) map.set(ownId, ownLabel);

      const list = Array.isArray(node.leaf_list)
        ? node.leaf_list
        : (Array.isArray(node.leaves) ? node.leaves : null);
      if (list) {
        const secName = nameOf(node);
        list.forEach((leaf) => {
          if (!leaf || typeof leaf !== "object") return;
          const lid = leaf.id !== undefined && leaf.id !== null ? parseInt(leaf.id, 10) : NaN;
          if (Number.isNaN(lid)) return;
          const leafLabel = labelOf(leaf);
          // 章节名有意义就用章节标签；章节名是 video/html 这类占位词就退回课时自己的名字
          let label = "";
          if (!isGeneric(secName)) {
            label = ownLabel;
          } else if (!isGeneric(nameOf(leaf))) {
            // 课时自己没编号时，把章节的编号补上
            label = pathOf(leaf) ? leafLabel : (pathOf(node) ? pathOf(node) + "  " + nameOf(leaf) : nameOf(leaf));
          } else {
            label = ownLabel || leafLabel;
          }
          map.set(lid, label);
        });
      }

      Object.keys(node).forEach((k) => walk(node[k]));
    }

    walk(root);
    return map;
  }

  /**
   * 收集课时 id。
   *
   * 真实结构里课时 id 就写在 leaf_list[] 的 id 字段上（**不叫 leaf_id**），
   * 所以除了扫 leaf_id / leafid 字段，还要按结构收：
   *   - leaf_list[] / leaves[] 里的每一项
   *   - section_leaf_list[] 里带 leaf_type 的那些本身就是「单元」，也是课时
   * 漏了这一步会一个课时都拉不到（目录接口只给大纲，课件挂在课时详情里）。
   */
  function collectLeafIds(root) {
    const ids = new Set();

    (function walk(n) {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== "object") return;
      for (const [k, v] of Object.entries(n)) {
        if ((k === "leaf_id" || k === "leafid") && v !== null && v !== "") {
          const id = parseInt(v, 10);
          if (!Number.isNaN(id)) ids.add(id);
        }
        walk(v);
      }
    })(root);

    const idOf = (o) => {
      if (!o || typeof o !== "object") return NaN;
      const raw = o.id !== undefined && o.id !== null ? o.id : (o.leaf_id !== undefined ? o.leaf_id : o.leafid);
      return parseInt(raw, 10);
    };

    (function walkStructure(n) {
      if (Array.isArray(n)) { n.forEach(walkStructure); return; }
      if (!n || typeof n !== "object") return;

      ["leaf_list", "leaves"].forEach((key) => {
        const list = n[key];
        if (!Array.isArray(list)) return;
        list.forEach((leaf) => {
          const id = idOf(leaf);
          if (!Number.isNaN(id)) ids.add(id);
        });
      });

      if (Array.isArray(n.section_leaf_list)) {
        n.section_leaf_list.forEach((u) => {
          if (!u || typeof u !== "object") return;
          if (u.leaf_type === undefined || u.leaf_type === null) return; // 没有 leaf_type 的只是章节分组
          const id = idOf(u);
          if (!Number.isNaN(id)) ids.add(id);
        });
      }

      Object.keys(n).forEach((k) => walkStructure(n[k]));
    })(root);

    return Array.from(ids);
  }

  // =====================================================================
  // 6. 抓取 + 合并
  // =====================================================================
  async function blobToBytes(blob) {
    if (blob.arrayBuffer) return new Uint8Array(await blob.arrayBuffer());
    return new Uint8Array(await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(new Uint8Array(fr.result));
      fr.onerror = rej;
      fr.readAsArrayBuffer(blob);
    }));
  }

  /** 只在真的要生成 PPTX 时才转 data URL，避免整批图片常驻一份 Base64 副本 */
  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ""));
      fr.onerror = () => rej(fr.error || new Error("读取图片失败"));
      fr.readAsDataURL(blob);
    });
  }

  function sniffBytes(b, url) {
    if (!b || b.length < 4) return "unknown";
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";   // %PDF
    if (b[0] === 0x50 && b[1] === 0x4b) return "zip";                                    // PK (pptx/docx)
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "ole";   // 老 ppt/doc
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
    const e = extOf(url || "");
    if (e === ".pdf") return "pdf";
    if (e === ".pptx") return "zip";
    if (e === ".ppt" || e === ".odp") return "ole";
    if (e === ".png") return "png";
    if (IMG_EXT.includes(e)) return "jpg";
    return "unknown";
  }

  async function loadImages(urls, referer) {
    const out = new Array(urls.length);
    let cursor = 0;
    // 4 路并发：几十页幻灯片时比串行快数倍，也不至于把 CDN 打出限流
    const worker = async () => {
      while (cursor < urls.length) {
        if (state.cancelRequested) return;
        const i = cursor++;
        const u = urls[i];
        try {
          const r = await gmRequest(u, {
            responseType: "blob",
            headers: referer ? { Referer: referer } : {},
          });
          const bytes = await blobToBytes(r.response);
          const kind = sniffBytes(bytes, u);
          const mime = kind === "png" ? "image/png" : "image/jpeg";
          out[i] = { url: u, bytes, mime };
        } catch (e) {
          log(`  图片失败 ${shortUrl(u)}: ${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
    return out.filter(Boolean);
  }

  async function buildPdf(pdfSources, imageSources) {
    const lib = await ensureLib("pdf-lib");
    if (!lib) throw new Error("pdf-lib 不可用，无法合并 PDF");
    const out = await lib.PDFDocument.create();

    for (const src of pdfSources) {
      try {
        const doc = await lib.PDFDocument.load(src.bytes);
        const pages = await out.copyPages(doc, doc.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } catch (e) {
        log(`  PDF 合并失败 ${shortUrl(src.url)}: ${e.message}`);
      }
    }

    for (const img of imageSources) {
      try {
        const emb = img.mime === "image/png" ? await out.embedPng(img.bytes) : await out.embedJpg(img.bytes);
        const page = out.addPage([emb.width, emb.height]);
        page.drawImage(emb, { x: 0, y: 0, width: emb.width, height: emb.height });
      } catch (e) {
        log(`  图片入 PDF 失败: ${e.message}`);
      }
    }

    return out.save();
  }

  async function buildPptx(imageSources, title) {
    const PptxGenJS = await ensureLib("pptxgenjs");
    if (!PptxGenJS) throw new Error("pptxgenjs 不可用，无法生成 PPTX");
    const Ctor = PptxGenJS.PptxGenJS || PptxGenJS;
    const pptx = new Ctor();
    pptx.defineLayout({ name: "XT169", width: 13.333, height: 7.5 });
    pptx.layout = "XT169";
    pptx.title = title || "课件";

    for (const img of imageSources) {
      const blob = new Blob([img.bytes], { type: img.mime || "image/jpeg" });
      const slide = pptx.addSlide();
      let w = 13.333, h = 7.5;
      try {
        const dim = await imageSize(blob);
        const scale = Math.min(w / dim.w, h / dim.h);
        w = dim.w * scale;
        h = dim.h * scale;
      } catch (e) { /* 用整版 */ }
      const dataUrl = await blobToDataUrl(blob);
      slide.addImage({ data: dataUrl, x: (13.333 - w) / 2, y: (7.5 - h) / 2, w: w, h: h });
    }
    const buf = await pptx.write({ outputType: "arraybuffer" });
    return new Uint8Array(buf);
  }

  async function imageSize(blob) {
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(blob);
        const dim = { w: bmp.width, h: bmp.height };
        if (typeof bmp.close === "function") bmp.close();
        return dim;
      } catch (e) { /* 回退到 <img> 解码 */ }
    }
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        URL.revokeObjectURL(url);
        res({ w: im.naturalWidth, h: im.naturalHeight });
      };
      im.onerror = () => {
        URL.revokeObjectURL(url);
        rej(new Error("图片解码失败"));
      };
      im.src = url;
    });
  }

  // =====================================================================
  // 7. 保存
  // =====================================================================
  function saveBlob(blob, filename) {
    return new Promise((resolve, reject) => {
      // 兜底：GM_download 传 blob: URL 在部分环境取不到，此时退回浏览器原生 <a download>
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      const fallback = () => {
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 20000);
      };
      if (typeof GM_download === "function") {
        let settled = false;
        try {
          GM_download({
            url: a.href,
            name: filename,
            saveAs: false,
            onload: () => {
              if (settled) return;
              settled = true;
              setTimeout(() => URL.revokeObjectURL(a.href), 10000);
              resolve();
            },
            onerror: () => {
              if (settled) return;
              settled = true;
              fallback();
              resolve();
            },
          });
        } catch (e) {
          settled = true;
          fallback();
          resolve();
        }
      } else {
        fallback();
        resolve();
      }
    });
  }

  // =====================================================================
  // 8. 抓取流程
  // =====================================================================
  /**
   * 分组键：一个课时一个文件。
   * 优先用课时名（用户看到的"章节"，如 1.1 第一课时 …），
   * 没有课时名时退回章节名，再退回空（后续用原文件名/随机名）。
   */
  function groupNameOf(d) {
    if (!d) return "";
    return (typeof d.name === "string" && d.name.trim()) ? d.name.trim() : (d.chapter || "");
  }

  async function collectAll(ctx, opts) {
    // 学习通走自己的三段式链路
    if (SITE === "chaoxing") return cxCollect(ctx, opts);

    const groups = new Map();
    const seenDoc = new Set();

    const addDoc = (d) => {
      if (!d || !d.url) return;
      const gname = groupNameOf(d);
      const gkey = gname || "_";
      // 去重按「文件 + 课时」：同一接口重复返回会折叠，但同一份文件被两个课时引用时两边都要
      const dedup = gkey + "@" + d.url;
      if (seenDoc.has(dedup)) return;
      seenDoc.add(dedup);
      if (!groups.has(gkey)) groups.set(gkey, { name: gname, chapter: d.chapter || "", items: [] });
      groups.get(gkey).items.push({ url: d.url, kind: d.kind, name: d.name, chapter: d.chapter });
    };

    const addPages = (p) => {
      const gname = groupNameOf(p);
      const gkey = gname || "_";
      const dedup = gkey + "@pages:" + p.urls[0] + "|" + p.urls.length;
      if (seenDoc.has(dedup)) return;
      seenDoc.add(dedup);
      if (!groups.has(gkey)) groups.set(gkey, { name: gname, chapter: p.chapter || "", items: [] });
      groups.get(gkey).items.push({
        url: p.urls[0], kind: "pages", pages: p.urls, name: p.name, chapter: p.chapter,
      });
    };

    // 8.1 目录 + 章节
    const blobs = [];
    log(`拉取目录 menu …`);
    const menu = await apiGet("/lms/learn/menu/", { cid: ctx.cid, sign: ctx.sign });
    if (menu && menu.success !== false && menu.data) blobs.push(menu.data);

    log(`拉取章节 chapter …`);
    const chap = await apiGet("/lms/learn/course/chapter", { cid: ctx.cid, sign: ctx.sign });
    if (chap && chap.success !== false && chap.data) blobs.push(chap.data);

    const leafIds = new Set();
    blobs.forEach((b) => collectLeafIds(b).forEach((id) => leafIds.add(id)));
    log(`目录里发现 ${leafIds.size} 个课时`);

    // 章节标签：leaf_id -> 页面上显示的「编号 + 标题」（用于文件命名）
    const labels = new Map();
    blobs.forEach((b) => {
      buildLeafLabels(b).forEach((v, k) => {
        if (!labels.has(k)) labels.set(k, v);
      });
    });
    if (labels.size) log(`章节标签 ${labels.size} 条`);

    // 8.2 目录本身扫一遍
    for (const b of blobs) {
      const s = scanJson(b, "", "", labels);
      s.docs.forEach(addDoc);
      s.pageSets.forEach(addPages);
    }

    // 8.3 课时详情（文档常挂在课时上）
    if (opts.withLeaf && leafIds.size) {
      const ids = Array.from(leafIds);
      const limit = opts.leafLimit > 0 ? Math.min(ids.length, opts.leafLimit) : ids.length;
      let done = 0;
      const queue = ids.slice(0, limit);
      const worker = async () => {
        while (queue.length) {
          if (state.cancelRequested) return;
          const lid = queue.shift();
          try {
            const r = await apiGet(`/lms/learn/leaf_info/${ctx.cid}/${lid}/`, { sign: ctx.sign });
            if (r && r.success !== false && r.data) {
              const s = scanJson(r.data, "", labels.get(lid) || "", labels);
              s.docs.forEach(addDoc);
              s.pageSets.forEach(addPages);
            }
          } catch (e) { /* 单个课时失败不影响整体 */ }
          done++;
          if (done % 5 === 0) log(`  课时详情 ${done}/${limit} …`);
          if (opts.onProgress) opts.onProgress(done, limit, "读取课时详情 " + done + "/" + limit);
        }
      };
      const n = Math.min(4, limit);
      await Promise.all(Array.from({ length: n }, worker));
    }

    return Array.from(groups.values()).filter((g) => g.items.length);
  }

  // =====================================================================
  // 8.5 学习通（超星）适配
  //
  // 超星的课件不是 JSON 目录，而是一条三段式链路（均已实测/逆向确认）：
  //   1) 章节列表
  //      GET https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=&clazzid=
  //      → HTML，章节节点是 .chapter_item[id^="cur"]，id 去掉 "cur" 就是 knowledgeid
  //   2) 章节卡片（附件）
  //      GET https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=&courseid=&knowledgeid=
  //      → HTML/内嵌脚本，附件在 iframe 的 data 属性 JSON 里（objectid）
  //   3) 资源状态（拿到真实下载地址）
  //      GET https://mooc1.chaoxing.com/ananas/status/{objectid}?flag=normal&_dc={ts}
  //      → JSON: { filename, download, pdf, http, status, type, suffix }
  //
  // ⚠️ 超星会把"多章节同时打开"判为异常学习，所以这里**严格串行**并留间隔。
  // =====================================================================
  const CX = {
    STUDENTCOURSE: "https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse",
    CARDS: "https://mooc1.chaoxing.com/mooc-ans/knowledge/cards",
    STATUS: "https://mooc1.chaoxing.com/ananas/status/",
    STUDY: "https://mooc1.chaoxing.com/mycourse/studentstudy",
    ANANAS_REFERER: "https://mooc1.chaoxing.com/ananas/modules/pdf/index.html?v=2026-0312-1153",
    // 超星课程资源里视频/音频占绝大多数，先按后缀挡掉，省流量也省内存
    VIDEO_EXT: new Set([
      "mp4", "avi", "mov", "flv", "mkv", "webm", "m4v", "wmv", "rmvb", "3gp", "ts",
      "mp3", "m4a", "wav", "aac", "flac", "wma", "amr",
    ]),
    // 超星里常见的「占位式」章节名：没有信息量，这一课时只有一个文件时改用原文件名
    GENERIC_TITLES: new Set([
      "课件", "资料", "附件", "文档", "文件", "作业", "视频", "音频", "视频文件",
      "讨论", "测验", "考试", "章节", "小节", "目录", "其他", "教学材料",
      "课程材料", "学习资料", "参考资料", "教学资源", "课件资料",
    ]),
  };

  function buildUrl(base, params) {
    const u = new URL(base);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
    });
    return u.href;
  }

  /** 超星的请求都要带 Cookie（GM_xmlhttpRequest 默认会带），有的还要 Referer。 */
  function cxText(url, opts) {
    const o = opts || {};
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: o.method || "GET",
        url,
        timeout: o.timeout || 30000,
        headers: Object.assign({}, o.headers || {}),
        responseType: "text",
        // 超星接口全靠 Cookie 鉴权，必须显式带上
        withCredentials: true,
        anonymous: false,
        onload: (r) => {
          if (r.status >= 200 && r.status < 400) resolve(String(r.responseText || ""));
          else reject(new Error(`HTTP ${r.status} ${String(url).slice(0, 90)}`));
        },
        onerror: () => reject(new Error("网络错误 " + String(url).slice(0, 90))),
        ontimeout: () => reject(new Error("超时 " + String(url).slice(0, 90))),
      });
    });
  }

  /**
   * 超星 ananas/status 返回的下载地址常见三种形态：
   *   "https://d1.chaoxing.com/xxx.pdf"  绝对
   *   "//d1.chaoxing.com/xxx.pdf"       协议相对（超星 CDN 的常态）
   *   "/xxx.pdf"                        站点根相对
   * 协议相对必须补 scheme，否则 XHR 直接报非法 URL。
   */
  function cxResolveUrl(v) {
    if (typeof v !== "string") return "";
    const s = v.trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("//")) return "https:" + s;
    if (s.startsWith("/")) return "https://mooc1.chaoxing.com" + s;
    return "";
  }

  function cleanText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  /** iframe 的 data 属性在 HTML 里是转义过的，取出来先还原实体 */
  function decodeEntities(s) {
    return String(s == null ? "" : s)
      .replace(/&quot;/gi, '"')
      .replace(/&#0*34;/g, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#0*39;/g, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&");
  }

  /** 从 studentcourse 返回的 HTML 里解析章节（knowledgeid + 标题） */
  function cxParseChapters(html) {
    const out = [];
    const src = String(html || "");
    try {
      const doc = new DOMParser().parseFromString(src, "text/html");
      doc.querySelectorAll(".chapter_item[id^='cur']").forEach((item) => {
        const knowledgeid = String(item.id || "").replace(/^cur/, "");
        const titleAttr = cleanText(item.getAttribute("title"));
        const tnode = item.querySelector(".clicktitle");
        const titleText = cleanText(tnode ? tnode.textContent : item.textContent);
        if (knowledgeid) {
          out.push({ knowledgeid, title: titleAttr || titleText || "chapter_" + knowledgeid });
        }
      });
    } catch (e) {
      /* 落到正则兜底 */
    }
    if (!out.length) {
      const re = /id=["']cur(\d+)["']([^>]*)>/gi;
      let m;
      while ((m = re.exec(src))) {
        const attrs = m[2] || "";
        const tm = attrs.match(/title=["']([^"']*)["']/i);
        out.push({
          knowledgeid: m[1],
          title: cleanText(tm ? tm[1] : "") || "chapter_" + m[1],
        });
      }
    }
    return out;
  }

  /** 从章节卡片里解析附件（objectid + 名字） */
  function cxParseAttachments(html) {
    const map = new Map();
    const src = String(html || "");

    // iframe 的 data 属性里就是附件 JSON（{"objectid":"...","name":"..."}）
    const iframeRe = /<iframe[^>]*\bdata\s*=\s*(['"])([\s\S]*?)\1/gi;
    let m;
    while ((m = iframeRe.exec(src))) {
      let obj = null;
      try {
        obj = JSON.parse(decodeEntities(m[2]));
      } catch (e) {
        obj = null;
      }
      if (obj && obj.objectid) {
        const oid = String(obj.objectid);
        map.set(oid, {
          objectid: oid,
          name: cleanText(obj.name || obj.title || obj.filename || ""),
        });
      }
    }

    // 兜底：内嵌脚本里的 "objectid":"xxx"
    const re = /"objectid"\s*:\s*"([^"]+)"/gi;
    while ((m = re.exec(src))) {
      const oid = m[1];
      if (!map.has(oid)) map.set(oid, { objectid: oid, name: "" });
    }
    return Array.from(map.values());
  }

  /**
   * 【当前页模式】直接从页面 DOM 里取当前章节的课件。
   * 超星的课程页已经把当前章节的 cards 放在一个**同源** iframe 里了
   * （iframe[src*="knowledge/cards"]），里面嵌套的 iframe 的 data 属性
   * 就是附件 JSON（objectid / name / type / size）。
   * 这样既不用再发请求，也不会因为连续访问多个章节被超星判成异常学习。
   */
  function cxAttachmentsFromDom() {
    const out = [];
    const frames = Array.from(document.querySelectorAll("iframe"));
    const cards = frames.find((f) => /knowledge\/cards/.test(f.src || ""));
    if (!cards) return out;
    let doc = null;
    try { doc = cards.contentDocument; } catch (e) { doc = null; }
    if (!doc) return out;
    // 附件 iframe 在 cards 文档里（可能还嵌了一层）
    const holders = [doc].concat(Array.from(doc.querySelectorAll("iframe")).map((f) => {
      try { return f.contentDocument; } catch (e) { return null; }
    }).filter(Boolean));
    holders.forEach((d) => {
      d.querySelectorAll("iframe[data]").forEach((el) => {
        const raw = el.getAttribute("data") || "";
        let obj = null;
        try { obj = JSON.parse(decodeEntities(raw)); } catch (e) { obj = null; }
        if (!obj || !obj.objectid) return;
        out.push({
          objectid: String(obj.objectid),
          name: cleanText(obj.name || obj.title || obj.filename || ""),
          type: cleanText(obj.type || ""),
          size: obj.size || 0,
        });
      });
    });
    return out;
  }

  /**
   * 【当前页模式】取当前章节标题。
   * 课程页左侧目录里当前选中的节点是 `#cur{knowledgeid}`，class 含 posCatalog_active。
   */
  function cxCurrentChapterTitle(knowledgeid) {
    if (!knowledgeid) return "";
    const tries = [
      () => document.querySelector("#cur" + knowledgeid),
      () => document.querySelector('[id^="cur' + knowledgeid + '"]'),
      () => document.querySelector(".posCatalog_active"),
    ];
    for (const t of tries) {
      let el = null;
      try { el = t(); } catch (e) { el = null; }
      if (!el) continue;
      const named = el.querySelector("[title]");
      const title = cleanText(
        (named && (named.getAttribute("title") || named.textContent)) ||
        el.getAttribute("title") || el.textContent || ""
      );
      if (title) {
        // 目录节点文本尾部常带个数字（任务数），去掉
        return title.replace(/\s*\d+\s*$/, "").trim() || title;
      }
    }
    return "";
  }

  /** 页面 URL 里没带 clazzid 时，用 backclazzdata 反查班级 */
  async function cxResolveClazzId(ctx) {
    try {
      const txt = await cxText("https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1", {
        headers: { Referer: "https://mooc1.chaoxing.com/" },
      });
      const data = JSON.parse(txt);
      const list = (data && data.channelList) || [];
      for (const ch of list) {
        const c = ch && ch.content;
        if (!c) continue;
        const courses = (c.course && c.course.data) || [];
        const hit = courses.find((x) => String(x.id) === String(ctx.courseid));
        if (hit && c.id) return String(c.id);
      }
    } catch (e) {
      log(`反查 clazzid 失败: ${e.message}`);
    }
    return "";
  }

  /**
   * 附件 → 可下载资源（ananas/status → Range 探类型 → 生成 item）。
   * 一课时一个 group，同名的课件都在同一个 group 里。
   */
  async function cxItemsFromAttachments(atts, chapterTitle) {
    const items = [];
    for (const att of atts) {
      if (state.cancelRequested) break;
      let st = null;
      try {
        const txt = await cxText(
          CX.STATUS + encodeURIComponent(att.objectid) + "?flag=normal&_dc=" + Date.now(),
          { headers: { Referer: CX.ANANAS_REFERER } }
        );
        st = JSON.parse(txt);
      } catch (e) {
        continue;
      }
      if (!st || typeof st !== "object") continue;
      const type = cleanText(st.type || "").toLowerCase();
      const fname = cleanText(st.filename || att.name || "");
      const suffix = cleanText(st.suffix || "").toLowerCase();
      // 超星资源的 status.type 不可靠（视频的 type 也可能不是 "video"），
      // 真正的判别交给后面的 Range 头部探测，这里只做便宜的先验过滤。
      const nameExt = fname.includes(".") ? fname.split(".").pop().toLowerCase() : "";
      if (type === "audio" || CX.VIDEO_EXT.has(suffix) || CX.VIDEO_EXT.has(nameExt)) {
        log(`    · ${fname || "(无名)"} 是音频/视频，跳过`);
        continue;
      }
      // 下载地址有多个候选（download / pdf / http），逐个回退
      const cands = [];
      [st.download, st.pdf, st.http].forEach((u) => {
        const r = cxResolveUrl(u);
        if (r && cands.indexOf(r) < 0) cands.push(r);
      });
      if (!cands.length) continue;

      // 先只取文件头 8KB 判类型：超星课程资源绝大多数是视频（单个可达数百 MB），
      // 整份拉下来再 sniff 会把带宽和内存耗在马上要丢弃的东西上。
      // 但文件名后缀本身可信时（图片/PDF）不必探测：省掉大量 Range 请求，
      // 也避免超星限流时每个候选都要等满超时。
      const TRUST_EXT = { png: "png", jpg: "jpg", jpeg: "jpg", pdf: "pdf" };
      const trusted = TRUST_EXT[nameExt];
      let mtype = "unknown";
      let good = "";
      if (trusted) {
        mtype = trusted;
        good = cands[0];
      } else {
        for (const cand of cands) {
          mtype = await probeKind(cand, CX.ANANAS_REFERER);
          if (mtype === "pdf" || mtype === "zip" || mtype === "ole" ||
              mtype === "png" || mtype === "jpg") { good = cand; break; }
          if (mtype === "unknown" || mtype === "empty") break; // 确定不是课件
        }
      }
      if (!good) {
        if (String(mtype).indexOf("error") === 0) {
          // 网络抖动，先留着，下载阶段再试
          items.push({
            urls: cands, url: cands[0], kind: "file", name: fname, chapter: chapterTitle,
            fileName: fname, ext: suffix, type, mtype: "",
            referer: CX.ANANAS_REFERER, rawUrl: true,
          });
        } else {
          log(`    · ${fname || "(无名)"} 不是课件（${mtype}），跳过`);
        }
        continue;
      }
      items.push({
        urls: [good].concat(cands.filter((c) => c !== good)),
        url: good,
        kind: "file",
        name: fname,
        chapter: chapterTitle,
        fileName: fname,
        ext: suffix,
        type,
        mtype,
        referer: CX.ANANAS_REFERER,
        rawUrl: true, // 超星下载地址自带签名参数，不要再追加 attname
      });
      log(`    · ${fname || "(无名)"} → ${mtype}`);
    }
    return items;
  }

  /** 把 items 收进 group（同名的章节合并进同一个文件） */
  function cxGroup(groups, title, items) {
    if (!items.length) return;
    const key = title || "_";
    if (!groups.has(key)) {
      groups.set(key, { name: title || "", chapter: title || "", items: [] });
    }
    groups.get(key).items.push.apply(groups.get(key).items, items);
  }

  // =====================================================================
  // 超星：把当前页面正文里的图片收集成一个 PDF（取高清原图）
  // =====================================================================

  /**
   * 超星图床的高清规律（2026-11 实测）：
   *   https://p.ananas.chaoxing.com/star3/<宽>_<高>/<hash>.png  → 缩略图
   *   https://p.ananas.chaoxing.com/star3/origin/<hash>.png      → 原图（同一 hash）
   * 例：270_169/<hash>.png 是 270×169，origin/<hash>.png 是 640×360（字节数也更大）。
   * 其它 CDN（d0.cldisk.com 等）没有这种目录规则，保持原样。
   */
  function cxHiResUrl(u) {
    return String(u || "").replace(/(\/star3\/)\d+_\d+(\/)/, "$1origin$2");
  }

  // 页面里混着大量界面小图（关闭按钮、二维码、验证码、图标），那些不是课件内容
  const CX_UI_IMG_RE =
    /(popClose|qrcode|kaptcha|verifyCode|\/images\/|\/res\/plugin\/ueditor|logo|spacer|blank\.(gif|png))/i;

  /**
   * 收集当前页面正文里的图片：同源 iframe 直接读 DOM，零请求。
   * 优先 knowledge/cards 正文 iframe，再扫其它同源 iframe（含嵌套一层）。
   */
  function cxCollectPageImages() {
    const out = [];
    const seen = new Set();
    const seenDocs = new Set();

    const take = (doc) => {
      if (!doc) return;
      for (const im of Array.from(doc.querySelectorAll("img"))) {
        // 超星富文本把原图放在 data-original，src 有时只是缩略图
        const raw =
          im.getAttribute("data-original") ||
          im.getAttribute("data-src") ||
          im.getAttribute("src") ||
          "";
        if (!raw || /^data:/i.test(raw)) continue;
        const abs = cxResolveUrl(raw);
        if (!abs) continue;
        if (CX_UI_IMG_RE.test(abs)) continue;
        const w = im.naturalWidth || im.width || 0;
        const h = im.naturalHeight || im.height || 0;
        if (w && w < 120) continue;   // 小图标
        if (h && h < 60) continue;    // 细装饰条
        const hi = cxHiResUrl(abs);
        const key = hi.replace(/^https?:\/\//i, "");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(hi);
      }
    };

    const walk = (doc, depth) => {
      if (!doc || depth > 2 || seenDocs.has(doc)) return;
      seenDocs.add(doc);
      take(doc);
      for (const f of Array.from(doc.querySelectorAll("iframe"))) {
        let d = null;
        try { d = f.contentDocument; } catch (e) { continue; }
        walk(d, depth + 1);
      }
    };

    const frames = Array.from(document.querySelectorAll("iframe"));
    const isCards = (f) => /knowledge\/cards/i.test(f.getAttribute("src") || f.src || "");
    const ordered = frames.filter(isCards).concat(frames.filter((f) => !isCards(f)));
    for (const f of ordered) {
      let d = null;
      try { d = f.contentDocument; } catch (e) { continue; }
      walk(d, 1);
    }
    // 顶层一张都没有时，再看看正文是不是直接挂在当前页面上
    if (!out.length) take(document);
    return out;
  }

  /**
   * 【默认】只检测**当前这一页**（当前章节）的 PPT/PDF。
   * 优先复用页面里已经加载好的同源 cards iframe，不再发请求。
   */
  async function cxCollectCurrent(ctx, opts) {
    const groups = new Map();
    const kid = ctx.knowledgeid || "";
    if (!kid) {
      log("页面 URL 里没有 chapterId，无法确定当前章节");
      return [];
    }

    let clazzid = ctx.clazzid || "";
    if (!clazzid) {
      log("URL 里没有 clazzid，正在反查班级…");
      clazzid = await cxResolveClazzId(ctx);
      if (!clazzid) {
        log("反查 clazzid 失败，无法继续");
        return [];
      }
    }

    let title = cxCurrentChapterTitle(kid);
    log(`当前章节 ${kid}${title ? "「" + title + "」" : ""}`);

    // ① 先从页面 DOM 里读（零请求，且不会触发超星的异常学习判定）
    let atts = cxAttachmentsFromDom();
    log(`本页 DOM 里读到 ${atts.length} 个附件`);
    if (!atts.length) {
      // ② 兜底：直接请求 cards 接口
      try {
        const referer = buildUrl(CX.STUDY, {
          chapterId: kid,
          courseId: ctx.courseid,
          clazzid,
        });
        const cards = await cxText(
          buildUrl(CX.CARDS, {
            clazzid,
            courseid: ctx.courseid,
            knowledgeid: kid,
          }),
          { headers: { Referer: referer } }
        );
        atts = cxParseAttachments(cards);
        log(`改用接口读取，${atts.length} 个附件`);
      } catch (e) {
        log(`读取当前章节失败: ${e.message}`);
        return [];
      }
    }

    // ③ 章节名兜底：从章节列表里找
    if (!title) {
      try {
        const html = await cxText(
          buildUrl(CX.STUDENTCOURSE, { courseid: ctx.courseid, clazzid }),
          { headers: { Referer: ctx.url || location.href } }
        );
        const hit = cxParseChapters(html).find((c) => c.knowledgeid === kid);
        if (hit) title = hit.title;
      } catch (e) { /* 忽略，用文件名兜底 */ }
    }
    if (!title) title = "chapter_" + kid;

    const items = await cxItemsFromAttachments(atts, title);
    cxGroup(groups, title, items);

    // 页面正文里的图片（图文型章节）：单独收集成一个 PDF，取高清原图
    if (opts.pageImages) {
      const pics = cxCollectPageImages();
      if (pics.length) {
        // 超星富文本里的图往往就是本章附件（图床 hash 与附件 objectid 相同），
        // 这种情况下再单独收一遍会产出两份一样的文件
        const attImgs = items.filter((it) => it.mtype === "png" || it.mtype === "jpg");
        if (attImgs.length && attImgs.length === pics.length) {
          log(`页面图与本章附件是同一批（${pics.length} 张），不重复收集`);
        } else {
          const gname = groups.size ? title + "_页面图" : title;
          cxGroup(groups, gname, [
            {
              kind: "pages",
              pages: pics,
              name: gname,
              chapter: title,
              referer: (location.origin || "") + "/",
              noPptx: true,
            },
          ]);
          const g = groups.get(gname);
          if (g) g.noPptx = true;
          log(`本页正文里发现 ${pics.length} 张图片（已取高清原图地址）`);
        }
      } else {
        log("本页正文里没发现图片");
      }
    }

    return Array.from(groups.values()).filter((g) => g.items.length);
  }

  /** 【可选】扫描整门课程的所有章节（严格串行，超星要求） */
  async function cxCollectAll(ctx, opts) {
    const groups = new Map();

    let clazzid = ctx.clazzid || "";
    if (!clazzid) {
      log("URL 里没有 clazzid，正在反查班级…");
      clazzid = await cxResolveClazzId(ctx);
      if (!clazzid) {
        log("反查 clazzid 失败，无法继续");
        return [];
      }
      log(`clazzid = ${clazzid}`);
    }

    const html = await cxText(
      buildUrl(CX.STUDENTCOURSE, { courseid: ctx.courseid, clazzid }),
      { headers: { Referer: ctx.url || location.href } }
    );
    const chapters = cxParseChapters(html);
    log(`章节列表 ${chapters.length} 个`);
    if (!chapters.length) {
      log("studentcourse 没解析到章节（可能未登录或课程结构不同）");
      return [];
    }

    const limit = opts.leafLimit > 0 ? Math.min(chapters.length, opts.leafLimit) : chapters.length;
    for (let i = 0; i < limit; i++) {
      if (state.cancelRequested) { log("已取消扫描"); break; }
      const ch = chapters[i];
      try {
        const referer = buildUrl(CX.STUDY, {
          chapterId: ch.knowledgeid,
          courseId: ctx.courseid,
          clazzid,
        });
        const cards = await cxText(
          buildUrl(CX.CARDS, {
            clazzid,
            courseid: ctx.courseid,
            knowledgeid: ch.knowledgeid,
          }),
          { headers: { Referer: referer } }
        );
        const atts = cxParseAttachments(cards);
        const items = await cxItemsFromAttachments(atts, ch.title);
        // 同名章节合并进同一个文件（超星里"视频""作业"这类重名很常见）
        cxGroup(groups, ch.title || "chapter_" + ch.knowledgeid, items);
        log(`  [${i + 1}/${limit}] ${ch.title} → ${atts.length} 个附件 / ${items.length} 个可下`);
      } catch (e) {
        log(`  [${i + 1}/${limit}] ${ch.title} 失败: ${e.message}`);
      }
      if (opts.onProgress) opts.onProgress(i + 1, limit, `扫描章节 ${i + 1}/${limit}`);
      // 串行 + 间隔：超星会把多章节同时打开判为异常
      if (i < limit - 1 && !state.cancelRequested) await sleep(1000);
    }

    return Array.from(groups.values()).filter((g) => g.items.length);
  }

  /**
   * 超星抓取入口。
   * 默认只检测**当前这一页**（当前章节）的 PPT/PDF；
   * 勾选「扫描整门课程」才走全章节（需要串行，慢且可能触发超星的异常学习判定）。
   */
  async function cxCollect(ctx, opts) {
    if (opts.allChapters) return cxCollectAll(ctx, opts);
    return cxCollectCurrent(ctx, opts);
  }

  /**
   * 只取文件头部若干字节来判断类型。
   * 超星课程资源里视频占绝大多数（单个可达数百 MB），整份拉下来再 sniff
   * 会把带宽和内存全耗在马上要丢弃的视频上，所以先用 Range 探一下。
   */
  async function probeKind(url, referer) {
    try {
      const r = await gmRequest(url, {
        responseType: "blob",
        timeout: 12000,
        headers: Object.assign(
          { Range: "bytes=0-8191" },
          referer ? { Referer: referer } : {}
        ),
      });
      const bytes = await blobToBytes(r.response);
      if (!bytes || !bytes.length) return "empty";
      return sniffBytes(bytes, url);
    } catch (e) {
      return "error:" + e.message;
    }
  }

  async function processGroup(g, opts) {
    const label = g.name || g.chapter || (g.items[0] && g.items[0].name) || "";
    const pdfSources = [];
    const imageSources = [];
    const pptFiles = [];

    for (const item of g.items) {
      if (state.cancelRequested) return [];
      if (item.kind === "pages") {
        log(`  [${label}] 抓 ${item.pages.length} 页幻灯片 …`);
        const imgs = await loadImages(item.pages, item.referer);
        if (state.cancelRequested) return [];
        imageSources.push(...imgs);
        continue;
      }
      // 超星有多个候选下载地址（download / pdf / http），逐个探测回退
      const cands = item.urls && item.urls.length ? item.urls : [item.url];
      const isDoc = (k) => k === "pdf" || k === "zip" || k === "ole" || k === "png" || k === "jpg";
      let done = false;
      for (const cand of cands) {
        if (state.cancelRequested) return [];
        if (done) break;
        try {
          // 扫描阶段已经探过一次类型，能直接复用就不再重复请求
          let kind = item.mtype || "";
          if (!isDoc(kind)) {
            kind = await probeKind(cand, item.referer);
          }
          if (isDoc(kind)) {
            // 确认是课件了，再整份下载
            const dlUrl = item.rawUrl ? cand : attachAttname(cand, item.fileName);
            const r = await gmRequest(dlUrl, {
              responseType: "blob",
              timeout: 180000,
              headers: item.referer ? { Referer: item.referer } : {},
            });
            const bytes = await blobToBytes(r.response);
            // 用真实字节头复核类型：后缀猜的（png/jpg/pdf）或探测来的都可能被超星骗一次
            const real = sniffBytes(bytes, cand);
            if (real === "pdf" || real === "zip" || real === "ole" || real === "png" || real === "jpg") {
              kind = real;
            } else if (kind !== "unknown") {
              log(`  [${label}] ${item.fileName || "(无名)"} 实际不是课件（${real}），跳过`);
              done = true;
              continue;
            }
            if (kind === "pdf") {
              pdfSources.push({ url: cand, bytes });
            } else if (kind === "zip" || kind === "ole") {
              pptFiles.push({
                url: cand, bytes,
                ext: kind === "zip" ? ".pptx" : ".ppt",
                name: item.fileName || item.name || "",
              });
            } else {
              imageSources.push({
                url: cand, bytes,
                mime: kind === "png" ? "image/png" : "image/jpeg",
              });
            }
            log(`  [${label}] ${item.fileName || "(无名)"} → ${kind}，已取回`);
            done = true;
          } else if (kind === "unknown" || kind === "empty") {
            // 多半是 mp4 视频（ftyp 头），不是课件
            log(`  [${label}] 跳过 ${item.fileName || "(无名)"}：不是课件（疑似视频）`);
            done = true;
          } else {
            log(`  [${label}] 探测失败 ${shortUrl(cand)}: ${kind}`);
          }
        } catch (e) {
          log(`  [${label}] 下载失败 ${shortUrl(cand)}: ${e.message}`);
          // 篡改猴首次访问某域名会弹「跨源资源」授权框，不点掉请求会一直挂到超时
          if (/网络错误|超时/.test(e.message) && !state.warnedPerm) {
            state.warnedPerm = true;
            log("  若浏览器弹出「跨源资源」授权框，请点「总是允许」，否则请求会挂到超时。");
          }
        }
      }
    }

    if (state.cancelRequested) return [];

    // 输出文件名：默认用章节名；章节名是「课件」这类占位词且这一课时只有一个文件时，
    // 改用原文件名（更贴近用户实际要找的东西）
    let baseName = cleanText(label);
    if (CX.GENERIC_TITLES.has(baseName) && g.items.length === 1) {
      const only = g.items[0] || {};
      const alt = cleanText(only.fileName || only.name || "");
      if (alt) {
        baseName = alt.replace(/\.[A-Za-z0-9]{1,5}$/, "");
        log(`  [${label}] 章节名是占位词，改用原文件名: ${baseName}`);
      }
    }
    const base = safeName(baseName || (g.items[0] && g.items[0].name) || randomName());
    const made = [];

    // 原生 PPT/PPTX：章节里只有一个就用章节名；多个就各自保留原文件名（否则全叫同一个名会互相覆盖）
    const useOrigName = pptFiles.length > 1;
    for (const f of pptFiles) {
      const orig = cleanText(f.name || "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
      const stem = useOrigName && orig ? safeName(orig) : base;
      const name = stem + f.ext;
      const blob = new Blob([f.bytes], { type: "application/octet-stream" });
      try {
        await saveBlob(blob, name);
        made.push(name);
        log(`  [${label}] 已保存 ${name}`);
      } catch (e) {
        log(`  [${label}] 保存失败 ${name}: ${e.message}`);
      }
    }

    // PDF / 图片页 -> 合并
    if (pdfSources.length || imageSources.length) {
      try {
        const bytes = await buildPdf(pdfSources, imageSources);
        const name = base + ".pdf";
        await saveBlob(new Blob([bytes], { type: "application/pdf" }), name);
        made.push(name);
        log(`  [${label}] 已保存 ${name}  (PDF ${pdfSources.length} 份 + 图 ${imageSources.length} 页)`);
      } catch (e) {
        log(`  [${label}] PDF 合并失败: ${e.message}`);
      }
    }

    // 图片页 -> PPTX（页面正文图是文档插图，不是幻灯片，不出 PPTX）
    if (imageSources.length && opts.makePptx && !g.noPptx) {
      try {
        const bytes = await buildPptx(imageSources, base);
        const name = base + ".pptx";
        await saveBlob(
          new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
          name
        );
        made.push(name);
        log(`  [${label}] 已保存 ${name}  (${imageSources.length} 页)`);
      } catch (e) {
        log(`  [${label}] PPTX 生成失败: ${e.message}`);
      }
    }

    return made;
  }

  function shortUrl(u) {
    const s = String(u);
    return s.length > 70 ? s.slice(0, 70) + "…" : s;
  }

  /** 站点下载链接的形态：file_url + "?attname=" + 文件名 */
  function attachAttname(url, fileName) {
    if (!url || !fileName) return url;
    const sep = String(url).includes("?") ? "&" : "?";
    return url + sep + "attname=" + encodeURIComponent(fileName);
  }

  // =====================================================================
  // 9. UI
  // =====================================================================
  if (typeof GM_addStyle === "function") GM_addStyle(`
    #xtd-panel{
      --xtd-bg:#0f172a;--xtd-surface:#16213a;--xtd-surface-2:#1e293b;
      --xtd-border:#334155;--xtd-border-strong:#475569;
      --xtd-text:#f8fafc;--xtd-text-2:#cbd5e1;--xtd-muted:#94a3b8;
      --xtd-accent:#22c55e;--xtd-accent-hover:#16a34a;--xtd-on-accent:#052e16;
      --xtd-ring:#38bdf8;--xtd-warn:#fbbf24;--xtd-danger:#f87171;--xtd-ok:#4ade80;
      position:fixed;right:16px;bottom:16px;width:min(360px,calc(100vw - 24px));
      z-index:2147483000;color:var(--xtd-text);background:var(--xtd-bg);
      font:12.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      border:1px solid var(--xtd-border);border-radius:12px;overflow:hidden;isolation:isolate;
      box-shadow:0 18px 40px rgba(2,6,23,.55),0 3px 10px rgba(2,6,23,.4);
      color-scheme:dark;animation:xtd-in .2s ease-out}
    @keyframes xtd-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    #xtd-panel *{box-sizing:border-box}
    #xtd-panel [hidden]{display:none!important}
    #xtd-panel.collapsed .xtd-body{display:none}
    #xtd-panel .xtd-head{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;
      min-height:48px;background:var(--xtd-surface);border-bottom:1px solid var(--xtd-border);
      cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
    #xtd-panel .xtd-head:active{cursor:grabbing}
    #xtd-panel .xtd-dot{width:8px;height:8px;border-radius:50%;background:var(--xtd-accent);
      box-shadow:0 0 0 3px rgba(34,197,94,.16);flex:none}
    #xtd-panel .xtd-title{flex:1;font-size:13px;font-weight:600;letter-spacing:.01em;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #xtd-panel .xtd-ver{flex:none;font-size:11px;line-height:18px;color:var(--xtd-muted);
      background:var(--xtd-bg);border:1px solid var(--xtd-border);border-radius:999px;
      padding:0 7px;font-variant-numeric:tabular-nums}
    #xtd-panel button{display:inline-flex;align-items:center;justify-content:center;gap:6px;
      min-height:34px;padding:0 12px;border:1px solid transparent;border-radius:8px;
      font:inherit;font-size:12.5px;font-weight:600;line-height:1;cursor:pointer;
      transition:background-color .15s ease-out,border-color .15s ease-out,color .15s ease-out,opacity .15s ease-out}
    #xtd-panel button:focus-visible,#xtd-panel summary:focus-visible{outline:2px solid var(--xtd-ring);outline-offset:2px}
    #xtd-panel button:disabled{opacity:.45;cursor:not-allowed}
    #xtd-panel button svg{width:16px;height:16px;flex:none}
    #xtd-panel .xtd-icon-btn{width:32px;min-height:32px;padding:0;background:transparent;
      border-color:transparent;color:var(--xtd-muted)}
    #xtd-panel .xtd-icon-btn:hover{background:var(--xtd-surface-2);color:var(--xtd-text)}
    #xtd-panel .xtd-icon-btn svg{width:18px;height:18px;transition:transform .18s ease-out}
    #xtd-panel.collapsed .xtd-icon-btn svg{transform:rotate(180deg)}
    #xtd-panel .xtd-primary{background:var(--xtd-accent);color:var(--xtd-on-accent)}
    #xtd-panel .xtd-primary:hover:not(:disabled){background:var(--xtd-accent-hover)}
    #xtd-panel .xtd-secondary{background:var(--xtd-surface-2);color:var(--xtd-text);border-color:var(--xtd-border)}
    #xtd-panel .xtd-secondary:hover:not(:disabled){background:#273449;border-color:var(--xtd-border-strong)}
    #xtd-panel .xtd-ghost{background:transparent;color:var(--xtd-text-2);border-color:var(--xtd-border)}
    #xtd-panel .xtd-ghost:hover:not(:disabled){background:var(--xtd-surface-2);color:var(--xtd-text)}
    #xtd-panel .xtd-body{padding:12px;max-height:min(70vh,640px);overflow:auto;overscroll-behavior:contain}
    #xtd-panel .xtd-body::-webkit-scrollbar,#xtd-panel .xtd-list::-webkit-scrollbar,#xtd-panel .xtd-log::-webkit-scrollbar{width:10px;height:10px}
    #xtd-panel .xtd-body::-webkit-scrollbar-thumb,#xtd-panel .xtd-list::-webkit-scrollbar-thumb,#xtd-panel .xtd-log::-webkit-scrollbar-thumb{background:var(--xtd-border-strong);border:3px solid var(--xtd-bg);border-radius:999px}
    #xtd-panel .xtd-ctx{display:flex;flex-direction:column;gap:2px;padding:8px 10px;margin-bottom:10px;
      font-size:12px;color:var(--xtd-muted);background:var(--xtd-surface);
      border:1px solid var(--xtd-border);border-radius:8px}
    #xtd-panel .xtd-ctx b{color:var(--xtd-text);font-weight:600}
    #xtd-panel .xtd-ctx-line{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    #xtd-panel .xtd-ctx-line.xtd-ctx-hint{white-space:normal;overflow:visible;text-overflow:clip;line-height:1.5}
    #xtd-panel .xtd-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
    #xtd-panel .xtd-actions .xtd-span{grid-column:1 / -1}
    #xtd-panel .xtd-opts,#xtd-panel .xtd-logbox{margin-bottom:10px;background:var(--xtd-surface);
      border:1px solid var(--xtd-border);border-radius:8px}
    #xtd-panel .xtd-logbox{overflow:hidden}
    #xtd-panel summary{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 10px;
      color:var(--xtd-text-2);font-size:12px;font-weight:500;cursor:pointer;list-style:none;user-select:none}
    #xtd-panel summary::-webkit-details-marker{display:none}
    #xtd-panel summary svg{width:14px;height:14px;flex:none;color:var(--xtd-muted);transition:transform .18s ease-out}
    #xtd-panel details[open] > summary svg{transform:rotate(90deg)}
    #xtd-panel .xtd-opts-badge{flex:none;margin-left:auto;padding:1px 7px;border-radius:999px;
      font-size:11px;font-weight:600;color:var(--xtd-on-accent);background:var(--xtd-accent)}
    #xtd-panel .xtd-opts-body{display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px}
    #xtd-panel label{display:flex;align-items:center;gap:8px;min-height:24px;
      font-size:12px;color:var(--xtd-text-2);cursor:pointer}
    #xtd-panel label > span{flex:1}
    #xtd-panel input[type=checkbox]{width:15px;height:15px;margin:0;flex:none;
      accent-color:var(--xtd-accent);cursor:pointer}
    #xtd-panel input[type=checkbox]:focus-visible{outline:2px solid var(--xtd-ring);outline-offset:2px}
    #xtd-panel input[type=number]{width:56px;min-height:28px;padding:2px 6px;border-radius:6px;
      font:inherit;font-size:12px;color:var(--xtd-text);background:var(--xtd-bg);
      border:1px solid var(--xtd-border)}
    #xtd-panel input[type=number]:focus-visible{outline:2px solid var(--xtd-ring);outline-offset:1px;border-color:transparent}
    #xtd-panel label > span.xtd-limit-label{flex:none}
    #xtd-panel label > span.xtd-limit-note{flex:none;margin-left:auto;font-size:11.5px;color:var(--xtd-muted)}
    #xtd-panel .xtd-progress{margin-bottom:10px;padding:8px 10px;background:var(--xtd-surface);
      border:1px solid var(--xtd-border);border-radius:8px}
    #xtd-panel .xtd-progress-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;
      font-size:12px;color:var(--xtd-text-2)}
    #xtd-panel .xtd-progress-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    #xtd-panel .xtd-progress-time{flex:none;font-size:11.5px;color:var(--xtd-muted);font-variant-numeric:tabular-nums}
    #xtd-panel .xtd-cancel{flex:none;min-height:24px;padding:0 9px;border-radius:999px;
      font-size:11.5px;font-weight:500;color:var(--xtd-warn);background:transparent;border-color:var(--xtd-border)}
    #xtd-panel .xtd-cancel:hover:not(:disabled){background:rgba(251,191,36,.12);border-color:var(--xtd-warn)}
    #xtd-panel .xtd-progress-track{height:6px;border-radius:999px;overflow:hidden;background:var(--xtd-surface-2)}
    #xtd-panel .xtd-progress-bar{width:100%;height:100%;border-radius:inherit;background:var(--xtd-accent);
      transform:scaleX(0);transform-origin:left center;transition:transform .2s ease-out}
    #xtd-panel .xtd-progress-bar.indeterminate{width:38%;transform:translateX(-100%);
      animation:xtd-indeterminate 1.1s ease-in-out infinite}
    @keyframes xtd-indeterminate{from{transform:translateX(-100%)}to{transform:translateX(320%)}}
    #xtd-panel .xtd-tip{margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:12px;
      color:var(--xtd-text-2);background:var(--xtd-surface);border:1px solid var(--xtd-border)}
    #xtd-panel .xtd-tip-ok{color:var(--xtd-ok);border-color:rgba(74,222,128,.35)}
    #xtd-panel .xtd-tip-warn{color:var(--xtd-warn);border-color:rgba(251,191,36,.35)}
    #xtd-panel .xtd-tip-error{color:var(--xtd-danger);border-color:rgba(248,113,113,.35)}
    #xtd-panel .xtd-results{display:none;margin-bottom:10px;background:var(--xtd-surface);
      border:1px solid var(--xtd-border);border-radius:8px;overflow:hidden}
    #xtd-panel .xtd-results.active{display:block}
    #xtd-panel .xtd-results-head{display:flex;align-items:center;gap:8px;padding:6px 10px;
      font-size:12px;color:var(--xtd-muted);border-bottom:1px solid var(--xtd-border)}
    #xtd-panel .xtd-results-head label{flex:none;color:var(--xtd-text-2)}
    #xtd-panel .xtd-results-title{flex:1;min-width:0;font-weight:500;color:var(--xtd-text-2)}
    #xtd-panel .xtd-selected-count{flex:none;color:var(--xtd-muted);font-variant-numeric:tabular-nums}
    #xtd-panel .xtd-list{max-height:clamp(132px,26vh,220px);overflow:auto;overscroll-behavior:contain}
    #xtd-panel .xtd-item{display:flex;gap:9px;align-items:flex-start;padding:8px 10px;min-height:0;
      border-bottom:1px solid rgba(51,65,85,.55);cursor:pointer;transition:background-color .12s ease-out}
    #xtd-panel .xtd-item:hover{background:var(--xtd-surface-2)}
    #xtd-panel .xtd-item:last-child{border-bottom:0}
    #xtd-panel .xtd-item input{margin:3px 0 0}
    #xtd-panel .xtd-item-main{display:block;flex:1;min-width:0}
    #xtd-panel .xtd-item-name{display:block;font-size:12.5px;color:var(--xtd-text);word-break:break-word}
    #xtd-panel .xtd-item-meta{display:flex;flex-wrap:wrap;gap:4px 6px;margin-top:3px}
    #xtd-panel .xtd-badge{max-width:100%;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;
      color:var(--xtd-muted);background:var(--xtd-bg);border:1px solid var(--xtd-border);
      overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    #xtd-panel .xtd-empty{display:flex;flex-direction:column;align-items:center;gap:4px;
      padding:20px 14px;font-size:12px;line-height:1.6;text-align:center;color:var(--xtd-muted)}
    #xtd-panel .xtd-empty svg{width:28px;height:28px;margin-bottom:2px;opacity:.55}
    #xtd-panel .xtd-empty b{font-size:12.5px;font-weight:600;color:var(--xtd-text-2)}
    #xtd-panel .xtd-log{margin:0;padding:8px 10px;max-height:clamp(96px,20vh,160px);overflow:auto;
      color:var(--xtd-muted);background:var(--xtd-bg);border-top:1px solid var(--xtd-border);
      font:11.5px/1.65 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
      white-space:pre-wrap;word-break:break-all;overscroll-behavior:contain}
    #xtd-panel .xtd-foot{display:flex;align-items:center;gap:10px;font-size:11.5px;color:var(--xtd-muted)}
    #xtd-panel .xtd-foot-spacer{flex:1}
    #xtd-panel .xtd-link{min-height:24px;padding:0;background:none;border:0;border-radius:0;
      font-size:11.5px;font-weight:500;color:var(--xtd-muted);text-decoration:underline;text-underline-offset:2px}
    #xtd-panel .xtd-link:hover{color:var(--xtd-text)}
    @media (pointer:coarse){
      #xtd-panel button{min-height:44px}
      #xtd-panel .xtd-icon-btn{width:44px;min-height:44px}
      #xtd-panel label{min-height:40px}
    }
    @media (prefers-reduced-motion:reduce){
      #xtd-panel,#xtd-panel *{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
    }
  `);

  let ui = {};
  let logLines = [];
  let logRaf = 0;
  let busyTimer = 0;
  let busyStart = 0;
  const LOG_MAX_LINES = 300;

  function buildUI() {
    if ($("#xtd-panel")) return;
    const panel = document.createElement("div");
    panel.id = "xtd-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "课件抓取器面板");
    panel.innerHTML = `
      <div class="xtd-head" title="拖动标题栏可移动面板">
        <span class="xtd-dot" aria-hidden="true"></span>
        <b class="xtd-title">课件抓取器</b>
        <span class="xtd-ver" id="xtd-ver"></span>
        <button type="button" class="xtd-icon-btn" id="xtd-collapse" aria-expanded="true" aria-controls="xtd-body" aria-label="收起面板" title="收起面板">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      </div>
      <div class="xtd-body" id="xtd-body">
        <div class="xtd-ctx" id="xtd-ctx"><span class="xtd-ctx-line">正在识别课程…</span></div>
        <div class="xtd-actions">
          <button type="button" class="xtd-primary xtd-span" id="xtd-scan">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M3 12h18"/></svg>
            <span id="xtd-scan-label">检测本页</span>
          </button>
          <button type="button" class="xtd-secondary" id="xtd-download" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
            下载选中
          </button>
          <button type="button" class="xtd-ghost" id="xtd-all" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>
            全部下载
          </button>
        </div>
        <details class="xtd-opts" id="xtd-opts">
          <summary>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
            高级选项
            <span class="xtd-opts-badge" id="xtd-opts-badge" hidden></span>
          </summary>
          <div class="xtd-opts-body">
            <label><input type="checkbox" id="xtd-all-ch"><span>扫描整门课程（较慢，有风控风险）</span></label>
            <label><input type="checkbox" id="xtd-leaf" checked><span>包含课时详情（学堂在线）</span></label>
            <label><input type="checkbox" id="xtd-pptx" checked><span>同时导出 PPTX</span></label>
            <label><input type="checkbox" id="xtd-pics" checked><span>收集本页正文图片</span></label>
            <label class="xtd-limit-row"><span class="xtd-limit-label">课时上限</span><input type="number" id="xtd-limit" value="0" min="0" step="1" aria-label="课时上限"><span class="xtd-limit-note">0 = 不限</span></label>
          </div>
        </details>
        <div class="xtd-progress" id="xtd-progress" hidden>
          <div class="xtd-progress-head">
            <span class="xtd-progress-label" id="xtd-progress-label">准备中…</span>
            <span class="xtd-progress-time" id="xtd-progress-time"></span>
            <button type="button" class="xtd-cancel" id="xtd-cancel" hidden>取消</button>
          </div>
          <div class="xtd-progress-track">
            <div class="xtd-progress-bar" id="xtd-progress-bar" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100"></div>
          </div>
        </div>
        <div class="xtd-tip" id="xtd-tip" role="status" aria-live="polite" hidden></div>
        <div class="xtd-results" id="xtd-results">
          <div class="xtd-results-head">
            <label><input type="checkbox" id="xtd-selectall"><span>全选</span></label>
            <span class="xtd-results-title">检测结果</span>
            <span class="xtd-selected-count" id="xtd-selected-count">0/0</span>
          </div>
          <div class="xtd-list" id="xtd-list" role="group" aria-label="检测结果列表"></div>
        </div>
        <details class="xtd-logbox" id="xtd-logbox">
          <summary>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
            运行日志
          </summary>
          <pre class="xtd-log" id="xtd-log" aria-label="运行日志"></pre>
        </details>
        <div class="xtd-foot">
          <button type="button" class="xtd-link" id="xtd-clear-log">清空日志</button>
          <span class="xtd-foot-spacer"></span>
          <button type="button" class="xtd-link" id="xtd-update">检查更新</button>
        </div>
      </div>`;
    document.body.appendChild(panel);

    const q = (sel) => panel.querySelector(sel);
    ui = {
      panel,
      head: q(".xtd-head"),
      collapse: q("#xtd-collapse"),
      version: q("#xtd-ver"),
      ctx: q("#xtd-ctx"),
      scan: q("#xtd-scan"),
      scanLabel: q("#xtd-scan-label"),
      download: q("#xtd-download"),
      all: q("#xtd-all"),
      allCh: q("#xtd-all-ch"),
      leaf: q("#xtd-leaf"),
      pptx: q("#xtd-pptx"),
      pics: q("#xtd-pics"),
      limit: q("#xtd-limit"),
      optsBadge: q("#xtd-opts-badge"),
      progress: q("#xtd-progress"),
      progressLabel: q("#xtd-progress-label"),
      progressTime: q("#xtd-progress-time"),
      progressBar: q("#xtd-progress-bar"),
      cancel: q("#xtd-cancel"),
      tip: q("#xtd-tip"),
      results: q("#xtd-results"),
      list: q("#xtd-list"),
      selectAll: q("#xtd-selectall"),
      selectedCount: q("#xtd-selected-count"),
      logbox: q("#xtd-logbox"),
      log: q("#xtd-log"),
      clearLog: q("#xtd-clear-log"),
      update: q("#xtd-update"),
    };
    ui.optInputs = [ui.allCh, ui.leaf, ui.pptx, ui.pics, ui.limit].filter(Boolean);
    ui.version.textContent = "v" + SCRIPT_VERSION;

    setupDrag(panel, ui.head);
    setupInteractions();
    restorePanelState();
  }

  function setCollapsed(collapsed) {
    ui.panel.classList.toggle("collapsed", collapsed);
    ui.collapse.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "展开面板" : "收起面板";
    ui.collapse.setAttribute("aria-label", label);
    ui.collapse.title = label;
    try { GM_setValue("panelCollapsed", collapsed); } catch (e) { /* 忽略 */ }
  }

  // 拖动用 Pointer Events + 指针捕获 + rAF：鼠标/触控通用，拖拽期间只改 transform
  function setupDrag(panel, head) {
    let drag = null;
    let raf = 0;

    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        id: e.pointerId, sx: e.clientX, sy: e.clientY,
        left: rect.left, top: rect.top, moved: false,
        lastLeft: rect.left, lastTop: rect.top,
      };
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });

    head.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      const maxL = Math.max(0, window.innerWidth - panel.offsetWidth - 12);
      const maxT = Math.max(0, window.innerHeight - panel.offsetHeight - 12);
      drag.lastLeft = Math.min(maxL, Math.max(0, drag.left + dx));
      drag.lastTop = Math.min(maxT, Math.max(0, drag.top + dy));
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (!drag) return;
          panel.style.transform = `translate3d(${drag.lastLeft - drag.left}px, ${drag.lastTop - drag.top}px, 0)`;
        });
      }
    });

    const endDrag = () => {
      if (!drag) return;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      panel.style.transform = "";
      if (drag.moved) {
        panel.style.left = drag.lastLeft + "px";
        panel.style.top = drag.lastTop + "px";
        try {
          GM_setValue("panelPos", { left: Math.round(drag.lastLeft), top: Math.round(drag.lastTop) });
        } catch (e) { /* 忽略 */ }
      }
      drag = null;
    };
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);

    // 换屏、展开选项、结果变多都会改变面板尺寸，统一拉回视口内，避免底部按钮被挤出屏幕
    window.addEventListener("resize", () => clampPanelIntoView(panel));
    try {
      if (typeof ResizeObserver === "function") {
        new ResizeObserver(() => clampPanelIntoView(panel)).observe(panel);
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 拖动过（有内联 left）才需要钳制；默认 right/bottom 定位天然贴边 */
  function clampPanelIntoView(panel) {
    if (!panel.style.left) return;
    const rect = panel.getBoundingClientRect();
    const maxL = Math.max(0, window.innerWidth - rect.width - 12);
    const maxT = Math.max(0, window.innerHeight - rect.height - 12);
    const left = Math.min(maxL, Math.max(0, rect.left));
    const top = Math.min(maxT, Math.max(0, rect.top));
    if (left !== rect.left || top !== rect.top) {
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    }
  }

  function restorePanelState() {
    const pos = GM_getValue("panelPos", null);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      const maxL = Math.max(0, window.innerWidth - ui.panel.offsetWidth - 12);
      const maxT = Math.max(0, window.innerHeight - ui.panel.offsetHeight - 12);
      ui.panel.style.right = "auto";
      ui.panel.style.bottom = "auto";
      ui.panel.style.left = Math.min(maxL, Math.max(0, pos.left)) + "px";
      ui.panel.style.top = Math.min(maxT, Math.max(0, pos.top)) + "px";
    }
    let collapsed = false;
    try { collapsed = GM_getValue("panelCollapsed", false) === true; } catch (e) { /* 忽略 */ }
    setCollapsed(collapsed);
    syncOptsBadge();
  }

  function setupInteractions() {
    ui.collapse.addEventListener("click", () => setCollapsed(!ui.panel.classList.contains("collapsed")));
    ui.scan.addEventListener("click", doScan);
    ui.download.addEventListener("click", () => doDownload(false));
    ui.all.addEventListener("click", () => doDownload(true));
    ui.cancel.addEventListener("click", requestCancel);
    ui.clearLog.addEventListener("click", clearLog);
    ui.update.addEventListener("click", checkForUpdate);
    ui.allCh.addEventListener("change", syncOptsBadge);
    ui.selectAll.addEventListener("change", () => {
      if (ui.selectAll.checked) state.selected = new Set(state.groups.map((_, i) => i));
      else state.selected.clear();
      ui.list.querySelectorAll("input[data-gi]").forEach((cb) => { cb.checked = ui.selectAll.checked; });
      updateSelectionUI();
    });
    ui.list.addEventListener("change", (e) => {
      const cb = e.target && e.target.closest ? e.target.closest("input[data-gi]") : null;
      if (!cb) return;
      const i = Number(cb.dataset.gi);
      if (cb.checked) state.selected.add(i);
      else state.selected.delete(i);
      updateSelectionUI();
    });
  }

  function syncOptsBadge() {
    if (!ui.optsBadge || !ui.allCh) return;
    const on = ui.allCh.checked;
    ui.optsBadge.textContent = on ? "整门课程" : "";
    ui.optsBadge.hidden = !on;
  }

  function setTip(text, kind) {
    if (!ui.tip) return;
    ui.tip.textContent = text || "";
    ui.tip.className = "xtd-tip" + (kind ? " xtd-tip-" + kind : "");
    ui.tip.hidden = !text;
  }

  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
  }

  function setProgress(done, total, label) {
    if (!ui.progressBar) return;
    if (label) ui.progressLabel.textContent = label;
    const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    ui.progressBar.classList.toggle("indeterminate", !(total > 0));
    if (total > 0) {
      ui.progressBar.style.transform = "scaleX(" + ratio + ")";
      ui.progressBar.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    } else {
      ui.progressBar.style.transform = "";
      ui.progressBar.removeAttribute("aria-valuenow");
    }
  }

  function setBusy(running, label) {
    state.running = running;
    if (!ui.progress) return;
    ui.progress.hidden = !running;
    ui.cancel.hidden = !running;
    if (running) {
      state.cancelRequested = false;
      ui.cancel.disabled = false;
      ui.progressTime.textContent = "0s";
      busyStart = Date.now();
      clearInterval(busyTimer);
      busyTimer = setInterval(() => {
        if (ui.progressTime) ui.progressTime.textContent = formatElapsed(Date.now() - busyStart);
      }, 1000);
      setProgress(0, 0, label || "处理中…");
    } else {
      clearInterval(busyTimer);
      busyTimer = 0;
      ui.progressBar.classList.remove("indeterminate");
      ui.progressBar.style.transform = "scaleX(0)";
      ui.progressBar.removeAttribute("aria-valuenow");
      ui.progressTime.textContent = "";
      ui.scanLabel.textContent = "检测本页";
    }
    ui.optInputs.forEach((el) => { el.disabled = running; });
    updateSelectionUI();
  }

  function updateSelectionUI() {
    if (!ui.results) return;
    const total = state.groups.length;
    const count = state.selected.size;
    ui.selectedCount.textContent = count + "/" + total;
    ui.selectAll.checked = total > 0 && count === total;
    ui.selectAll.indeterminate = count > 0 && count < total;
    ui.selectAll.disabled = state.running || total === 0;
    ui.scan.disabled = state.running || state.canScan === false;
    ui.download.disabled = state.running || count === 0;
    ui.all.disabled = state.running || total === 0;
  }

  function requestCancel() {
    if (!state.running || state.cancelRequested) return;
    state.cancelRequested = true;
    ui.cancel.disabled = true;
    setTip("正在取消…当前网络请求结束后会停下", "warn");
    log("已请求取消");
  }

  // 日志：rAF 合帧 + 最多保留 300 行，长时间抓取不会无限涨内存
  function log(msg) {
    if (!ui.log) { console.log("[xtd]", msg); return; }
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    logLines.push("[" + t + "] " + msg);
    if (logLines.length > LOG_MAX_LINES) logLines.splice(0, logLines.length - LOG_MAX_LINES);
    if (!logRaf) logRaf = requestAnimationFrame(flushLog);
  }

  function flushLog() {
    logRaf = 0;
    if (!ui.log) return;
    const nearBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 24;
    ui.log.textContent = logLines.join("\n");
    if (nearBottom) ui.log.scrollTop = ui.log.scrollHeight;
  }

  function clearLog() {
    logLines = [];
    if (logRaf) { cancelAnimationFrame(logRaf); logRaf = 0; }
    if (ui.log) ui.log.textContent = "";
  }

  function renderList() {
    if (!ui.list) return;
    const frag = document.createDocumentFragment();
    if (!state.groups.length) {
      const empty = document.createElement("div");
      empty.className = "xtd-empty";
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>' +
        "<b>" + (state.scanned ? "没有检测到 PPT / PDF" : "还没有检测结果") + "</b>" +
        "<span>" + (state.scanned ? "这个范围可能只有视频或测验。" : "点「检测本页」开始扫描。") + "</span>";
      frag.appendChild(empty);
    } else {
      state.groups.forEach((g, i) => {
        const row = document.createElement("label");
        row.className = "xtd-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = state.selected.has(i);
        cb.dataset.gi = String(i);
        const main = document.createElement("span");
        main.className = "xtd-item-main";
        const name = document.createElement("span");
        name.className = "xtd-item-name";
        name.textContent = g.name || g.chapter || "(无名章节)";
        const meta = document.createElement("span");
        meta.className = "xtd-item-meta";
        const count = document.createElement("span");
        count.className = "xtd-badge";
        count.textContent = g.items.length + " 个资源";
        meta.appendChild(count);
        if (g.chapter && g.chapter !== g.name) {
          const ch = document.createElement("span");
          ch.className = "xtd-badge";
          ch.textContent = g.chapter;
          ch.title = g.chapter;
          meta.appendChild(ch);
        }
        main.append(name, meta);
        row.append(cb, main);
        frag.appendChild(row);
      });
    }
    ui.list.replaceChildren(frag);
    updateSelectionUI();
  }

  async function doScan() {
    if (state.running) return;
    const ctx = state.ctx;
    if (!ctxOk(ctx)) {
      setTip("当前页面没有课程上下文，请在课程学习页使用。", "error");
      log("没有识别到课程上下文");
      return;
    }
    setTip("");
    state.canScan = true;
    setBusy(true, "正在检测…");
    ui.scanLabel.textContent = "检测中…";
    state.groups = [];
    state.selected = new Set();
    state.scanned = false;
    ui.results.classList.remove("active");
    renderList();
    ui.logbox.open = true;
    log("— 开始扫描 —");
    try {
      const opts = {
        withLeaf: ui.leaf.checked,
        leafLimit: parseInt(ui.limit.value || "0", 10) || 0,
        makePptx: ui.pptx.checked,
        allChapters: !!(ui.allCh && ui.allCh.checked),
        pageImages: !!(ui.pics && ui.pics.checked),
        onProgress: (done, total, label) => {
          if (!state.cancelRequested) setProgress(done, total, label);
        },
      };
      const groups = await collectAll(ctx, opts);
      state.scanned = true;
      state.groups = groups;
      state.selected = new Set(groups.map((_, i) => i));
      ui.results.classList.add("active");
      renderList();
      // 目录树是异步渲染的，boot 时取不到章节名，这里补一次
      refreshCtx();
      if (state.cancelRequested) {
        log("扫描已取消");
        setTip("已取消扫描" + (groups.length ? "，保留已发现的 " + groups.length + " 个章节" : ""), "warn");
      } else {
        const scope = SITE === "chaoxing"
          ? (opts.allChapters ? "全课程扫描完成" : "本页检测完成")
          : "扫描完成";
        log(`${scope}：${groups.length} 个章节含文档`);
        if (groups.length) {
          setTip(`${scope}，共 ${groups.length} 个章节`, "ok");
        } else if (SITE === "chaoxing") {
          setTip(opts.allChapters
            ? "没扫到 PPT/PDF。这门课可能只有视频，没有讲义。"
            : "本页没有 PPT/PDF。这个章节可能只有视频或测验。", "warn");
        } else {
          setTip("没扫到 PPT/PDF。可能该课程未上传讲义，或文档藏在其它接口。", "warn");
        }
      }
    } catch (e) {
      log("扫描出错: " + e.message);
      setTip("扫描出错: " + e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function doDownload(all) {
    if (state.running) return;
    if (!state.groups.length) {
      setTip("先点「检测本页」扫描出可下载的资源。", "warn");
      return;
    }
    const groups = all ? state.groups.slice() : state.groups.filter((_, i) => state.selected.has(i));
    if (!groups.length) {
      setTip("没有选中任何章节，先勾选或点「全选」。", "warn");
      return;
    }

    setTip("");
    setBusy(true, "准备下载…");
    ui.logbox.open = true;
    const opts = { makePptx: ui.pptx.checked };
    let done = 0;
    log(`— 开始下载 ${groups.length} 个章节 —`);
    try {
      for (const g of groups) {
        if (state.cancelRequested) break;
        const label = g.name || g.chapter || "(无名)";
        setProgress(done, groups.length, `正在处理 ${label}（${done + 1}/${groups.length}）`);
        const made = await processGroup(g, opts);
        done++;
        if (state.cancelRequested) break;
        if (!made.length) log(`  [${label}] 没有产出文件`);
        setProgress(done, groups.length, "正在处理 " + label);
      }
      if (state.cancelRequested) {
        log(`下载已取消，完成 ${done}/${groups.length}`);
        setTip(`已取消：完成 ${done}/${groups.length} 个章节`, "warn");
      } else {
        setTip(`完成：处理 ${groups.length} 个章节`, "ok");
        log("— 全部完成 —");
      }
    } catch (e) {
      log("下载出错: " + e.message);
      setTip("出错: " + e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  // =====================================================================
  // 9.5 自动更新（菜单一键更新，模式与仓库里的 selection-translator 一致）
  // =====================================================================
  const SCRIPT_NAME = "超星课件抓取器 · PPT/PDF/页面图片 合并导出";
  const SCRIPT_NS = "specdock.my-script.chaoxing-courseware";
  const FALLBACK_VERSION = "1.1.0";
  const SCRIPT_VERSION = (() => {
    try {
      return (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || FALLBACK_VERSION;
    } catch (e) {
      return FALLBACK_VERSION;
    }
  })();

  // 更新源：仓库根目录、master 分支；文件名必须与 metadata 的 updateURL/downloadURL 一致
  const UPDATE = {
    repo: "SpecDock/MyScript",
    file: "chaoxing-courseware.user.js",
    branches: ["master", "main", "develop"],
    timeout: 6000,
    deadline: 10000,
  };

  function cmpVersion(a, b) {
    const parse = (v) =>
      String(v == null ? "" : v)
        .trim()
        .replace(/^v/i, "")
        .split("-")[0]
        .split(".")
        .map((x) => {
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

  function parseMeta(src) {
    const block = String(src || "").slice(0, 30000).match(/==UserScript==([\s\S]*?)==\/UserScript==/);
    if (!block) return null;
    const meta = {};
    const lines = block[1].split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^[^\S\r\n]*\/\/\s*@([\w:-]+)[ \t]+(.+?)[ \t]*$/);
      if (m && !(m[1].toLowerCase() in meta)) meta[m[1].toLowerCase()] = m[2];
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
    return String(p).split("/").map(encodeURIComponent).join("/");
  }

  function rawUrl(branch, path) {
    return "https://raw.githubusercontent.com/" + UPDATE.repo + "/" + encodeURIComponent(branch) + "/" + encodePath(path);
  }

  function cdnUrl(branch, path) {
    return "https://cdn.jsdelivr.net/gh/" + UPDATE.repo + "@" + branch + "/" + encodePath(path);
  }

  function withDeadline(promise, ms) {
    let timer = 0;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error("deadline");
        err.network = true;
        reject(err);
      }, ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  async function githubJson(url) {
    const res = await gmRequest(url, {
      responseType: "text",
      timeout: UPDATE.timeout,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status !== 200) throw new Error("github http " + res.status);
    return JSON.parse(res.responseText || "null");
  }

  async function probeMeta(url, bust) {
    try {
      const u = bust ? url + (url.indexOf("?") === -1 ? "?" : "&") + "_=" + Date.now() : url;
      const res = await gmRequest(u, {
        responseType: "text",
        timeout: UPDATE.timeout,
        headers: { Accept: "text/plain, */*" },
      });
      if (res.status !== 200) return { meta: null, network: false };
      const meta = parseMeta(res.responseText || "");
      return { meta: meta && meta.version ? meta : null, network: false };
    } catch (e) {
      return { meta: null, network: true };
    }
  }

  /** 兜底：直接从仓库里找名字匹配的 .user.js */
  async function discoverRemote() {
    const repo = await githubJson("https://api.github.com/repos/" + UPDATE.repo);
    const branch = repo && typeof repo.default_branch === "string" && repo.default_branch ? repo.default_branch : "main";
    const tree = await githubJson(
      "https://api.github.com/repos/" + UPDATE.repo + "/git/trees/" + encodeURIComponent(branch) + "?recursive=1"
    );
    const paths = tree && Array.isArray(tree.tree)
      ? tree.tree
          .filter((x) => x && x.type === "blob" && typeof x.path === "string" && /\.user\.js$/i.test(x.path))
          .map((x) => x.path)
          .slice(0, 12)
      : [];
    if (!paths.length) throw new Error("远程仓库未找到脚本");

    const checks = [];
    for (const path of paths) {
      for (const source of ["raw", "cdn"]) {
        const url = source === "raw" ? rawUrl(branch, path) : cdnUrl(branch, path);
        checks.push(
          (async () => {
            const probe = await probeMeta(url, source === "raw");
            const meta = probe.meta;
            if (meta && meta.version && isSameScript(meta)) {
              return { version: meta.version, url, branch, path, source };
            }
            return null;
          })()
        );
      }
    }
    const found = (await Promise.all(checks)).filter(Boolean);
    if (!found.length) throw new Error("远程仓库未找到匹配脚本");
    return found[0];
  }

  /** 主源优先：只发 1 个请求；失败后再并行探测其余分支/镜像 */
  async function fetchLatestFromGitHub() {
    const primaryBranch = UPDATE.branches[0];
    const primaryUrl = rawUrl(primaryBranch, UPDATE.file);
    const primary = await probeMeta(primaryUrl, true);
    if (primary.meta && primary.meta.version) {
      return { version: primary.meta.version, url: primaryUrl, branch: primaryBranch, path: UPDATE.file, source: "raw" };
    }

    const candidates = [];
    for (const branch of UPDATE.branches) {
      for (const source of ["raw", "cdn"]) {
        if (branch === primaryBranch && source === "raw") continue;
        candidates.push({
          branch,
          path: UPDATE.file,
          source,
          url: source === "raw" ? rawUrl(branch, UPDATE.file) : cdnUrl(branch, UPDATE.file),
        });
      }
    }
    const results = await Promise.all(
      candidates.map(async (c) => {
        const probe = await probeMeta(c.url, c.source === "raw");
        return { candidate: c, meta: probe.meta, network: probe.network };
      })
    );
    const hit = results.find((r) => r.meta && r.meta.version);
    if (hit) {
      const c = hit.candidate;
      return { version: hit.meta.version, url: c.url, branch: c.branch, path: c.path, source: c.source };
    }
    const reachable = !primary.network || results.some((r) => !r.network);
    if (!reachable) {
      const err = new Error("github unreachable");
      err.network = true;
      throw err;
    }
    return discoverRemote();
  }

  let updateChecking = false;

  async function checkForUpdate() {
    if (updateChecking) {
      log("正在检查更新…");
      return;
    }
    updateChecking = true;
    log("正在检查更新…");
    try {
      const latest = await withDeadline(fetchLatestFromGitHub(), UPDATE.deadline);
      if (!latest || !latest.version || cmpVersion(latest.version, SCRIPT_VERSION) <= 0) {
        log("已是最新版本 v" + SCRIPT_VERSION);
        setTip("已是最新版本 v" + SCRIPT_VERSION, "ok");
        return;
      }
      log(`发现新版本 v${latest.version}，正在打开安装页…`);
      setTip(`发现新版本 v${latest.version}，正在打开安装页`, "ok");
      window.open(latest.url, "_blank", "noopener");
    } catch (e) {
      log("检查更新失败：" + (e && e.message ? e.message : e));
      setTip(
        e && e.network
          ? "检查失败：网络异常或访问 GitHub 超时，请检查网络后重试。"
          : "检查失败：未能获取版本信息，请稍后重试。",
        "error"
      );
    } finally {
      updateChecking = false;
    }
  }

  // =====================================================================
  // 10. 启动
  // =====================================================================
  /** 课程上下文是否够用（两个站点的必需字段不一样） */
  function ctxOk(ctx) {
    if (!ctx) return false;
    if (ctx.site === "chaoxing") return !!ctx.courseid;  // clazzid 缺失时可后补
    return !!ctx.cid;
  }

  /** 面板顶部的上下文行（学习通） */
  function cxCtxHtml(ctx, curTitle) {
    const chapter = curTitle || ctx.knowledgeid || "";
    const line1 =
      '<span class="xtd-ctx-line">学习通 · courseid=<b>' + escapeHtml(ctx.courseid) + "</b>" +
      (chapter ? " · 当前章节 <b>" + escapeHtml(chapter) + "</b>" : "") +
      "</span>";
    const hint = curTitle
      ? "默认只检测本页的 PPT/PDF；要抓整门课程请展开「高级选项」勾选「扫描整门课程」。"
      : "章节目录尚未渲染时，点「检测本页」即可；要抓整门课程请展开「高级选项」。";
    return line1 + '<span class="xtd-ctx-line xtd-ctx-hint" style="opacity:.78">' + hint + "</span>";
  }

  /** 刷新上下文行：目录树是异步渲染的，扫描完成后再尝试补章节名 */
  function refreshCtx() {
    const ctx = state.ctx;
    if (!ctx || !ui.ctx) return;
    if (ctx.site === "chaoxing") {
      const curTitle = ctx.knowledgeid ? cxCurrentChapterTitle(ctx.knowledgeid) : "";
      ui.ctx.innerHTML = cxCtxHtml(ctx, curTitle);
      ui.ctx.title = "courseid " + ctx.courseid + (curTitle ? " · " + curTitle : "");
    }
  }

  function boot() {
    buildUI();
    try {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("检查更新", checkForUpdate);
        GM_registerMenuCommand("重新检测本页", () => {
          log("—— 重新检测本页 ——");
          doScan();
        });
      }
    } catch (e) { /* 忽略 */ }
    state.ctx = parseCtx();
    const ctx = state.ctx;
    if (ctx && ctx.site === "chaoxing") {
      state.canScan = true;
      refreshCtx();
      log("已识别学习通课程上下文");
    } else if (ctx && ctx.cid) {
      state.canScan = true;
      ui.ctx.innerHTML =
        '<span class="xtd-ctx-line">课程 sign=<b>' + escapeHtml(ctx.sign) + "</b> · cid=<b>" + escapeHtml(ctx.cid) + "</b></span>" +
        (ctx.leafId
          ? '<span class="xtd-ctx-line">当前课时 <b>' + escapeHtml(ctx.leafId) + "</b>（" + escapeHtml(ctx.kind) + "）</span>"
          : "");
      ui.ctx.title = "sign " + ctx.sign + " · cid " + ctx.cid;
      log("已识别课程上下文");
    } else {
      state.canScan = false;
      ui.ctx.innerHTML =
        '<span class="xtd-ctx-line">当前页面未识别到课程</span>' +
        '<span class="xtd-ctx-line" style="opacity:.78">请先打开课程学习页（需要课程 ID）。</span>';
      log("未识别到课程上下文");
    }
    // 记住上次选项
    const save = () => {
      GM_setValue("opts", {
        leaf: ui.leaf.checked, pptx: ui.pptx.checked, limit: ui.limit.value,
        allCh: ui.allCh ? ui.allCh.checked : false,
        pics: ui.pics ? ui.pics.checked : true,
      });
    };
    ui.optInputs.forEach((el) => el.addEventListener("change", save));
    const saved = GM_getValue("opts", null);
    if (saved) {
      ui.leaf.checked = saved.leaf !== false;
      ui.pptx.checked = saved.pptx !== false;
      if (ui.allCh) ui.allCh.checked = saved.allCh === true;   // 默认只检测本页
      if (ui.pics) ui.pics.checked = saved.pics !== false;     // 默认收集本页图片
      if (saved.limit) ui.limit.value = saved.limit;
    }
    syncOptsBadge();
    updateSelectionUI();
  }

  // 调试钩子：直接调内部函数（页面图收集 / 高清地址换算 / 版本比较 / 列表渲染）
  // 放在 IIFE 末尾赋值：上面的 const 声明这时已经完成初始化，避免 TDZ 报错
  if (typeof window !== "undefined") {
    window.__XTD_DEBUG = { cxCollectPageImages, cxHiResUrl, cmpVersion, parseMeta, UPDATE, renderList, refreshCtx };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { safeName, escapeHtml, extOf, isImg, isDoc, resolveUrl, scanJson, collectLeafIds, groupNameOf, randomName, sniffBytes, buildLeafLabels, attachAttname, SITE, cxParseChapters, cxParseAttachments, cxResolveUrl, cxHiResUrl, ctxOk, buildUrl, cmpVersion, parseMeta, isSameScript, UPDATE };
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
