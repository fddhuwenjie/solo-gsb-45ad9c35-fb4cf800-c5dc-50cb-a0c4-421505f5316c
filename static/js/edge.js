/* 图幅接边校审 — 前端逻辑 */
"use strict";

let edgeData = null;          // /api/edge/pairs/... 返回
let edgeSelection = null;     // 当前选中候选/决定 {ep_a, ep_b, orphan}
let edgeMapsCache = [];

const KIND_NAME = { river: "河流", road: "道路", other: "其他" };
const KIND_COLOR = { river: "#2471a3", road: "#9c640c", other: "#1e8449" };
const END_NAME = { head: "首点", tail: "尾点" };

const ckey = (a, b) => a + "|" + b;

function epInfo(key) {
  const all = edgeData
    ? edgeData.endpoints_a.concat(edgeData.endpoints_b)
    : [];
  return all.find(e => e.key === key) || null;
}
function epShort(key) {
  const e = epInfo(key);
  if (e) return `${e.name || KIND_NAME[e.kind] || "折线"}#${e.polyline_id}·${END_NAME[e.end]}`;
  const p = key.split(":");
  return `折线#${p[1]}·${END_NAME[p[2]] || p[2]}`;
}
function epSide(key) {
  const e = epInfo(key);
  if (e) return e.map_id === edgeData.map_a_id ? "A" : "B";
  return Number(key.split(":")[0]) === edgeData.map_a_id ? "A" : "B";
}

/* ---------------- 地图选择 ---------------- */
async function loadEdgeMaps(preselect) {
  edgeMapsCache = await api("/api/edge/maps");
  for (const selId of ["edgeMapA", "edgeMapB"]) {
    const sel = document.getElementById(selId);
    const cur = sel.value;
    sel.innerHTML = '<option value="">— 选择地图 —</option>';
    edgeMapsCache.forEach(m => {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = `#${m.id} ${m.name}` +
        (m.warped ? "" : "（未校正）") +
        (m.warped && !m.endpoint_count ? "（无折线）" : "");
      if (!m.warped) o.disabled = true;
      sel.appendChild(o);
    });
    sel.value = (preselect && preselect[selId] && preselect[selId][selId === "edgeMapA" ? "a" : "b"]) || cur;
  }
}

/* ---------------- 计算 ---------------- */
async function runEdgeCalc(ids, tol) {
  const idA = ids ? ids.a : Number($("#edgeMapA").value);
  const idB = ids ? ids.b : Number($("#edgeMapB").value);
  const tolerance = tol != null ? tol : parseFloat($("#edgeTol").value);
  if (!idA || !idB) { alert("请先选择两张地图"); return; }
  if (idA === idB) { alert("请选择两张不同的地图"); return; }
  if (!(tolerance > 0)) { alert("请填写正数容差"); return; }
  edgeData = await api(
    `/api/edge/pairs/${idA}/${idB}?tolerance=${encodeURIComponent(tolerance)}`);
  edgeSelection = null;
  renderEdgeAll();
}

function applyEdgePayload(p) {
  edgeData = p;
  // 选中项若已不存在则清除
  if (edgeSelection) {
    const still = edgeData.candidates.some(
      c => c.ep_a === edgeSelection.ep_a && c.ep_b === edgeSelection.ep_b);
    if (!still) edgeSelection = null;
  }
  renderEdgeAll();
}

/* ---------------- 叠加 SVG ---------------- */
function renderEdgeSvg() {
  const svg = $("#edgeSvg");
  svg.innerHTML = "";
  const W = 900, H = 640, PAD = 46;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  $("#edgeScaleNote").textContent = "";
  if (!edgeData) {
    svg.setAttribute("viewBox", "0 0 400 200");
    const t = el("text", { x: 200, y: 100, "text-anchor": "middle",
      fill: "#999", "font-size": 15 }, svg);
    t.textContent = "选择两张已校正地图并计算后, 此处同尺度叠加两侧折线";
    return;
  }

  // 收集所有现代坐标(两图折线 + 端点), 统一尺度(sx == sy)
  const pts = [];
  edgeData.warped_a.forEach(pl => pl.points.forEach(p => pts.push(p)));
  edgeData.warped_b.forEach(pl => pl.points.forEach(p => pts.push(p)));
  edgeData.endpoints_a.forEach(e => pts.push([e.x, e.y]));
  edgeData.endpoints_b.forEach(e => pts.push([e.x, e.y]));
  let minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0]));
  let minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
  minX -= spanX * 0.06; maxX += spanX * 0.06;
  minY -= spanY * 0.06; maxY += spanY * 0.06;
  const sc = Math.min((W - 2 * PAD) / (maxX - minX),
                      (H - 2 * PAD) / (maxY - minY));   // 同尺度
  const ox = (W - sc * (maxX - minX)) / 2, oy = (H - sc * (maxY - minY)) / 2;
  const X = v => ox + (v - minX) * sc;
  const Y = v => H - (oy + (v - minY) * sc);
  $("#edgeScaleNote").textContent =
    `(统一尺度 1:${(1 / sc).toFixed(2)} 屏幕单位/坐标单位)`;

  // 网格
  const step = niceStep(Math.max(maxX - minX, maxY - minY) / 9);
  for (let gx = Math.ceil(minX / step) * step; gx <= maxX; gx += step) {
    el("line", { class: "grid-line", x1: X(gx), y1: Y(minY),
      x2: X(gx), y2: Y(maxY) }, svg);
    const t = el("text", { class: "grid-label", x: X(gx),
      y: Y(minY) + 13, "text-anchor": "middle" }, svg);
    t.textContent = Math.round(gx * 100) / 100;
  }
  for (let gy = Math.ceil(minY / step) * step; gy <= maxY; gy += step) {
    el("line", { class: "grid-line", x1: X(minX), y1: Y(gy),
      x2: X(maxX), y2: Y(gy) }, svg);
    const t = el("text", { class: "grid-label", x: X(minX) - 5,
      y: Y(gy) + 3, "text-anchor": "end" }, svg);
    t.textContent = Math.round(gy * 100) / 100;
  }

  const decMap = {};
  edgeData.decisions.forEach(d => { decMap[ckey(d.ep_a, d.ep_b)] = d; });
  const selectedSet = new Set(edgeData.selected.map(s => ckey(s[0], s[1])));

  // 两图折线(同尺度叠加), A 实线 / B 虚线, 起点标图幅
  const drawWarps = (warps, side) => {
    warps.forEach(pl => {
      el("polyline", {
        class: `edge-pline side-${side.toLowerCase()} ${pl.kind}`,
        points: pl.points.map(p => X(p[0]) + "," + Y(p[1])).join(" ")
      }, svg);
      const p0 = pl.points[0];
      const t = el("text", { class: "edge-plabel",
        x: X(p0[0]) + 5, y: Y(p0[1]) - 7 }, svg);
      t.textContent = `${side} ${pl.name || ""}`;
    });
  };
  drawWarps(edgeData.warped_a, "A");
  drawWarps(edgeData.warped_b, "B");

  // 候选连线(先画, 端点压在其上)
  edgeData.candidates.forEach(c => {
    const ea = epInfo(c.ep_a), eb = epInfo(c.ep_b);
    if (!ea || !eb) return;
    const k = ckey(c.ep_a, c.ep_b);
    const dec = decMap[k];
    const isSel = edgeSelection &&
      edgeSelection.ep_a === c.ep_a && edgeSelection.ep_b === c.ep_b;
    let cls = "edge-conn";
    let gcls = "g-conflict";
    if (dec) {
      cls += dec.status === "review" ? " review" : (" " + dec.decision);
      gcls = dec.status === "review" ? "g-review"
        : (dec.decision === "accepted" ? "g-accepted" : "g-rejected");
    } else if (c.selected) {
      cls += " selected";
      gcls = "g-selected";
    } else {
      cls += " conflict";
    }
    if (isSel) cls += " sel";
    el("line", { class: cls, x1: X(ea.x), y1: Y(ea.y),
      x2: X(eb.x), y2: Y(eb.y),
      "data-epa": c.ep_a, "data-epb": c.ep_b }, svg);
    // 连线中点小标识: 接受/驳回/建议/冲突
    const mx = (X(ea.x) + X(eb.x)) / 2, my = (Y(ea.y) + Y(eb.y)) / 2;
    if (dec || isSel) {
      const g = el("g", { class: "edge-conn-glyph " + gcls,
        "data-epa": c.ep_a, "data-epb": c.ep_b }, svg);
      el("circle", { cx: mx, cy: my, r: 8 }, g);
      const t = el("text", { x: mx, y: my + 3.5, "text-anchor": "middle" }, g);
      t.textContent = dec
        ? (dec.decision === "accepted" ? "✓" : "✕")
        : (c.selected ? "✔" : "!");
    }
  });

  // 端点: 已配对 / 冲突 / 未匹配
  const involved = {};     // key -> 候选数
  edgeData.candidates.forEach(c => {
    involved[c.ep_a] = (involved[c.ep_a] || 0) + 1;
    involved[c.ep_b] = (involved[c.ep_b] || 0) + 1;
  });
  const drawEndpoints = (list, side) => list.forEach(e => {
    const n = involved[e.key] || 0;
    const isMatched = edgeData.candidates.some(
      c => c.selected && (c.ep_a === e.key || c.ep_b === e.key));
    let state = "unmatched";
    if (isMatched) state = "matched";
    else if (n > 0) state = "conflict";
    const isSel = edgeSelection &&
      (edgeSelection.ep_a === e.key || edgeSelection.ep_b === e.key) &&
      !edgeSelection.orphan;
    const g = el("g", { class: `ep ep-${state}` + (isSel ? " sel" : ""),
      "data-key": e.key }, svg);
    el("circle", { cx: X(e.x), cy: Y(e.y), r: 6 }, g);
    const tt = el("title", {}, g);
    tt.textContent = `${side}幅 · ${e.name || KIND_NAME[e.kind]}#${e.polyline_id}` +
      ` · ${END_NAME[e.end]} · ${KIND_NAME[e.kind]}` +
      (state === "matched" ? " · 已配对"
        : state === "conflict" ? " · 冲突(多候选未落配)" : " · 未匹配");
  });
  drawEndpoints(edgeData.endpoints_a, "A");
  drawEndpoints(edgeData.endpoints_b, "B");

  renderEdgeLegend();
}

function renderEdgeLegend() {
  $("#edgeLegend").innerHTML =
    '<span class="lg"><i class="dot ep-matched"></i>已配对</span>' +
    '<span class="lg"><i class="dot ep-conflict"></i>冲突端点</span>' +
    '<span class="lg"><i class="dot ep-unmatched"></i>未匹配</span>' +
    '<span class="lg"><i class="line selected"></i>建议配对</span>' +
    '<span class="lg"><i class="line conflict"></i>落选候选</span>' +
    '<span class="lg"><i class="line accepted"></i>已接受</span>' +
    '<span class="lg"><i class="line rejected"></i>已驳回</span>' +
    '<span class="lg"><i class="line review"></i>待复核</span>' +
    '<span class="lg pline-a">— A幅实线</span>' +
    '<span class="lg pline-b">--- B幅虚线</span>';
}

/* ---------------- 侧栏 ---------------- */
function edgeRowStatus(c, dec) {
  // 返回 {badge, badgeCls}
  if (dec) {
    if (dec.status === "review")
      return { badge: "⚠ 待复核", cls: "review" };
    return { badge: dec.decision === "accepted" ? "✓ 已接受" : "✕ 已驳回",
             cls: dec.decision };
  }
  if (c.selected) return { badge: "✔ 建议", cls: "suggest" };
  return { badge: "! 冲突落选", cls: "conflict" };
}

function renderEdgePanel() {
  const sum = $("#edgeSummary"), list = $("#edgeList"),
        detail = $("#edgeDetail");
  list.innerHTML = "";
  if (!edgeData) {
    sum.innerHTML = "先选择两张已完成仿射校正的地图并设置容差, " +
      "然后点击「计算接边候选」。";
    detail.classList.add("hidden");
    return;
  }
  const nA = edgeData.endpoints_a.length, nB = edgeData.endpoints_b.length;
  const nAcc = edgeData.decisions.filter(
    d => d.decision === "accepted" && d.status === "valid").length;
  const nRev = edgeData.decisions.filter(d => d.status === "review").length;
  const conflictEps = new Set();
  edgeData.candidates.forEach(c => {
    if (!c.selected) { conflictEps.add(c.ep_a); conflictEps.add(c.ep_b); }
  });
  edgeData.selected.forEach(s => {
    conflictEps.delete(s[0]); conflictEps.delete(s[1]);
  });
  sum.innerHTML =
    `<b>#${edgeData.map_a_id} ${edgeData.maps.a.name}</b> ↔ ` +
    `<b>#${edgeData.map_b_id} ${edgeData.maps.b.name}</b><br>` +
    `容差 ≤ ${fmt(edgeData.tolerance, 2)} · 候选 ${edgeData.candidates.length} 对 · ` +
    `最优一对一配对 <b>${edgeData.match_count}</b> 对, ` +
    `总距离 ${fmt(edgeData.total_distance, 3)}<br>` +
    `端点: A幅 ${nA} 个 / B幅 ${nB} 个 · 冲突端点 ${conflictEps.size} 个` +
    (nAcc ? ` · <span class="ok">已接受 ${nAcc}</span>` : "") +
    (nRev ? ` · <span class="bad">⚠ ${nRev} 条决定待复核</span>` : "");

  const decMap = {};
  edgeData.decisions.forEach(d => { decMap[ckey(d.ep_a, d.ep_b)] = d; });

  // 孤立决定(候选已不成立: 距离/夹角超限或折线删除) — 只能撤销
  const orphan = edgeData.decisions.filter(
    d => !edgeData.candidates.some(
      c => c.ep_a === d.ep_a && c.ep_b === d.ep_b));
  orphan.forEach(d => {
    const li = document.createElement("li");
    li.className = "review-row";
    li.innerHTML =
      `<span><span class="badge review">⚠ 待复核·失效</span><br>
        <small>${epShort(d.ep_a)} (${epSide(d.ep_a)}幅) ↔
        ${epShort(d.ep_b)} (${epSide(d.ep_b)}幅)</small><br>
        <small>原决定: ${d.decision === "accepted" ? "接受" : "驳回"}
        ${d.distance != null ? " · 原距离 " + fmt(d.distance, 2) : ""}</small></span>`;
    const btns = document.createElement("span");
    const rb = document.createElement("button");
    rb.textContent = "撤销"; rb.dataset.act = "rescind"; rb.dataset.id = d.id;
    btns.appendChild(rb);
    li.appendChild(btns);
    list.appendChild(li);
  });

  // 候选行: 待复核在前, 其次建议, 再次落选; 同组按距离
  const rows = edgeData.candidates.map(c => ({
    c, dec: decMap[ckey(c.ep_a, c.ep_b)] }));
  rows.sort((p, q) => {
    const pr = p.dec && p.dec.status === "review" ? 0
      : p.c.selected ? 1 : 2;
    const qr = q.dec && q.dec.status === "review" ? 0
      : q.c.selected ? 1 : 2;
    if (pr !== qr) return pr - qr;
    return p.c.distance - q.c.distance;
  });
  rows.forEach(({ c, dec }) => {
    const st = edgeRowStatus(c, dec);
    const k = ckey(c.ep_a, c.ep_b);
    const isSel = edgeSelection &&
      edgeSelection.ep_a === c.ep_a && edgeSelection.ep_b === c.ep_b;
    const li = document.createElement("li");
    li.dataset.epa = c.ep_a; li.dataset.epb = c.ep_b;
    if (dec && dec.status === "review") li.className = "review-row";
    if (isSel) li.classList.add("sel");
    li.innerHTML =
      `<span class="cand-main" data-act="pick" data-epa="${c.ep_a}"
         data-epb="${c.ep_b}">
        <span class="kind-${c.kind}">●</span>
        <span class="badge ${st.cls}">${st.badge}</span><br>
        <small><b>A幅</b> ${epShort(c.ep_a)} ↔ <b>B幅</b> ${epShort(c.ep_b)}
        <br>距离 ${fmt(c.distance, 2)} · 反向夹角 ${c.angle == null ? "—" : fmt(c.angle, 1) + "°"}
        · ${KIND_NAME[c.kind]}</small></span>`;
    const btns = document.createElement("span");
    btns.className = "cand-btns";
    const mk = (txt, act, cls) => {
      const b = document.createElement("button");
      b.textContent = txt; b.dataset.act = act;
      b.dataset.epa = c.ep_a; b.dataset.epb = c.ep_b;
      if (dec) b.dataset.id = dec.id;
      if (cls) b.className = cls;
      btns.appendChild(b);
    };
    const active = dec && dec.status === "valid" ? dec.decision : null;
    if (active !== "accepted") mk("接受", "accept", "ok");
    if (active !== "rejected") mk("驳回", "reject", "danger");
    if (dec) mk("撤销", "rescind");
    li.appendChild(btns);
    list.appendChild(li);
  });

  // 详情卡
  if (edgeSelection && !edgeSelection.orphan) {
    const c = edgeData.candidates.find(
      x => x.ep_a === edgeSelection.ep_a && x.ep_b === edgeSelection.ep_b);
    if (c) {
      const d = decMap[ckey(c.ep_a, c.ep_b)];
      detail.classList.remove("hidden");
      detail.innerHTML =
        `<b>选中候选</b> · ${KIND_NAME[c.kind]}<br>` +
        `A幅: ${epShort(c.ep_a)}<br>B幅: ${epShort(c.ep_b)}<br>` +
        `端点距离 ${fmt(c.distance, 3)} (容差 ${fmt(edgeData.tolerance, 2)}) · ` +
        `反向夹角 ${c.angle == null ? "—" : fmt(c.angle, 2) + "° (限 45°)"}<br>` +
        (c.selected ? "<span class='ok'>属于全局最优一对一配对</span>"
                    : "<span class='bad'>未入选最优配对(冲突候选)</span>") +
        (d ? `<br>当前决定: <b>${d.decision === "accepted" ? "已接受" : "已驳回"}</b>` +
             `(${d.status === "valid" ? "有效" : "⚠ 待复核"})`
           : "<br>当前决定: 未决");
      return;
    }
  }
  detail.classList.add("hidden");
}

function renderEdgeAll() { renderEdgeSvg(); renderEdgePanel(); }

/* ---------------- 交互 ---------------- */
$("#btnEdgeCalc").onclick = () => runEdgeCalc();
$("#edgeTol").addEventListener("keydown", e => {
  if (e.key === "Enter") runEdgeCalc();
});
$("#edgeMapA").onchange = $("#edgeMapB").onchange = () => {
  // 仅切换选择, 不自动请求
};
$("#btnEdgeDemo").onclick = async () => {
  const r = await jpost("/api/demo_edge");
  await loadEdgeMaps({ edgeMapA: { a: r.id_a }, edgeMapB: { b: r.id_b } });
  $("#edgeMapA").value = r.id_a;
  $("#edgeMapB").value = r.id_b;
  $("#edgeTol").value = r.tolerance;
  await runEdgeCalc({ a: r.id_a, b: r.id_b }, r.tolerance);
};

$("#edgeSvg").addEventListener("click", e => {
  const conn = e.target.closest(".edge-conn, .edge-conn-glyph");
  if (conn) {
    edgeSelection = { ep_a: conn.dataset.epa, ep_b: conn.dataset.epb };
    renderEdgeAll();
    const li = document.querySelector(
      `#edgeList li[data-epa="${conn.dataset.epa}"][data-epb="${conn.dataset.epb}"]`);
    if (li) li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
});

$("#edgeList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "pick") {
    edgeSelection = { ep_a: b.dataset.epa, ep_b: b.dataset.epb };
    renderEdgeAll();
    return;
  }
  if (!edgeData) return;
  const idA = edgeData.map_a_id, idB = edgeData.map_b_id;
  const tol = edgeData.tolerance;
  try {
    if (act === "accept" || act === "reject") {
      const p = await jpost(
        `/api/edge/pairs/${idA}/${idB}/decisions`,
        { ep_a: b.dataset.epa, ep_b: b.dataset.epb,
          decision: act === "accept" ? "accepted" : "rejected",
          tolerance: tol });
      applyEdgePayload(p);
    } else if (act === "rescind") {
      await jdel(`/api/edge/decisions/${b.dataset.id}`);
      const p = await api(
        `/api/edge/pairs/${idA}/${idB}?tolerance=${encodeURIComponent(tol)}`);
      applyEdgePayload(p);
    }
  } catch (err) {
    alert(err.message);
  }
});

/* 切走再接边视图时由 app.js 调用 loadEdgeMaps() 刷新地图下拉 */
