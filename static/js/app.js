/* 古地图坐标校正与路线叠合校审台 — 前端逻辑 */
"use strict";
const NS = "http://www.w3.org/2000/svg";
const $ = (s) => document.querySelector(s);

let currentMapId = null;
let state = null;          // /api/maps/<id>/state 返回
let mode = "drag";         // drag | addcp | river | road | other
let draftLine = [];        // 正在描绘的折线(像素坐标)
let imgSize = null;        // 扫描图原始尺寸 {w,h}
let dragCp = null;         // 正在拖动的控制点 id

/* ---------------- 工具 ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}
const jpost = (p, d) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d || {}) });
const jput = (p, d) => api(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d || {}) });
const jdel = (p) => api(p, { method: "DELETE" });
const fmt = (v, n = 2) => Number(v).toFixed(n);

function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function svgPoint(svg, evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

/* ---------------- 数据加载 ---------------- */
async function loadMaps() {
  const maps = await api("/api/maps");
  const sel = $("#mapSelect");
  sel.innerHTML = '<option value="">— 选择地图 —</option>';
  maps.forEach(m => {
    const o = document.createElement("option");
    o.value = m.id; o.textContent = `#${m.id} ${m.name}`;
    sel.appendChild(o);
  });
  if (currentMapId) sel.value = currentMapId;
}

async function refresh() {
  if (!currentMapId) { state = null; renderAll(); return; }
  state = await api(`/api/maps/${currentMapId}/state`);
  renderAll();
}

/* ---------------- 渲染: 扫描图 ---------------- */
async function renderScan() {
  const svg = $("#scanSvg");
  svg.innerHTML = "";
  if (!state) { svg.setAttribute("viewBox", "0 0 400 300"); return; }
  const m = state.map;
  if (m.filename) {
    if (!imgSize || imgSize.name !== m.filename) {
      imgSize = await new Promise(res => {
        const im = new Image();
        im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight, name: m.filename });
        im.onerror = () => res({ w: 900, h: 640, name: m.filename });
        im.src = "/uploads/" + m.filename;
      });
    }
    svg.setAttribute("viewBox", `0 0 ${imgSize.w} ${imgSize.h}`);
    el("image", { href: "/uploads/" + m.filename, x: 0, y: 0,
                  width: imgSize.w, height: imgSize.h }, svg);
  } else {
    imgSize = { w: 900, h: 640, name: null };
    svg.setAttribute("viewBox", "0 0 900 640");
    const t = el("text", { x: 450, y: 320, "text-anchor": "middle", fill: "#999" }, svg);
    t.textContent = "该地图没有扫描图, 请重新上传";
  }
  // 折线
  state.polylines.forEach(pl => {
    el("polyline", {
      class: "pline " + pl.kind,
      points: pl.points.map(p => p.join(",")).join(" ")
    }, svg);
  });
  // 描绘中的折线
  if (draftLine.length) {
    el("polyline", { class: "pline draft",
      points: draftLine.map(p => p.join(",")).join(" ") }, svg);
    draftLine.forEach(p => el("circle", { class: "vertex", cx: p[0], cy: p[1], r: 4 }, svg));
  }
  // 控制点
  const diagMap = {};
  if (state.diag) state.diag.points.forEach(p => diagMap[p.id] = p);
  state.control_points.forEach(cp => {
    const d = diagMap[cp.id];
    const g = el("g", { class: "cp" + (d && d.outlier ? " outlier" : ""), "data-id": cp.id }, svg);
    el("circle", { cx: cp.px, cy: cp.py, r: 7 }, g);
    const t = el("text", { x: cp.px + 10, y: cp.py - 8 }, g);
    t.textContent = cp.name || ("CP" + cp.id);
    if (!cp.enabled) g.setAttribute("opacity", "0.35");
  });
}

/* ---------------- 渲染: 现代坐标网格 ---------------- */
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function renderGrid() {
  const svg = $("#gridSvg");
  svg.innerHTML = "";
  const W = 800, H = 600, PAD = 50;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const note = $("#resScaleNote");
  note.textContent = "";
  if (!state || !state.diag) {
    const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "#999", "font-size": 16 }, svg);
    t.textContent = state ? "至少需要 3 个启用的控制点才能计算仿射校正" : "请先选择或上传地图";
    return;
  }
  const d = state.diag;
  // 收集现代坐标范围
  const pts = [];
  d.points.forEach(p => { pts.push([p.mx, p.my]); pts.push([p.fx, p.fy]); });
  state.warped_polylines.forEach(pl => pl.points.forEach(p => pts.push(p)));
  let minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0]));
  let minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
  minX -= spanX * 0.08; maxX += spanX * 0.08;
  minY -= spanY * 0.08; maxY += spanY * 0.08;
  const sc = Math.min((W - 2 * PAD) / (maxX - minX), (H - 2 * PAD) / (maxY - minY));
  const ox = (W - sc * (maxX - minX)) / 2, oy = (H - sc * (maxY - minY)) / 2;
  const X = v => ox + (v - minX) * sc;
  const Y = v => H - (oy + (v - minY) * sc);   // Y 轴向上

  // 箭头标记
  const defs = el("defs", {}, svg);
  const marker = el("marker", { id: "arrowhead", markerWidth: 8, markerHeight: 8,
    refX: 6, refY: 3, orient: "auto" }, defs);
  el("path", { d: "M0,0 L6,3 L0,6 Z", fill: "#c0392b" }, marker);

  // 网格线 + 注记
  const step = niceStep(Math.max(maxX - minX, maxY - minY) / 8);
  for (let gx = Math.ceil(minX / step) * step; gx <= maxX; gx += step) {
    el("line", { class: "grid-line", x1: X(gx), y1: Y(minY), x2: X(gx), y2: Y(maxY) }, svg);
    const t = el("text", { class: "grid-label", x: X(gx), y: Y(minY) + 14, "text-anchor": "middle" }, svg);
    t.textContent = Math.round(gx * 100) / 100;
  }
  for (let gy = Math.ceil(minY / step) * step; gy <= maxY; gy += step) {
    el("line", { class: "grid-line", x1: X(minX), y1: Y(gy), x2: X(maxX), y2: Y(gy) }, svg);
    const t = el("text", { class: "grid-label", x: X(minX) - 6, y: Y(gy) + 3, "text-anchor": "end" }, svg);
    t.textContent = Math.round(gy * 100) / 100;
  }

  // 叠合后的折线
  state.warped_polylines.forEach(pl => {
    el("polyline", { class: "pline " + pl.kind,
      points: pl.points.map(p => X(p[0]) + "," + Y(p[1])).join(" ") }, svg);
    const p0 = pl.points[0];
    const t = el("text", { class: "gcp-label", x: X(p0[0]) + 6, y: Y(p0[1]) - 6 }, svg);
    t.textContent = pl.name;
  });

  // 残差向量(自动放大以便观察局部偏差)
  const maxMag = Math.max(...d.points.map(p => p.mag));
  let factor = 1;
  if (maxMag > 1e-9) {
    factor = 0.10 * Math.max(maxX - minX, maxY - minY) / maxMag;
    if (factor < 1) factor = 1;
    factor = Math.round(factor);
  }
  note.textContent = maxMag > 1e-9 ? `残差向量 ×${factor} 放大显示` : "所有控制点残差为 0";

  d.points.forEach(p => {
    // 拟合位置(空心) -> 实际现代坐标(实心), 箭头即局部偏差
    el("circle", { class: "gcp-fitted", cx: X(p.fx), cy: Y(p.fy), r: 5 }, svg);
    if (p.mag > 1e-9) {
      el("line", { class: "res-arrow" + (p.outlier ? " outlier" : ""),
        x1: X(p.fx), y1: Y(p.fy),
        x2: X(p.fx + p.rx * factor), y2: Y(p.fy + p.ry * factor) }, svg);
    }
    el("circle", { class: "gcp-actual", cx: X(p.mx), cy: Y(p.my), r: 4.5 }, svg);
    const t = el("text", { class: "gcp-label", x: X(p.mx) + 7, y: Y(p.my) - 7 }, svg);
    t.textContent = p.name || ("CP" + p.id);
  });
}

/* ---------------- 渲染: 校审面板 ---------------- */
function renderPanel() {
  const sum = $("#diagSummary"), tb = $("#cpTable tbody");
  tb.innerHTML = "";
  $("#polyList").innerHTML = "";
  $("#versionList").innerHTML = "";
  if (!state) { sum.innerHTML = "请选择地图。"; return; }
  const d = state.diag;
  if (!d) {
    const n = state.control_points.filter(c => c.enabled).length;
    sum.innerHTML = `<span class="bad">⚠ 控制点不足</span>(已启用 ${n} 个, 至少需 3 个), 无法计算仿射校正。`;
  } else {
    const nOut = d.points.filter(p => p.outlier).length;
    sum.innerHTML =
      `仿射参数: X = ${fmt(d.transform.a, 6)}·x + ${fmt(d.transform.b, 6)}·y + ${fmt(d.transform.c, 4)}<br>` +
      `&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Y = ${fmt(d.transform.d, 6)}·x + ${fmt(d.transform.e, 6)}·y + ${fmt(d.transform.f, 4)}<br>` +
      `RMS 残差: <b>${fmt(d.rms, 3)}</b> &nbsp; 平均残差: ${fmt(d.mean, 3)}<br>` +
      `离群阈值(2×RMS): ${fmt(d.threshold, 3)} &nbsp; ` +
      (nOut ? `<span class="bad">⚠ ${nOut} 个离群控制点</span>`
            : `<span class="ok">✔ 无离群控制点</span>`);
  }
  const diagMap = {};
  if (d) d.points.forEach(p => diagMap[p.id] = p);
  state.control_points.forEach(cp => {
    const p = diagMap[cp.id];
    const tr = document.createElement("tr");
    if (p && p.outlier) tr.className = "outlier";
    if (!cp.enabled) tr.classList.add("disabled");
    tr.innerHTML =
      `<td><input type="checkbox" ${cp.enabled ? "checked" : ""} data-act="toggle" data-id="${cp.id}"></td>` +
      `<td>${cp.name || "CP" + cp.id}</td>` +
      `<td>${fmt(cp.px, 1)}, ${fmt(cp.py, 1)}</td>` +
      `<td>${fmt(cp.mx)}, ${fmt(cp.my)}</td>` +
      `<td>${p ? fmt(p.mag, 3) : "—"}</td>` +
      `<td>${p ? fmt(p.rx, 2) + ", " + fmt(p.ry, 2) : "—"}</td>` +
      `<td>${p ? (p.outlier ? '<span class="badge out">离群</span>' : '<span class="badge ok">正常</span>') : "—"}</td>` +
      `<td><button data-act="delcp" data-id="${cp.id}">删</button></td>`;
    tb.appendChild(tr);
  });
  state.polylines.forEach(pl => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="kind-${pl.kind}">● ${pl.name || "(未命名)"}
      <small>${pl.kind === "river" ? "河流" : pl.kind === "road" ? "道路" : "其他"} · ${pl.points.length} 点</small></span>
      <span><button data-act="delpl" data-id="${pl.id}">删</button></span>`;
    $("#polyList").appendChild(li);
  });
  state.versions.forEach(v => {
    const li = document.createElement("li");
    li.innerHTML = `<span>🕐 ${v.name || "版本"} <small>${v.created_at}</small></span>
      <span><button class="restore" data-act="restore" data-id="${v.id}">恢复</button>
      <button data-act="delver" data-id="${v.id}">删</button></span>`;
    $("#versionList").appendChild(li);
  });
}

function renderAll() { renderScan(); renderGrid(); renderPanel(); }

/* ---------------- 交互: 模式 ---------------- */
document.querySelectorAll("#toolbar .mode").forEach(b => {
  b.onclick = () => {
    mode = b.dataset.mode;
    draftLine = [];
    document.querySelectorAll("#toolbar .mode").forEach(x => x.classList.toggle("active", x === b));
    updateHint(); renderScan();
  };
});
function updateHint() {
  const hints = {
    drag: "拖动控制点可微调位置, 松开后自动重算",
    addcp: "在扫描图上点击控制点位置, 然后录入其现代坐标",
    river: "逐点点击描绘河流, 双击或点「完成折线」结束",
    road: "逐点点击描绘道路, 双击或点「完成折线」结束",
    other: "逐点点击描绘地物, 双击或点「完成折线」结束",
  };
  $("#hint").textContent = hints[mode] || "";
  $("#btnFinishLine").classList.toggle("hidden",
    !(["river", "road", "other"].includes(mode) && draftLine.length >= 2));
}

/* ---------------- 交互: 扫描图点击/拖动 ---------------- */
const scanSvg = $("#scanSvg");
let pendingPixel = null;

scanSvg.addEventListener("pointerdown", (e) => {
  if (!state) return;
  const g = e.target.closest(".cp");
  if (mode === "drag" && g) {
    dragCp = Number(g.dataset.id);
    scanSvg.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
scanSvg.addEventListener("pointermove", (e) => {
  if (dragCp == null) return;
  const p = svgPoint(scanSvg, e);
  const g = scanSvg.querySelector(`.cp[data-id="${dragCp}"]`);
  if (g) {
    g.querySelector("circle").setAttribute("cx", p.x);
    g.querySelector("circle").setAttribute("cy", p.y);
    const t = g.querySelector("text");
    t.setAttribute("x", p.x + 10); t.setAttribute("y", p.y - 8);
  }
});
scanSvg.addEventListener("pointerup", async (e) => {
  if (dragCp == null) return;
  const p = svgPoint(scanSvg, e);
  const id = dragCp; dragCp = null;
  await jput(`/api/control_points/${id}`, { px: p.x, py: p.y });
  await refresh();   // 松开后重算仿射与残差
});

scanSvg.addEventListener("click", async (e) => {
  if (!state || dragCp != null) return;
  if (e.target.closest(".cp")) return;
  const p = svgPoint(scanSvg, e);
  if (mode === "addcp") {
    pendingPixel = [p.x, p.y];
    $("#cpPixelPos").textContent = `(${fmt(p.x, 1)}, ${fmt(p.y, 1)})`;
    $("#cpName").value = ""; $("#cpMx").value = ""; $("#cpMy").value = "";
    $("#cpModal").classList.remove("hidden");
    $("#cpMx").focus();
  } else if (["river", "road", "other"].includes(mode)) {
    draftLine.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
    updateHint(); renderScan();
  }
});
scanSvg.addEventListener("dblclick", () => { if (draftLine.length >= 2) finishLine(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { draftLine = []; updateHint(); renderScan(); }
  if (e.key === "Enter" && draftLine.length >= 2) finishLine();
});
$("#btnFinishLine").onclick = () => finishLine();

async function finishLine() {
  if (draftLine.length < 2) return;
  const kindName = { river: "河流", road: "道路", other: "地物" }[mode];
  const name = prompt(`折线名称(${kindName}):`, "") || "";
  await jpost(`/api/maps/${currentMapId}/polylines`,
    { name, kind: mode, points: draftLine });
  draftLine = [];
  updateHint(); await refresh();
}

/* ---------------- 交互: 控制点弹窗 ---------------- */
$("#cpOk").onclick = async () => {
  const mx = parseFloat($("#cpMx").value), my = parseFloat($("#cpMy").value);
  if (isNaN(mx) || isNaN(my)) { alert("请填写现代坐标 X 和 Y"); return; }
  await jpost(`/api/maps/${currentMapId}/control_points`,
    { name: $("#cpName").value, px: pendingPixel[0], py: pendingPixel[1], mx, my });
  $("#cpModal").classList.add("hidden");
  await refresh();
};
$("#cpCancel").onclick = () => $("#cpModal").classList.add("hidden");

/* ---------------- 交互: 面板按钮(事件委托) ---------------- */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const id = Number(b.dataset.id), act = b.dataset.act;
  if (act === "delcp" && confirm("删除该控制点?")) { await jdel(`/api/control_points/${id}`); await refresh(); }
  if (act === "delpl" && confirm("删除该折线?")) { await jdel(`/api/polylines/${id}`); await refresh(); }
  if (act === "delver" && confirm("删除该版本?")) { await jdel(`/api/versions/${id}`); await refresh(); }
  if (act === "restore" && confirm("用该版本覆盖当前控制点与折线?")) {
    await jpost(`/api/versions/${id}/restore`); await refresh();
  }
});
document.addEventListener("change", async (e) => {
  const b = e.target.closest('[data-act="toggle"]');
  if (!b) return;
  await jput(`/api/control_points/${b.dataset.id}`, { enabled: b.checked ? 1 : 0 });
  await refresh();
});

/* ---------------- 交互: 顶部工具栏 ---------------- */
$("#mapSelect").onchange = (e) => {
  currentMapId = e.target.value ? Number(e.target.value) : null;
  imgSize = null; draftLine = []; refresh();
};
$("#btnUpload").onclick = async () => {
  const fd = new FormData();
  fd.append("name", $("#newMapName").value || "未命名地图");
  const f = $("#newMapFile").files[0];
  if (f) fd.append("file", f);
  const r = await api("/api/maps", { method: "POST", body: fd });
  currentMapId = r.id; imgSize = null;
  await loadMaps(); $("#mapSelect").value = currentMapId; await refresh();
};
$("#btnDemo").onclick = async () => {
  const r = await jpost("/api/demo");
  currentMapId = r.id; imgSize = null;
  await loadMaps(); $("#mapSelect").value = currentMapId; await refresh();
};
$("#btnDeleteMap").onclick = async () => {
  if (!currentMapId || !confirm("删除当前地图及其全部数据?")) return;
  await jdel(`/api/maps/${currentMapId}`);
  currentMapId = null; imgSize = null;
  await loadMaps(); await refresh();
};
$("#btnSaveVersion").onclick = async () => {
  if (!currentMapId) return;
  const name = prompt("版本名称:", "校正 " + new Date().toLocaleString());
  if (name === null) return;
  await jpost(`/api/maps/${currentMapId}/versions`, { name });
  await refresh();
};

/* ---------------- 启动 ---------------- */

/* 视图切换: ① 单图校正 / ② 图幅接边校审 */
document.querySelectorAll("#viewTabs .tab").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("#viewTabs .tab").forEach(x =>
      x.classList.toggle("active", x === b));
    const isEdge = b.dataset.view === "edge";
    $("#warpView").classList.toggle("hidden", isEdge);
    $("#edgeView").classList.toggle("hidden", !isEdge);
    if (isEdge && typeof loadEdgeMaps === "function") loadEdgeMaps();
  };
});

(async () => {
  await loadMaps();
  const maps = await api("/api/maps");
  if (maps.length) { currentMapId = maps[0].id; $("#mapSelect").value = currentMapId; }
  updateHint();
  await refresh();
})();
