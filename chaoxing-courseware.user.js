// ==UserScript==
// @name         超星课件抓取器 · PPT/PDF/页面图片 合并导出
// @namespace    specdock.my-script.chaoxing-courseware
// @version      1.0.0
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
    groups: [],          // {chapter, items:[{url,kind,name,pages:[]}], selected}
    running: false,
    warnedPerm: false,   // 跨源授权框只提醒一次
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

  function bytesToDataUrl(bytes, mime) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return `data:${mime};base64,${btoa(bin)}`;
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

  function sniff(blob, url) {
    return blob.slice(0, 8).arrayBuffer().then((buf) => sniffBytes(new Uint8Array(buf), url));
  }

  async function loadImages(urls, referer) {
    const out = [];
    for (const u of urls) {
      try {
        const r = await gmRequest(u, {
          responseType: "blob",
          headers: referer ? { Referer: referer } : {},
        });
        const bytes = await blobToBytes(r.response);
        const kind = await sniff(r.response, u);
        const mime = kind === "png" ? "image/png" : "image/jpeg";
        out.push({ url: u, bytes, mime, dataUrl: bytesToDataUrl(bytes, mime) });
      } catch (e) {
        log(`  图片失败 ${shortUrl(u)}: ${e.message}`);
      }
    }
    return out;
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
      const slide = pptx.addSlide();
      let w = 13.333, h = 7.5;
      try {
        const dim = await imageSize(img.dataUrl);
        const scale = Math.min(w / dim.w, h / dim.h);
        w = dim.w * scale;
        h = dim.h * scale;
      } catch (e) { /* 用整版 */ }
      slide.addImage({ data: img.dataUrl, x: (13.333 - w) / 2, y: (7.5 - h) / 2, w: w, h: h });
    }
    const buf = await pptx.write({ outputType: "arraybuffer" });
    return new Uint8Array(buf);
  }

  function imageSize(dataUrl) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = rej;
      im.src = dataUrl;
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
      // 串行 + 间隔：超星会把多章节同时打开判为异常
      if (i < limit - 1) await sleep(1000);
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
      if (item.kind === "pages") {
        log(`  [${label}] 抓 ${item.pages.length} 页幻灯片 …`);
        const imgs = await loadImages(item.pages, item.referer);
        imageSources.push(...imgs);
        continue;
      }
      // 超星有多个候选下载地址（download / pdf / http），逐个探测回退
      const cands = item.urls && item.urls.length ? item.urls : [item.url];
      const isDoc = (k) => k === "pdf" || k === "zip" || k === "ole" || k === "png" || k === "jpg";
      let done = false;
      for (const cand of cands) {
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
                dataUrl: bytesToDataUrl(bytes, kind === "png" ? "image/png" : "image/jpeg"),
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
    #xtd-panel{position:fixed;right:16px;bottom:16px;width:330px;z-index:2147483000;
      font:12px/1.6 -apple-system,"Microsoft YaHei",sans-serif;color:#e8ecf1;
      background:#1c2128;border:1px solid #333c47;border-radius:10px;
      box-shadow:0 8px 32px rgba(0,0,0,.45);overflow:hidden;}
    #xtd-panel.collapsed .xtd-body{display:none}
    #xtd-panel .xtd-head{display:flex;align-items:center;gap:8px;padding:9px 12px;
      background:#242b34;border-bottom:1px solid #333c47;cursor:move;user-select:none}
    #xtd-panel .xtd-head b{font-size:13px;flex:1}
    #xtd-panel .xtd-head .xtd-toggle{opacity:.65;font-size:15px}
    #xtd-panel .xtd-body{padding:10px 12px 12px;max-height:62vh;overflow:auto}
    #xtd-panel .xtd-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
    #xtd-panel button{background:#2f6fd0;color:#fff;border:0;border-radius:5px;
      padding:6px 11px;font-size:12px;cursor:pointer;font-family:inherit}
    #xtd-panel button:hover{background:#3f83ea}
    #xtd-panel button:disabled{background:#48505b;cursor:not-allowed}
    #xtd-panel button.ghost{background:#3a424d}
    #xtd-panel label{display:inline-flex;align-items:center;gap:4px;margin-right:8px;color:#b9c2cd}
    #xtd-panel .xtd-ctx{color:#8b96a5;margin-bottom:8px;word-break:break-all}
    #xtd-panel .xtd-list{font-size:11.5px;margin:6px 0;max-height:190px;overflow:auto;
      border:1px solid #333c47;border-radius:6px;padding:6px;background:#171b20}
    #xtd-panel .xtd-item{display:flex;gap:6px;align-items:flex-start;padding:3px 2px;border-bottom:1px solid #232a32}
    #xtd-panel .xtd-item:last-child{border-bottom:0}
    #xtd-panel .xtd-item input{margin:3px 0 0}
    #xtd-panel .xtd-item span{flex:1;word-break:break-all}
    #xtd-panel .xtd-item em{font-style:normal;color:#7b8695;font-size:10.5px}
    #xtd-panel .xtd-log{margin-top:8px;font-size:11px;color:#93a0b0;
      background:#12161b;border:1px solid #2b333d;border-radius:6px;padding:6px;
      max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all}
    #xtd-panel .xtd-tip{color:#d4a04a;margin:6px 0}
  `);

  let ui = {};

  function buildUI() {
    if ($("#xtd-panel")) return;
    const panel = document.createElement("div");
    panel.id = "xtd-panel";
    panel.innerHTML = `
      <div class="xtd-head">
        <b>课件抓取器</b>
        <span class="xtd-toggle">▾</span>
      </div>
      <div class="xtd-body">
        <div class="xtd-ctx">正在识别课程…</div>
        <div class="xtd-row">
          <button id="xtd-scan">检测本页</button>
          <button id="xtd-download" class="ghost" disabled>下载选中</button>
          <button id="xtd-all" class="ghost">全部下载</button>
        </div>
        <div class="xtd-row">
          <label><input type="checkbox" id="xtd-all-ch">扫描整门课程</label>
          <label><input type="checkbox" id="xtd-leaf" checked>含课时详情</label>
          <label><input type="checkbox" id="xtd-pptx" checked>同时出 PPTX</label>
        </div>
        <div class="xtd-row">
          <label><input type="checkbox" id="xtd-pics" checked>收集本页图片</label>
          <label>课时上限 <input type="number" id="xtd-limit" value="0" style="width:52px"> (0=不限)</label>
        </div>
        <div class="xtd-list" id="xtd-list"></div>
        <div class="xtd-tip" id="xtd-tip"></div>
        <div class="xtd-log" id="xtd-log"></div>
      </div>`;
    document.body.appendChild(panel);

    // ---- 面板可拖动：按住标题栏拖，位置会记住；单击标题栏仍然折叠/展开 ----
    const head = panel.querySelector(".xtd-head");
    let dragging = false;
    let moved = false;
    let offX = 0;
    let offY = 0;
    let suppressClick = false;

    head.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, a, input, label, select")) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      moved = false;
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const maxL = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxT = Math.max(0, window.innerHeight - 40);
      const left = Math.min(maxL, Math.max(0, e.clientX - offX));
      const top = Math.min(maxT, Math.max(0, e.clientY - offY));
      if (Math.abs(left - panel.offsetLeft) > 2 || Math.abs(top - panel.offsetTop) > 2) moved = true;
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        suppressClick = true;
        try {
          GM_setValue("panelPos", { left: panel.offsetLeft, top: panel.offsetTop });
        } catch (e) { /* 忽略 */ }
      }
    });

    // 恢复上次拖动的位置
    const pos = GM_getValue("panelPos", null);
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = pos.left + "px";
      panel.style.top = pos.top + "px";
    }

    head.addEventListener("click", () => {
      if (suppressClick) { suppressClick = false; return; }   // 刚才是拖动，不是点击
      panel.classList.toggle("collapsed");
      panel.querySelector(".xtd-toggle").textContent = panel.classList.contains("collapsed") ? "▸" : "▾";
    });

    ui = {
      panel,
      ctx: panel.querySelector(".xtd-ctx"),
      scan: panel.querySelector("#xtd-scan"),
      download: panel.querySelector("#xtd-download"),
      all: panel.querySelector("#xtd-all"),
      allCh: panel.querySelector("#xtd-all-ch"),
      leaf: panel.querySelector("#xtd-leaf"),
      pptx: panel.querySelector("#xtd-pptx"),
      pics: panel.querySelector("#xtd-pics"),
      limit: panel.querySelector("#xtd-limit"),
      list: panel.querySelector("#xtd-list"),
      tip: panel.querySelector("#xtd-tip"),
      log: panel.querySelector("#xtd-log"),
    };

    ui.scan.addEventListener("click", doScan);
    ui.download.addEventListener("click", () => doDownload(false));
    ui.all.addEventListener("click", () => doDownload(true));
  }

  function log(msg) {
    if (!ui.log) { console.log("[xtd]", msg); return; }
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    ui.log.textContent += `[${t}] ${msg}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function renderList() {
    ui.list.innerHTML = "";
    state.groups.forEach((g, gi) => {
      const row = document.createElement("div");
      row.className = "xtd-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.gi = gi;
      const sp = document.createElement("span");
      const sub = g.chapter && g.chapter !== g.name ? ` <em>${g.chapter}</em>` : "";
      sp.innerHTML = `${g.name || "(无名)"}<em>${g.items.length} 个资源</em>${sub}`;
      row.appendChild(cb);
      row.appendChild(sp);
      ui.list.appendChild(row);
    });
    ui.download.disabled = state.groups.length === 0;
  }

  async function doScan() {
    if (state.running) return;
    state.running = true;
    ui.scan.disabled = true;
    ui.tip.textContent = "";
    ui.list.innerHTML = "";
    log("— 开始扫描 —");
    try {
      const ctx = state.ctx;
      if (!ctxOk(ctx)) {
        ui.tip.textContent = "当前页面没有课程上下文，请在课程学习页使用。";
        log("没有识别到课程上下文");
        return;
      }
      const opts = {
        withLeaf: ui.leaf.checked,
        leafLimit: parseInt(ui.limit.value || "0", 10) || 0,
        makePptx: ui.pptx.checked,
        allChapters: !!(ui.allCh && ui.allCh.checked),
        pageImages: !!(ui.pics && ui.pics.checked),
      };
      const groups = await collectAll(ctx, opts);
      state.groups = groups;
      renderList();
      // 目录树是异步渲染的，boot 时取不到章节名，这里补一次
      if (SITE === "chaoxing" && !opts.allChapters && ctx.knowledgeid) {
        const t = cxCurrentChapterTitle(ctx.knowledgeid);
        if (t) ui.ctx.innerHTML = cxCtxHtml(ctx, t);
      }
      const scope = SITE === "chaoxing"
        ? (opts.allChapters ? "全课程扫描完成" : "本页检测完成")
        : "扫描完成";
      log(`${scope}：${groups.length} 个章节含文档`);
      if (!groups.length) {
        ui.tip.textContent = SITE === "chaoxing"
          ? (opts.allChapters
            ? "没扫到 PPT/PDF。这门课可能只有视频，没有讲义。"
            : "本页没有 PPT/PDF。这个章节可能只有视频或测验。")
          : "没扫到 PPT/PDF。可能该课程未上传讲义，或文档藏在其它接口。";
      }
    } catch (e) {
      log("扫描出错: " + e.message);
      ui.tip.textContent = "扫描出错: " + e.message;
    } finally {
      state.running = false;
      ui.scan.disabled = false;
    }
  }

  async function doDownload(all) {
    if (state.running) return;
    const groups = all
      ? state.groups
      : state.groups.filter((_, i) => {
          const cb = ui.list.querySelector(`input[data-gi="${i}"]`);
          return cb && cb.checked;
        });
    if (!groups.length) { ui.tip.textContent = "没有选中任何章节"; return; }

    state.running = true;
    ui.all.disabled = true;
    ui.download.disabled = true;
    ui.tip.textContent = "";
    const opts = { makePptx: ui.pptx.checked };
    let n = 0;
    try {
      for (const g of groups) {
        ui.tip.textContent = `正在处理 ${g.name || g.chapter || "(无名)"} (${n + 1}/${groups.length})`;
        const made = await processGroup(g, opts);
        n++;
        if (!made.length) log(`  [${g.name || g.chapter}] 没有产出文件`);
      }
      ui.tip.textContent = `完成：处理 ${groups.length} 个章节`;
      log("— 全部完成 —");
    } catch (e) {
      log("下载出错: " + e.message);
      ui.tip.textContent = "出错: " + e.message;
    } finally {
      state.running = false;
      ui.all.disabled = false;
      ui.download.disabled = state.groups.length === 0;
    }
  }

  // =====================================================================
  // 9.5 自动更新（菜单一键更新，模式与仓库里的 selection-translator 一致）
  // =====================================================================
  const SCRIPT_NAME = "超星课件抓取器 · PPT/PDF/页面图片 合并导出";
  const SCRIPT_NS = "specdock.my-script.chaoxing-courseware";
  const FALLBACK_VERSION = "1.0.0";
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
        alert("已是最新版本 v" + SCRIPT_VERSION);
        return;
      }
      log(`发现新版本 v${latest.version}，正在打开安装页…`);
      window.open(latest.url, "_blank", "noopener");
    } catch (e) {
      log("检查更新失败：" + (e && e.message ? e.message : e));
      alert(
        e && e.network
          ? "检查失败：网络异常或访问 GitHub 超时，请检查网络后重试。"
          : "检查失败：未能获取版本信息，请稍后重试。"
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
    const line1 =
      `学习通 courseid=<b>${ctx.courseid}</b>` +
      (curTitle
        ? `  当前章节 <b>${curTitle}</b>`
        : (ctx.knowledgeid ? `  当前章节 <b>${ctx.knowledgeid}</b>` : ""));
    const line2 = curTitle
      ? `默认只检测<b>本页</b>的 PPT/PDF；要抓整门课程请勾选「扫描整门课程」`
      : `默认只检测<b>本页</b>的 PPT/PDF（当前章节目录尚未渲染，点「检测本页」即可）；要抓整门课程请勾选「扫描整门课程」`;
    return `${line1}<br><span style="opacity:.72">${line2}</span>`;
  }

  function boot() {
    buildUI();
    try {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("检查更新", checkForUpdate);
        GM_registerMenuCommand("重新收集本页图片", () => {
          log("—— 重新收集本页图片 ——");
          doScan();
        });
      }
    } catch (e) { /* 忽略 */ }
    state.ctx = parseCtx();
    const ctx = state.ctx;
    if (ctx && ctx.site === "chaoxing") {
      // 目录树是异步渲染的，boot 时可能还取不到章节名；扫描时会再取一次并刷新
      const curTitle = ctx.knowledgeid ? cxCurrentChapterTitle(ctx.knowledgeid) : "";
      ui.ctx.innerHTML = cxCtxHtml(ctx, curTitle);
      log("已识别学习通课程上下文");
    } else if (ctx && ctx.cid) {
      ui.ctx.innerHTML = `课程 sign=<b>${ctx.sign}</b> cid=<b>${ctx.cid}</b>` +
        (ctx.leafId ? `  当前课时 <b>${ctx.leafId}</b> (${ctx.kind})` : "");
      log("已识别课程上下文");
    } else {
      ui.ctx.textContent = "当前页面未识别到课程（需要 cid）。可先打开课程学习页。";
      ui.scan.disabled = true;
    }
    // 记住上次选项
    const save = () => {
      GM_setValue("opts", {
        leaf: ui.leaf.checked, pptx: ui.pptx.checked, limit: ui.limit.value,
        allCh: ui.allCh ? ui.allCh.checked : false,
        pics: ui.pics ? ui.pics.checked : true,
      });
    };
    [ui.leaf, ui.pptx, ui.limit].concat(ui.allCh ? [ui.allCh] : []).concat(ui.pics ? [ui.pics] : []).forEach((el) => el.addEventListener("change", save));
    const saved = GM_getValue("opts", null);
    if (saved) {
      ui.leaf.checked = saved.leaf !== false;
      ui.pptx.checked = saved.pptx !== false;
      if (ui.allCh) ui.allCh.checked = saved.allCh === true;   // 默认只检测本页
      if (ui.pics) ui.pics.checked = saved.pics !== false;     // 默认收集本页图片
      if (saved.limit) ui.limit.value = saved.limit;
    }
  }

  // 调试钩子：直接调内部函数（页面图收集 / 高清地址换算 / 版本比较）
  // 放在 IIFE 末尾赋值：上面的 const 声明这时已经完成初始化，避免 TDZ 报错
  if (typeof window !== "undefined") {
    window.__XTD_DEBUG = { cxCollectPageImages, cxHiResUrl, cmpVersion, parseMeta, UPDATE };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { safeName, extOf, isImg, isDoc, resolveUrl, scanJson, collectLeafIds, groupNameOf, randomName, sniffBytes, buildLeafLabels, attachAttname, SITE, cxParseChapters, cxParseAttachments, cxResolveUrl, ctxOk, buildUrl };
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
