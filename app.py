# -*- coding: utf-8 -*-
"""
古地图坐标校正与路线叠合校审台
Flask + SQLite + 原生 HTML/CSS/JS/SVG

功能:
  - 上传扫描古地图, 录入控制点(图像像素坐标 <-> 现代坐标)
  - 最小二乘仿射校正, 残差诊断 / 离群控制点自动标记 / 局部偏差向量
  - 在扫描图上描绘河流、道路等折线, 自动叠合到现代坐标网格
  - 拖动控制点实时重算, 可保存 / 恢复校正版本
"""
import os
import json
import math
import sqlite3

from flask import (Flask, request, jsonify, render_template,
                   send_from_directory, g)
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(DATA_DIR, "app.db"))
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".tif", ".tiff", ".bmp"}

app = Flask(__name__)

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS maps(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filename TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS control_points(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  name TEXT DEFAULT '',
  px REAL NOT NULL, py REAL NOT NULL,   -- 扫描图像素坐标
  mx REAL NOT NULL, my REAL NOT NULL,   -- 现代坐标
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS polylines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  name TEXT DEFAULT '',
  kind TEXT DEFAULT 'river',            -- river / road / other
  points TEXT NOT NULL                  -- JSON [[px,py],...]
);
CREATE TABLE IF NOT EXISTS versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  payload TEXT NOT NULL                 -- JSON 快照
);
CREATE TABLE IF NOT EXISTS edge_decisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_a_id INTEGER NOT NULL,            -- 规范化地图对: 较小的地图 id
  map_b_id INTEGER NOT NULL,            -- 较大的地图 id
  ep_a TEXT NOT NULL,                   -- A 侧端点身份 "<map_id>:<polyline_id>:<head|tail>"
  ep_b TEXT NOT NULL,                   -- B 侧端点身份
  decision TEXT NOT NULL,               -- accepted(接受) / rejected(驳回)
  status TEXT NOT NULL DEFAULT 'valid', -- valid(重算后仍有效) / review(待复核)
  tolerance REAL,                       -- 作出决定时的容差
  distance REAL,                        -- 决定时端点距离快照(现代坐标单位)
  angle REAL,                           -- 反向后夹角快照(度)
  reviewer_note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(map_a_id, map_b_id, ep_a, ep_b)
);
CREATE INDEX IF NOT EXISTS idx_edge_pair
  ON edge_decisions(map_a_id, map_b_id);
"""


# ---------------------------------------------------------------- 数据库

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=15)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    db.commit()
    db.close()


def rows(sql, args=()):
    return [dict(r) for r in get_db().execute(sql, args).fetchall()]


# ---------------------------------------------------------------- 仿射校正

def _solve3(M, v):
    """3x3 高斯消元(列主元), 奇异时返回 None"""
    A = [M[i][:] + [v[i]] for i in range(3)]
    for col in range(3):
        piv = max(range(col, 3), key=lambda r: abs(A[r][col]))
        if abs(A[piv][col]) < 1e-12:
            return None
        A[col], A[piv] = A[piv], A[col]
        for r in range(col + 1, 3):
            f = A[r][col] / A[col][col]
            for c in range(col, 4):
                A[r][c] -= f * A[col][c]
    x = [0.0] * 3
    for i in range(2, -1, -1):
        x[i] = (A[i][3] - sum(A[i][j] * x[j] for j in range(i + 1, 3))) / A[i][i]
    return x


def fit_affine(cps):
    """最小二乘拟合仿射变换  mx=a*px+b*py+c, my=d*px+e*py+f (>=3 点)"""
    n = len(cps)
    if n < 3:
        return None
    spx = spy = spx2 = spy2 = spxy = 0.0
    smx = smy = spxmx = spymx = spxmy = spymy = 0.0
    for p in cps:
        x, y, u, v = p["px"], p["py"], p["mx"], p["my"]
        spx += x; spy += y; spx2 += x * x; spy2 += y * y; spxy += x * y
        smx += u; smy += v
        spxmx += x * u; spymx += y * u; spxmy += x * v; spymy += y * v
    M = [[spx2, spxy, spx], [spxy, spy2, spy], [spx, spy, float(n)]]
    sx = _solve3(M, [spxmx, spymx, smx])
    sy = _solve3(M, [spxmy, spymy, smy])
    if sx is None or sy is None:
        return None
    return {"a": sx[0], "b": sx[1], "c": sx[2],
            "d": sy[0], "e": sy[1], "f": sy[2]}


def apply_t(t, x, y):
    return (t["a"] * x + t["b"] * y + t["c"],
            t["d"] * x + t["e"] * y + t["f"])


def diagnostics(cps):
    """返回 {transform, points[残差], rms, mean, threshold}"""
    t = fit_affine(cps)
    if t is None:
        return None
    pts = []
    for p in cps:
        fx, fy = apply_t(t, p["px"], p["py"])
        rx, ry = p["mx"] - fx, p["my"] - fy
        pts.append({**p, "fx": fx, "fy": fy, "rx": rx, "ry": ry,
                    "mag": math.hypot(rx, ry)})
    n = len(pts)
    rms = math.sqrt(sum(p["mag"] ** 2 for p in pts) / n)
    mean = sum(p["mag"] for p in pts) / n
    threshold = 2.0 * rms
    for p in pts:
        # 残差大于 2 倍 RMS 判为离群控制点
        p["outlier"] = bool(rms > 1e-9 and p["mag"] > threshold)
    return {"transform": t, "points": pts, "rms": rms,
            "mean": mean, "threshold": threshold}


# ---------------------------------------------------------------- 状态组装

def map_state(map_id):
    m = rows("SELECT * FROM maps WHERE id=?", (map_id,))
    if not m:
        return None
    cps = rows("SELECT * FROM control_points WHERE map_id=? ORDER BY id", (map_id,))
    pls = rows("SELECT * FROM polylines WHERE map_id=? ORDER BY id", (map_id,))
    for pl in pls:
        pl["points"] = json.loads(pl["points"])
    vers = rows("SELECT id,name,created_at FROM versions WHERE map_id=? "
                "ORDER BY id DESC", (map_id,))
    enabled = [c for c in cps if c["enabled"]]
    diag = diagnostics(enabled)
    # 折线叠合到现代坐标
    warped = []
    if diag:
        t = diag["transform"]
        for pl in pls:
            warped.append({"id": pl["id"], "name": pl["name"], "kind": pl["kind"],
                           "points": [list(apply_t(t, x, y)) for x, y in pl["points"]]})
    return {"map": m[0], "control_points": cps, "polylines": pls,
            "warped_polylines": warped, "diag": diag, "versions": vers}


# ---------------------------------------------------------------- 路由: 页面

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/uploads/<path:filename>")
def uploads(filename):
    return send_from_directory(UPLOAD_DIR, filename)


# ---------------------------------------------------------------- 路由: 地图

@app.route("/api/maps", methods=["GET"])
def list_maps():
    return jsonify(rows("SELECT * FROM maps ORDER BY id DESC"))


@app.route("/api/maps", methods=["POST"])
def create_map():
    name = request.form.get("name") or "未命名地图"
    f = request.files.get("file")
    db = get_db()
    cur = db.execute("INSERT INTO maps(name) VALUES(?)", (name,))
    map_id = cur.lastrowid
    filename = None
    if f and f.filename:
        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in ALLOWED_EXT:
            db.rollback()
            return jsonify({"error": "不支持的图片格式"}), 400
        filename = "%d_%s" % (map_id, secure_filename(f.filename) or ("scan" + ext))
        f.save(os.path.join(UPLOAD_DIR, filename))
        db.execute("UPDATE maps SET filename=? WHERE id=?", (filename, map_id))
    db.commit()
    return jsonify({"id": map_id, "name": name, "filename": filename})


@app.route("/api/maps/<int:map_id>", methods=["DELETE"])
def delete_map(map_id):
    db = get_db()
    m = rows("SELECT filename FROM maps WHERE id=?", (map_id,))
    if m and m[0]["filename"]:
        try:
            os.remove(os.path.join(UPLOAD_DIR, m[0]["filename"]))
        except OSError:
            pass
    db.execute("DELETE FROM maps WHERE id=?", (map_id,))
    # 接边决定以端点身份持久化, 地图删除后清理涉及该图的全部记录
    db.execute("DELETE FROM edge_decisions WHERE map_a_id=? OR map_b_id=?",
               (map_id, map_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/maps/<int:map_id>/state")
def get_state(map_id):
    st = map_state(map_id)
    if st is None:
        return jsonify({"error": "地图不存在"}), 404
    return jsonify(st)


# ---------------------------------------------------------------- 路由: 控制点

@app.route("/api/maps/<int:map_id>/control_points", methods=["POST"])
def add_cp(map_id):
    d = request.get_json(force=True)
    db = get_db()
    cur = db.execute(
        "INSERT INTO control_points(map_id,name,px,py,mx,my) VALUES(?,?,?,?,?,?)",
        (map_id, d.get("name", ""), float(d["px"]), float(d["py"]),
         float(d["mx"]), float(d["my"])))
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.route("/api/control_points/<int:cp_id>", methods=["PUT"])
def update_cp(cp_id):
    d = request.get_json(force=True)
    db = get_db()
    fields, args = [], []
    for k in ("name", "px", "py", "mx", "my", "enabled"):
        if k in d:
            fields.append(k + "=?")
            args.append(d[k])
    if fields:
        args.append(cp_id)
        db.execute("UPDATE control_points SET %s WHERE id=?" % ",".join(fields), args)
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/control_points/<int:cp_id>", methods=["DELETE"])
def delete_cp(cp_id):
    db = get_db()
    db.execute("DELETE FROM control_points WHERE id=?", (cp_id,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 路由: 折线

@app.route("/api/maps/<int:map_id>/polylines", methods=["POST"])
def add_polyline(map_id):
    d = request.get_json(force=True)
    pts = d.get("points") or []
    if len(pts) < 2:
        return jsonify({"error": "折线至少需要 2 个顶点"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO polylines(map_id,name,kind,points) VALUES(?,?,?,?)",
        (map_id, d.get("name", ""), d.get("kind", "river"), json.dumps(pts)))
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.route("/api/polylines/<int:pl_id>", methods=["DELETE"])
def delete_polyline(pl_id):
    db = get_db()
    pl = rows("SELECT map_id FROM polylines WHERE id=?", (pl_id,))
    db.execute("DELETE FROM polylines WHERE id=?", (pl_id,))
    if pl:
        # 引用该折线端点的接边决定随之失效, 标为待复核
        like = "%:" + str(pl_id) + ":%"
        db.execute(
            "UPDATE edge_decisions SET status='review', "
            "updated_at=datetime('now','localtime') WHERE status='valid' "
            "AND (ep_a LIKE ? OR ep_b LIKE ?)", (like, like))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 路由: 版本

@app.route("/api/maps/<int:map_id>/versions", methods=["POST"])
def save_version(map_id):
    d = request.get_json(force=True) if request.data else {}
    st = map_state(map_id)
    if st is None:
        return jsonify({"error": "地图不存在"}), 404
    payload = {"control_points": st["control_points"],
               "polylines": st["polylines"], "diag": st["diag"]}
    db = get_db()
    cur = db.execute("INSERT INTO versions(map_id,name,payload) VALUES(?,?,?)",
                     (map_id, d.get("name", ""), json.dumps(payload)))
    db.commit()
    return jsonify({"id": cur.lastrowid})


@app.route("/api/versions/<int:vid>", methods=["GET"])
def get_version(vid):
    v = rows("SELECT * FROM versions WHERE id=?", (vid,))
    if not v:
        return jsonify({"error": "版本不存在"}), 404
    v[0]["payload"] = json.loads(v[0]["payload"])
    return jsonify(v[0])


@app.route("/api/versions/<int:vid>/restore", methods=["POST"])
def restore_version(vid):
    v = rows("SELECT * FROM versions WHERE id=?", (vid,))
    if not v:
        return jsonify({"error": "版本不存在"}), 404
    v = v[0]
    payload = json.loads(v["payload"])
    db = get_db()
    db.execute("DELETE FROM control_points WHERE map_id=?", (v["map_id"],))
    db.execute("DELETE FROM polylines WHERE map_id=?", (v["map_id"],))
    for c in payload.get("control_points", []):
        db.execute("INSERT INTO control_points(map_id,name,px,py,mx,my,enabled)"
                   " VALUES(?,?,?,?,?,?,?)",
                   (v["map_id"], c.get("name", ""), c["px"], c["py"],
                    c["mx"], c["my"], c.get("enabled", 1)))
    for pl in payload.get("polylines", []):
        db.execute("INSERT INTO polylines(map_id,name,kind,points) VALUES(?,?,?,?)",
                   (v["map_id"], pl.get("name", ""), pl.get("kind", "river"),
                    json.dumps(pl["points"])))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/versions/<int:vid>", methods=["DELETE"])
def delete_version(vid):
    db = get_db()
    db.execute("DELETE FROM versions WHERE id=?", (vid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 图幅接边校审

ANGLE_LIMIT = 45.0          # 两侧指向相邻顶点的向量反向后允许的最大夹角(度)
EPS = 1e-9


class ApiError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.message = message
        self.code = code


@app.errorhandler(ApiError)
def _api_error(e):
    return jsonify({"error": e.message}), e.code


def canonical_pair(id1, id2):
    """规范化地图对: 返回 (较小 id, 较大 id)"""
    return (id1, id2) if id1 < id2 else (id2, id1)


def ep_key(map_id, pl_id, end):
    """端点身份, 跨重算稳定(只要地图/折线未删除)"""
    return "%d:%d:%s" % (map_id, pl_id, end)


def parse_ep(key):
    """解析端点身份 '<map_id>:<polyline_id>:<head|tail>'"""
    try:
        mid_s, pid_s, end = key.split(":")
        mid, pid = int(mid_s), int(pid_s)
    except (ValueError, AttributeError):
        return None
    if end not in ("head", "tail"):
        return None
    return mid, pid, end


def _build_endpoints(state, map_id):
    """取出一张图全部折线的首/尾端点(现代坐标), 含接缝向量与夹角数据。

    返回 [{"key","map_id","polyline_id","end","kind","name",
           "x","y","ux","uy"（指向相邻顶点的单位向量，不存在则为 0,0）}, ...]
    """
    diag = state.get("diag")
    if not diag:
        return None
    t = diag["transform"]
    warp = {w["id"]: w["points"] for w in state.get("warped_polylines", [])}
    out = []
    for pl in state["polylines"]:
        pts = warp.get(pl["id"], [])
        if len(pts) < 2:
            continue
        for end, idx, nxt in (("head", 0, 1),
                              ("tail", len(pts) - 1, len(pts) - 2)):
            x, y = pts[idx]
            vx, vy = pts[nxt][0] - x, pts[nxt][1] - y
            norm = math.hypot(vx, vy)
            ux, uy = (vx / norm, vy / norm) if norm > EPS else (0.0, 0.0)
            out.append({"key": ep_key(map_id, pl["id"], end),
                        "map_id": map_id, "polyline_id": pl["id"], "end": end,
                        "kind": pl["kind"], "name": pl["name"] or "",
                        "x": x, "y": y, "ux": ux, "uy": uy})
    return out


def _seam_angle_reversed(ea, eb):
    """两侧端点向量反向后的夹角(度): B 侧向量取反后再求夹角。

    共线相向(接边处两侧折线指向彼此的反方向)时夹角为 0;
    垂直为 90°; 同向为 180°。容差为 45°。
    """
    if abs(ea["ux"]) < EPS and abs(eb["ux"]) < EPS:
        return None
    dot = ea["ux"] * (-eb["ux"]) + ea["uy"] * (-eb["uy"])
    dot = max(-1.0, min(1.0, dot))
    return math.degrees(math.acos(dot))


def hungarian(cost):
    """方阵最小权完美匹配(1-基 KM/Jonker 风格), 返回列选择数组 row->col。

    cost[i][j] 越大越差; 方阵由实端点 + 哑端点构成, 哑边即"不匹配"。
    """
    n = len(cost)
    if n == 0:
        return []
    u = [0.0] * (n + 1)
    v = [0.0] * (n + 1)
    p = [0] * (n + 1)
    way = [0] * (n + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [float("inf")] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = float("inf")
            j1 = 0
            for j in range(1, n + 1):
                if not used[j]:
                    cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    match = [0] * n
    for j in range(1, n + 1):
        if p[j] != 0:
            match[p[j] - 1] = j - 1
    return match


def pair_geometry(id_a, id_b, tolerance):
    """计算一对图幅的接边候选与全局最优一对一配对。

    候选条件: 同类折线端点, 现代坐标距离 <= tolerance,
              反向后夹角 <= 45°。
    配对目标(字典序): 匹配数最多 -> 总距离最小; 全局最优, 非逐端点贪心。
    """
    if tolerance is None or tolerance <= 0:
        raise ApiError("容差必须为正数")
    st_a = map_state(id_a)
    st_b = map_state(id_b)
    if st_a is None or st_b is None:
        raise ApiError("地图不存在", 404)
    if not st_a["diag"] or not st_b["diag"]:
        raise ApiError("两张地图都必须已完成仿射校正(至少 3 个启用的控制点)")
    eps_a = _build_endpoints(st_a, id_a)
    eps_b = _build_endpoints(st_b, id_b)

    # 候选: 只在同类端点之间生成
    candidates = []
    for ea in eps_a:
        for eb in eps_b:
            if ea["kind"] != eb["kind"]:
                continue
            dist = math.hypot(ea["x"] - eb["x"], ea["y"] - eb["y"])
            if dist > tolerance:
                continue
            ang = _seam_angle_reversed(ea, eb)
            if ang is not None and ang > ANGLE_LIMIT:
                continue
            candidates.append({"ep_a": ea["key"], "ep_b": eb["key"],
                               "kind": ea["kind"], "distance": dist,
                               "angle": ang})

    # 按 kind 分组各做一张二分图; 不同 kind 不竞争同一配对槽位
    selected = set()
    total_distance = 0.0
    kinds = sorted({c["kind"] for c in candidates})
    for kind in kinds:
        group = [c for c in candidates if c["kind"] == kind]
        ka = sorted({c["ep_a"] for c in group})
        kb = sorted({c["ep_b"] for c in group})
        ia = {k: i for i, k in enumerate(ka)}
        ib = {k: i for i, k in enumerate(kb)}
        feas = [[False] * len(kb) for _ in ka]
        dist = [[0.0] * len(kb) for _ in ka]
        for c in group:
            r, s = ia[c["ep_a"]], ib[c["ep_b"]]
            feas[r][s] = True
            dist[r][s] = c["distance"]
        n = max(len(ka), len(kb))
        # 代价编码(全部有限值, 避免浮点标量问题):
        #   不可行/哑边 = 1; 可行边 = distance/tolerance ∈ [0,1]
        # 每条不可行边比任何可行边至少差一个固定量, 故先最大化匹配数,
        # 同等匹配数下再最小化总距离。
        BIG = 1.0
        cost = [[BIG] * n for _ in range(n)]
        for r in range(len(ka)):
            for s in range(len(kb)):
                if feas[r][s]:
                    cost[r][s] = dist[r][s] / float(tolerance)
        for r, s in enumerate(hungarian(cost)):
            if r < len(ka) and s < len(kb) and feas[r][s]:
                selected.add((ka[r], kb[s]))
                total_distance += dist[r][s]

    for c in candidates:
        c["selected"] = (c["ep_a"], c["ep_b"]) in selected

    return {"maps": {"a": st_a["map"], "b": st_b["map"]},
            "endpoints_a": eps_a, "endpoints_b": eps_b,
            "candidates": candidates,
            "selected": [list(k) for k in sorted(selected)],
            "match_count": len(selected),
            "total_distance": total_distance,
            "tolerance": tolerance,
            "warped_a": st_a["warped_polylines"],
            "warped_b": st_b["warped_polylines"]}


def _sync_decisions(db, id_a, id_b, geo):
    """按最新几何重算持久化决定:

    - accepted(接受): 候选仍成立且仍在全局最优一对一配对中 -> valid, 否则 review
    - rejected(驳回): 候选几何仍成立即可保留为 valid(被否决的本就是某条候选);
      候选消失(超容差/夹角超限/端点删除) -> review
    - 距离/夹角快照随当前几何刷新
    """
    cand = {(c["ep_a"], c["ep_b"]): c for c in geo["candidates"]}
    selected = {tuple(s) for s in geo["selected"]}
    old_rows = rows(
        "SELECT * FROM edge_decisions WHERE map_a_id=? AND map_b_id=?",
        (id_a, id_b))
    for r in old_rows:
        key = (r["ep_a"], r["ep_b"])
        c = cand.get(key)
        if r["decision"] == "accepted":
            still = key in selected
        else:
            still = c is not None
        new_status = "valid" if still else "review"
        if new_status != r["status"] or (
                c and (r["distance"] is None
                       or abs(r["distance"] - c["distance"]) > EPS)):
            db.execute(
                "UPDATE edge_decisions SET status=?, distance=?, angle=?, "
                "updated_at=datetime('now','localtime') WHERE id=?",
                (new_status,
                 c["distance"] if c else r["distance"],
                 c["angle"] if c else r["angle"], r["id"]))
    # 重查: 返回已写入(尚未提交, 同连接可见)的最新状态
    fresh = rows(
        "SELECT * FROM edge_decisions WHERE map_a_id=? AND map_b_id=?",
        (id_a, id_b))
    return fresh, set(cand)


def edge_payload(id1, id2, tolerance):
    """组装接边视图数据: 几何 + 候选 + 最优配对 + 持久化决定(并重算其状态)"""
    id_a, id_b = canonical_pair(int(id1), int(id2))
    if id_a == id_b:
        raise ApiError("请选择两张不同的地图")
    db = get_db()
    geo = pair_geometry(id_a, id_b, tolerance)
    dec_rows, _ = _sync_decisions(db, id_a, id_b, geo)
    db.commit()
    dec = [{"id": r["id"], "ep_a": r["ep_a"], "ep_b": r["ep_b"],
            "decision": r["decision"], "status": r["status"],
            "distance": r["distance"], "angle": r["angle"],
            "reviewer_note": r["reviewer_note"],
            "created_at": r["created_at"], "updated_at": r["updated_at"]}
           for r in dec_rows]
    geo.update({"map_a_id": id_a, "map_b_id": id_b,
                "decisions": dec})
    return geo


@app.route("/api/edge/maps")
def edge_maps():
    """可参与接边的地图列表, 标注是否已具备仿射校正及折线段数"""
    out = []
    for m in rows("SELECT * FROM maps ORDER BY id"):
        st = map_state(m["id"])
        n_pl = len(st["polylines"]) if st else 0
        n_ep = len(_build_endpoints(st, m["id"])) if st and st["diag"] else 0
        out.append({"id": m["id"], "name": m["name"],
                    "warped": bool(st and st["diag"]),
                    "polyline_count": n_pl, "endpoint_count": n_ep})
    return jsonify(out)


@app.route("/api/edge/pairs/<int:id1>/<int:id2>")
def edge_pair_get(id1, id2):
    id_a, id_b = canonical_pair(id1, id2)
    if id_a == id_b:
        raise ApiError("请选择两张不同的地图")
    try:
        tol = float(request.args.get("tolerance", ""))
    except ValueError:
        raise ApiError("缺少有效的 tolerance 参数")
    return jsonify(edge_payload(id_a, id_b, tol))


@app.route("/api/edge/pairs/<int:id1>/<int:id2>/decisions", methods=["POST"])
def edge_decision_upsert(id1, id2):
    """校审员接受/驳回某个候选配对。按 地图对+端点身份 upsert。"""
    id_a, id_b = canonical_pair(id1, id2)
    if id_a == id_b:
        raise ApiError("请选择两张不同的地图")
    d = request.get_json(force=True)
    decision = d.get("decision")
    if decision not in ("accepted", "rejected"):
        raise ApiError("decision 必须是 accepted 或 rejected")
    ep_a, ep_b = d.get("ep_a"), d.get("ep_b")
    pa, pb = parse_ep(ep_a), parse_ep(ep_b)
    if not pa or not pb:
        raise ApiError("端点身份无效")
    # 端点必须分属规范化后的两张图
    if not ({pa[0], pb[0]} == {id_a, id_b}
            and (pa[0] == id_a and pb[0] == id_b)):
        raise ApiError("端点不属于所选地图对")
    try:
        tol = float(d.get("tolerance"))
    except (TypeError, ValueError):
        raise ApiError("缺少有效的 tolerance 参数")
    if tol <= 0:
        raise ApiError("容差必须为正数")

    geo = pair_geometry(id_a, id_b, tol)
    cand = {(c["ep_a"], c["ep_b"]): c for c in geo["candidates"]}
    key = (ep_a, ep_b)
    c = cand.get(key)
    if c is None:
        raise ApiError("该端点对不满足距离与夹角条件, 无法记录决定")

    db = get_db()
    # 提交前先按当前仿射校正与容差重算旧决定(与打开接边视图一致),
    # 避免控制点移动后旧的有效接受决定未及时转待复核而造成依赖查看顺序的误报。
    fresh_rows, _ = _sync_decisions(db, id_a, id_b, geo)
    if decision == "accepted":
        # 一对一: 任一端点已被"重算后仍有效"的接受配对占用则冲突
        clash = [(r["ep_a"], r["ep_b"]) for r in fresh_rows
                 if r["decision"] == "accepted" and r["status"] == "valid"
                 and (r["ep_a"] == ep_a or r["ep_b"] == ep_b)
                 and (r["ep_a"], r["ep_b"]) != key]
        if clash:
            # 旧接受仍有效且共享端点: 回滚本次重算, 不写入任何状态翻转或冲突决定
            db.rollback()
            raise ApiError("与已接受的一对一配对冲突, 请先驳回原决定", 409)

    db.execute(
        "INSERT INTO edge_decisions(map_a_id,map_b_id,ep_a,ep_b,decision,"
        "status,tolerance,distance,angle,reviewer_note) "
        "VALUES(?,?,?,?,?,'valid',?,?,?,?) "
        "ON CONFLICT(map_a_id,map_b_id,ep_a,ep_b) DO UPDATE SET "
        "decision=excluded.decision, status='valid', "
        "tolerance=excluded.tolerance, distance=excluded.distance, "
        "angle=excluded.angle, reviewer_note=excluded.reviewer_note, "
        "updated_at=datetime('now','localtime')",
        (id_a, id_b, ep_a, ep_b, decision, tol,
         c["distance"], c["angle"], d.get("note", "")))
    db.commit()
    return jsonify(edge_payload(id_a, id_b, tol))


@app.route("/api/edge/decisions/<int:dec_id>", methods=["DELETE"])
def edge_decision_delete(dec_id):
    """撤销一条接边决定(回到未决)。"""
    db = get_db()
    db.execute("DELETE FROM edge_decisions WHERE id=?", (dec_id,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 演示数据

def _demo_svg(W, H, paths, title, note="比例尺 1:50000"):
    """生成一张演示'古地图'SVG。paths: [(d, 颜色, 线宽, dasharray或None)]"""
    grid = "".join(
        '<line x1="%d" y1="0" x2="%d" y2="%d" stroke="#c9b98a" stroke-width="1"/>'
        '<line x1="0" y1="%d" x2="%d" y2="%d" stroke="#c9b98a" stroke-width="1"/>'
        % (x, x, H, y, y, W)
        for x in range(0, W + 1, 100) for y in [x] if y <= H)
    ps = ""
    for d, color, w, dash in paths:
        ps += ('<path d="%s" fill="none" stroke="%s" stroke-width="%d" '
               'stroke-linecap="round" opacity="0.85"%s/>'
               % (d, color, w, (' stroke-dasharray="%s"' % dash) if dash else ""))
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">'
        '<rect width="%d" height="%d" fill="#f3e9cf"/>%s%s'
        '<text x="30" y="40" font-size="26" fill="#6b5335" '
        'font-family="serif">%s</text>'
        '<text x="620" y="620" font-size="14" fill="#6b5335">%s</text>'
        '</svg>' % (W, H, W, H, grid, ps, title, note))


def _path_d(points):
    return "M" + " L".join("%d %d" % (p[0], p[1]) for p in points)


def _new_demo_map(db, name, svg):
    cur = db.execute("INSERT INTO maps(name) VALUES(?)", (name,))
    map_id = cur.lastrowid
    fname = "demo_%d.svg" % map_id
    with open(os.path.join(UPLOAD_DIR, fname), "w", encoding="utf-8") as fp:
        fp.write(svg)
    db.execute("UPDATE maps SET filename=? WHERE id=?", (fname, map_id))
    return map_id


@app.route("/api/demo", methods=["POST"])
def create_demo():
    """生成一张演示用'古地图'(SVG) + 控制点(含一个离群点) + 河流/道路折线"""
    W, H = 900, 640
    river = [[60, 600], [150, 520], [260, 470], [380, 430], [500, 380],
             [620, 330], [760, 300], [860, 260]]
    road = [[120, 80], [300, 180], [520, 260], [700, 400], [820, 560]]
    svg = _demo_svg(W, H, [
        (_path_d(river), "#7a9cc6", 6, None),
        (_path_d(road), "#a9805a", 4, "10 6"),
    ], "古地图 · 演示图幅")
    db = get_db()
    map_id = _new_demo_map(db, "演示图幅(自动生成)", svg)
    # 真实变换: mx = 2*px + 1000, my = -2*py + 2000; 第 6 点人为偏移 80 制造离群
    cps = [("CP1 城北", 100, 100, 0, 0), ("CP2 城东", 800, 100, 0, 0),
           ("CP3 城西", 100, 540, 0, 0), ("CP4 城南", 800, 540, 0, 0),
           ("CP5 钟楼", 450, 320, 5, -3), ("CP6 渡口(有误)", 620, 200, 80, 0)]
    for name, px, py, ex, ey in cps:
        db.execute("INSERT INTO control_points(map_id,name,px,py,mx,my)"
                   " VALUES(?,?,?,?,?,?)",
                   (map_id, name, px, py, 2 * px + 1000 + ex, -2 * py + 2000 + ey))
    db.execute("INSERT INTO polylines(map_id,name,kind,points) VALUES(?,?,?,?)",
               (map_id, "青河", "river", json.dumps(river)))
    db.execute("INSERT INTO polylines(map_id,name,kind,points) VALUES(?,?,?,?)",
               (map_id, "官道", "road", json.dumps(road)))
    db.commit()
    return jsonify({"id": map_id})


@app.route("/api/demo_edge", methods=["POST"])
def create_demo_edge():
    """生成两张东西相邻、可直接接边的演示图幅(各含 4 角控制点, 校正无残差)。

    东图河流在接缝附近分岔, 容差 200 时出现多个候选(冲突端点),
    全局最优一对一配对自动选出距离最小的一组; 另有一条灌渠两端均无候选(未匹配)。
    """
    W, H = 900, 640

    # ---- 西幅(A) ----
    a_river = [[60, 300], [200, 305], [360, 300], [520, 296], [700, 300],
               [860, 300]]
    a_trib = [[560, 180], [680, 240], [790, 282], [860, 285]]
    a_road = [[60, 520], [240, 516], [460, 522], [680, 520], [860, 520]]
    a_ditch = [[120, 120], [300, 140], [420, 110]]
    svg_a = _demo_svg(W, H, [
        (_path_d(a_river), "#7a9cc6", 6, None),
        (_path_d(a_trib), "#5d90b8", 4, None),
        (_path_d(a_road), "#a9805a", 4, "10 6"),
        (_path_d(a_ditch), "#5a8f6b", 3, "4 4"),
    ], "古地图 · 西幅")

    # ---- 东幅(B) ----
    b_main = [[40, 300], [220, 302], [400, 295], [620, 305], [840, 320]]
    b_branch = [[40, 257], [200, 230], [420, 200], [700, 170]]
    b_road = [[40, 520], [260, 524], [520, 518], [840, 520]]
    svg_b = _demo_svg(W, H, [
        (_path_d(b_main), "#7a9cc6", 6, None),
        (_path_d(b_branch), "#5d90b8", 4, None),
        (_path_d(b_road), "#a9805a", 4, "10 6"),
    ], "古地图 · 东幅")

    db = get_db()
    id_a = _new_demo_map(db, "演示接边 · 西幅", svg_a)
    id_b = _new_demo_map(db, "演示接边 · 东幅", svg_b)

    def corners(map_id, fx, fy):
        for name, px, py in [("西北角", 40, 40), ("东北角", 860, 40),
                             ("西南角", 40, 600), ("东南角", 860, 600)]:
            db.execute("INSERT INTO control_points(map_id,name,px,py,mx,my)"
                       " VALUES(?,?,?,?,?,?)",
                       (map_id, name, px, py, fx(px), fy(py)))

    # A: X = px + 1000, Y = -py + 2000 ; B: X = px + 2000, Y = -py + 2000
    corners(id_a, lambda x: x + 1000.0, lambda y: -y + 2000.0)
    corners(id_b, lambda x: x + 2000.0, lambda y: -y + 2000.0)

    for name, kind, pts in [
            ("青河(西段)", "river", a_river),
            ("北支河(西段)", "river", a_trib),
            ("官道(西段)", "road", a_road),
            ("灌渠", "other", a_ditch)]:
        db.execute("INSERT INTO polylines(map_id,name,kind,points) "
                   "VALUES(?,?,?,?)", (id_a, name, kind, json.dumps(pts)))
    for name, kind, pts in [
            ("青河(东段)", "river", b_main),
            ("北支河(东段)", "river", b_branch),
            ("官道(东段)", "road", b_road)]:
        db.execute("INSERT INTO polylines(map_id,name,kind,points) "
                   "VALUES(?,?,?,?)", (id_b, name, kind, json.dumps(pts)))
    db.commit()
    return jsonify({"id_a": id_a, "id_b": id_b, "tolerance": 200})


# ---------------------------------------------------------------- 启动

init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=True)
