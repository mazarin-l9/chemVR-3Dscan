// scan2png の中身（ブラウザと Node のどちらでも動く。依存なし）
//  - 点群PNG（scan2png 形式 v1）を作る・読む
//  - PLY（点群・メッシュ・3D Gaussian Splatting）と SPZ（Niantic の圧縮 Gaussian Splatting）を読む
//  - 三角形の表面から点を取る（テクスチャ・頂点色）
// 形式の説明は Assets/RoomBuilder/Shaders/ScanPointCloud.cginc（Unity 側の読み手）と同じ

export const MAX_SIZE = 2048;
export const MAX_POINTS = 200000;     // ワールドのビューアが描ける上限
export const DEFAULT_POINTS = 120000; // Quest で無理のない数

// ===== 点群PNG =====
// positions: Float32Array [x,y,z,...]（Unity の座標・m）, colors: Uint8Array [r,g,b,...]（sRGB）
// 戻り値: { width, height, rgba }（rgba は上の行から。PNG の並び）
export function encodePointCloud(positions, colors, { title = "", date = new Date() } = {}) {
  const n = positions.length / 3;
  if (n < 1) throw new Error("点がありません");
  const width = Math.min(MAX_SIZE, Math.max(64, Math.ceil(Math.sqrt(n * 3) / 64) * 64));
  const tileH = Math.ceil(n / width);
  const height = 1 + tileH * 3;
  if (height > MAX_SIZE) throw new Error(`点が多すぎます（${n}）`);

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a];
      if (v < mn[a]) mn[a] = v;
      if (v > mx[a]) mx[a] = v;
    }
  // ヘッダーは mm 単位なので、範囲も mm に丸めてから量子化する
  const lo = mn.map(v => Math.floor(v * 1000)), hi = mx.map(v => Math.ceil(v * 1000));
  for (let a = 0; a < 3; a++) if (hi[a] <= lo[a]) hi[a] = lo[a] + 1;

  // 下の行から数える画素（Unity のテクスチャと同じ）→ 最後に上下を入れ替える
  const px = new Uint8Array(width * height * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const set = (x, y, r, g, b) => { const o = (y * width + x) * 4; px[o] = r; px[o + 1] = g; px[o + 2] = b; };
  const u24 = (x, v) => set(x, 0, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  set(0, 0, 128, 83, 67);
  u24(1, 1);
  u24(2, n);
  u24(3, tileH);
  for (let a = 0; a < 3; a++) { u24(4 + a, lo[a] + 8388608); u24(7 + a, hi[a] + 8388608); }
  set(10, 0, 37, 199, 91);

  const bytes = titleBytes(title, (width - 15) * 3);
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * (i + 1)) % 16777216;
  u24(11, bytes.length);
  u24(12, sum);
  set(13, 0, date.getFullYear() - 2000, date.getMonth() + 1, date.getDate());
  set(14, 0, date.getHours(), date.getMinutes(), date.getSeconds());
  for (let i = 0; i < bytes.length; i++) px[(15 + Math.floor(i / 3)) * 4 + (i % 3)] = bytes[i];

  for (let i = 0; i < n; i++) {
    const col = i % width, row = Math.floor(i / width);
    const q = [0, 1, 2].map(a => Math.min(65535, Math.max(0,
      Math.round((positions[i * 3 + a] * 1000 - lo[a]) / (hi[a] - lo[a]) * 65535))));
    set(col, 1 + row, q[0] >> 8, q[1] >> 8, q[2] >> 8);
    set(col, 1 + tileH + row, q[0] & 255, q[1] & 255, q[2] & 255);
    set(col, 1 + tileH * 2 + row, colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
  }
  return { width, height, rgba: flipRows(px, width, height) };
}

function titleBytes(title, max) {
  let b = new TextEncoder().encode(title);
  if (b.length <= max) return b;
  let n = max;
  while (n > 0 && (b[n] & 0xc0) === 0x80) n--; // 文字の途中で切らない
  return b.slice(0, n);
}

function flipRows(px, width, height) {
  const out = new Uint8ClampedArray(px.length), stride = width * 4;
  for (let y = 0; y < height; y++) out.set(px.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  return out;
}

// PNG（上の行からの RGBA）から点群を読み戻す。壊れていれば { ok:false, reason }
export function decodePointCloud(width, height, rgbaTopDown) {
  const at = (x, y) => (( (height - 1 - y) * width + x) * 4); // y は下から
  const b = (x, y) => { const o = at(x, y); return [rgbaTopDown[o], rgbaTopDown[o + 1], rgbaTopDown[o + 2]]; };
  const u24 = (x) => { const [r, g, bb] = b(x, 0); return r * 65536 + g * 256 + bb; };
  const same = (x, v) => { const p = b(x, 0); return p[0] === v[0] && p[1] === v[1] && p[2] === v[2]; };
  if (width < 64 || height < 4) return { ok: false, reason: "小さすぎる画像です" };
  if (!same(0, [128, 83, 67]) || u24(1) !== 1 || !same(10, [37, 199, 91]))
    return { ok: false, reason: "目印が合いません（点群PNGではないか、再圧縮されています）" };
  const n = u24(2), tileH = u24(3);
  if (tileH * 3 + 1 !== height || n > tileH * width || n < 1) return { ok: false, reason: "大きさが合いません（縮小・切り抜きされています）" };
  const lo = [4, 5, 6].map(x => u24(x) - 8388608), hi = [7, 8, 9].map(x => u24(x) - 8388608);
  const len = u24(11), sum = u24(12);
  const bytes = new Uint8Array(len);
  let check = 0;
  for (let i = 0; i < len; i++) { bytes[i] = b(15 + Math.floor(i / 3), 0)[i % 3]; check = (check + bytes[i] * (i + 1)) % 16777216; }
  const title = check === sum ? new TextDecoder().decode(bytes) : "";
  const [Y, M, D] = b(13, 0), [h, m] = b(14, 0);
  const positions = new Float32Array(n * 3), colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const col = i % width, row = Math.floor(i / width);
    const H = b(col, 1 + row), L = b(col, 1 + tileH + row), C = b(col, 1 + tileH * 2 + row);
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = (lo[a] + (hi[a] - lo[a]) * ((H[a] * 256 + L[a]) / 65535)) / 1000;
      colors[i * 3 + a] = C[a];
    }
  }
  return { ok: true, count: n, title, titleOk: check === sum, date: Y ? `${2000 + Y}/${M}/${D} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : "",
           positions, colors, min: lo.map(v => v / 1000), max: hi.map(v => v / 1000) };
}

// ===== PNG の書き出し（無圧縮の色のまま。CompressionStream があればそれで、なければ呼び出し側で canvas を使う）=====
export async function pngBytes(width, height, rgba) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // フィルタなし
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const zipped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8bit RGBA
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zipped), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC_TABLE[(c ^ out[i]) & 255] ^ (c >>> 8);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

// ===== 点の間引き・座標の向き =====
// 決まった種から作る乱数（同じファイルなら毎回同じ結果）
export function rng(seed = 12345) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function subsample(cloud, budget, seed = 1) {
  const n = cloud.positions.length / 3;
  if (n <= budget) return cloud;
  const r = rng(seed), idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = 0; i < budget; i++) { const j = i + Math.floor(r() * (n - i)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  const positions = new Float32Array(budget * 3), colors = new Uint8Array(budget * 3);
  for (let k = 0; k < budget; k++)
    for (let a = 0; a < 3; a++) { positions[k * 3 + a] = cloud.positions[idx[k] * 3 + a]; colors[k * 3 + a] = cloud.colors[idx[k] * 3 + a]; }
  return { positions, colors };
}

// スキャンアプリの座標（右手系）を Unity（左手系・Y が上）にする。up: "y" | "-y" | "z" | "-z"
export function toUnity(cloud, up = "y") {
  const p = cloud.positions, out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    let x = p[i], y = p[i + 1], z = p[i + 2];
    if (up === "-y") { y = -y; z = -z; }
    else if (up === "z") { const t = y; y = z; z = -t; }
    else if (up === "-z") { const t = y; y = -z; z = t; }
    out[i] = -x; out[i + 1] = y; out[i + 2] = z; // X を反転（glTFast・Unity の OBJ 読み込みと同じ）
  }
  return { positions: out, colors: cloud.colors };
}

// 飛び離れた点（スキャンの外れ値）を除く：各軸で上下 trim の割合を外した範囲を広げた箱の外を捨てる
export function removeOutliers(cloud, trim = 0.005, margin = 0.15) {
  const n = cloud.positions.length / 3;
  if (n < 1000) return cloud;
  const lo = [], hi = [];
  for (let a = 0; a < 3; a++) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = cloud.positions[i * 3 + a];
    v.sort();
    const l = v[Math.floor(n * trim)], h = v[Math.floor(n * (1 - trim)) - 1], m = (h - l) * margin;
    lo.push(l - m); hi.push(h + m);
  }
  const keep = [];
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (let a = 0; a < 3 && ok; a++) { const v = cloud.positions[i * 3 + a]; ok = v >= lo[a] && v <= hi[a]; }
    if (ok) keep.push(i);
  }
  const positions = new Float32Array(keep.length * 3), colors = new Uint8Array(keep.length * 3);
  keep.forEach((i, k) => { for (let a = 0; a < 3; a++) { positions[k * 3 + a] = cloud.positions[i * 3 + a]; colors[k * 3 + a] = cloud.colors[i * 3 + a]; } });
  return { positions, colors };
}

// ===== 床・台の面と、離れたかけらを消す（物のスキャン向け）=====
// 物のスキャンには、置いていた机や床の一部と、宙に浮いた小さなかけらが入りやすい。
// 表示はいちばん長い辺に合わせて縮めるので、それらがあると物が小さく見える。
// 1) 下のほうにある大きな平面（傾いていてもよい）を探して、その面と面より下の点を消す
// 2) 点を小さな箱に分けてつながりを調べ、いちばん大きなかたまりだけ残す
// cloud は Unity の座標（Y が上）
export function cleanObject(cloud, { seed = 3 } = {}) {
  const ground = findGroundPlane(cloud, seed);
  let c = ground ? cutBelowPlane(cloud, ground) : cloud;
  c = keepLargestCluster(c);
  return { cloud: c, plane: ground, box: bounds(c.positions) };
}

function bounds(p) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[i + a]); mx[a] = Math.max(mx[a], p[i + a]); }
  return { mn, mx, diag: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) };
}

function pick(cloud, keep) {
  const n = keep.length, positions = new Float32Array(n * 3), colors = new Uint8Array(n * 3);
  for (let k = 0; k < n; k++)
    for (let a = 0; a < 3; a++) { positions[k * 3 + a] = cloud.positions[keep[k] * 3 + a]; colors[k * 3 + a] = cloud.colors[keep[k] * 3 + a]; }
  return { positions, colors };
}

// 床・台の平面 { nx, ny, nz, d, t }（なければ null）。速くするため、点を間引いて調べる
export function findGroundPlane(cloud, seed = 3) {
  const all = cloud.positions, total = all.length / 3;
  if (total < 1000) return null;
  const stride = Math.max(1, Math.floor(total / 40000));
  const idx = [];
  for (let i = 0; i < total; i += stride) idx.push(i);
  const n = idx.length;
  const P = (q, a) => all[idx[q] * 3 + a];
  const b = bounds(all), height = b.mx[1] - b.mn[1];
  const t = Math.max(0.003, b.diag * 0.008); // 面の厚み
  // 下から 40% の高さにある点から3点を選んで平面を作り、乗っている点がいちばん多いものを採る
  const low = [];
  for (let q = 0; q < n; q++) if (P(q, 1) < b.mn[1] + height * 0.4) low.push(q);
  if (low.length < 100) return null;
  const r = rng(seed);
  let best = null, bestCount = 0;
  for (let it = 0; it < 300; it++) {
    const [i, j, k] = [0, 0, 0].map(() => low[Math.floor(r() * low.length)]);
    const ux = P(j, 0) - P(i, 0), uy = P(j, 1) - P(i, 1), uz = P(j, 2) - P(i, 2);
    const vx = P(k, 0) - P(i, 0), vy = P(k, 1) - P(i, 1), vz = P(k, 2) - P(i, 2);
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (ny < Math.cos(35 * Math.PI / 180)) continue; // ほぼ水平な面だけ
    const d = -(nx * P(i, 0) + ny * P(i, 1) + nz * P(i, 2));
    let count = 0;
    for (let q = 0; q < n; q++) if (Math.abs(nx * P(q, 0) + ny * P(q, 1) + nz * P(q, 2) + d) < t) count++;
    if (count > bestCount) { bestCount = count; best = { nx, ny, nz, d, t }; }
  }
  // 点の 8% 以上が乗る面だけを床・台とみなす（小さな平らな部分は物の一部かもしれない）
  if (!best || bestCount < n * 0.08) return null;
  let above = 0;
  for (let q = 0; q < n; q++) if (best.nx * P(q, 0) + best.ny * P(q, 1) + best.nz * P(q, 2) + best.d > best.t * 1.5) above++;
  if (above < n * 0.02) return null; // ほとんど消えるなら、平面ではなく物そのものだった
  return best;
}

// 平面より上（物）の点だけ残す
export function cutBelowPlane(cloud, pl) {
  const p = cloud.positions, n = p.length / 3, keep = [];
  for (let q = 0; q < n; q++) if (pl.nx * p[q * 3] + pl.ny * p[q * 3 + 1] + pl.nz * p[q * 3 + 2] + pl.d > pl.t * 1.5) keep.push(q);
  return pick(cloud, keep);
}

// 箱（少し広げる）の中の点だけ残す
function cropToBox(cloud, box) {
  const p = cloud.positions, n = p.length / 3, m = box.diag * 0.03, keep = [];
  for (let q = 0; q < n; q++) {
    let ok = true;
    for (let a = 0; a < 3 && ok; a++) ok = p[q * 3 + a] >= box.mn[a] - m && p[q * 3 + a] <= box.mx[a] + m;
    if (ok) keep.push(q);
  }
  return pick(cloud, keep);
}

export function keepLargestCluster(cloud) {
  const p = cloud.positions, n = p.length / 3;
  if (n < 1000) return cloud;
  const b = bounds(p);
  // 箱の大きさ：全体の 1/70 か、点の間隔の目安（表面の点として √(面積/点の数)）の 2.5 倍の大きいほう。点がまばらでもつながるように
  const cell = Math.max(1e-4, b.diag / 70, 2.5 * b.diag / Math.sqrt(n));
  const key = (i) => Math.floor((p[i * 3] - b.mn[0]) / cell) + "," + Math.floor((p[i * 3 + 1] - b.mn[1]) / cell) + "," + Math.floor((p[i * 3 + 2] - b.mn[2]) / cell);
  const cells = new Map(); // "x,y,z" → 点の番号の配列
  for (let i = 0; i < n; i++) { const k = key(i); let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(i); }
  const label = new Map();
  let bestLabel = -1, bestSize = 0, next = 0;
  for (const start of cells.keys()) {
    if (label.has(start)) continue;
    const id = next++;
    let size = 0;
    const stack = [start];
    label.set(start, id);
    while (stack.length) {
      const k = stack.pop();
      size += cells.get(k).length;
      const [x, y, z] = k.split(",").map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const nk = (x + dx) + "," + (y + dy) + "," + (z + dz);
        if (cells.has(nk) && !label.has(nk)) { label.set(nk, id); stack.push(nk); }
      }
    }
    if (size > bestSize) { bestSize = size; bestLabel = id; }
  }
  // いちばん大きなかたまりが全体の半分もないなら、物が分かれて写っている（かけらではない）ので消さない
  if (bestSize < n * 0.5) return cloud;
  const keep = [];
  for (const [k, a] of cells) if (label.get(k) === bestLabel) for (const i of a) keep.push(i);
  keep.sort((x, y) => x - y);
  return pick(cloud, keep);
}

// ===== 三角形の表面から点を取る =====
// meshes: [{ positions: Float32Array, indices: Uint32Array|null, uvs: Float32Array|null, colors: Float32Array|null（0..1 の sRGB）,
//            texture: { width, height, data: Uint8ClampedArray（上の行から RGBA）, flipY: bool } | null, tint: [r,g,b]（0..1 sRGB） }]
export function sampleMeshes(meshes, count, seed = 7) {
  const tris = [];
  let total = 0;
  meshes.forEach((m, mi) => {
    const nTri = m.indices ? m.indices.length / 3 : m.positions.length / 9;
    for (let t = 0; t < nTri; t++) {
      const i0 = m.indices ? m.indices[t * 3] : t * 3, i1 = m.indices ? m.indices[t * 3 + 1] : t * 3 + 1, i2 = m.indices ? m.indices[t * 3 + 2] : t * 3 + 2;
      const P = m.positions;
      const ax = P[i1 * 3] - P[i0 * 3], ay = P[i1 * 3 + 1] - P[i0 * 3 + 1], az = P[i1 * 3 + 2] - P[i0 * 3 + 2];
      const bx = P[i2 * 3] - P[i0 * 3], by = P[i2 * 3 + 1] - P[i0 * 3 + 1], bz = P[i2 * 3 + 2] - P[i0 * 3 + 2];
      const area = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      if (!(area > 0)) continue;
      total += area;
      tris.push(mi, i0, i1, i2, total);
    }
  });
  const nt = tris.length / 5;
  if (nt === 0) throw new Error("三角形がありません");
  const cum = new Float64Array(nt);
  for (let t = 0; t < nt; t++) cum[t] = tris[t * 5 + 4];

  const r = rng(seed);
  const positions = new Float32Array(count * 3), colors = new Uint8Array(count * 3);
  for (let k = 0; k < count; k++) {
    const x = r() * total;
    let lo = 0, hi = nt - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
    const m = meshes[tris[lo * 5]], ids = [tris[lo * 5 + 1], tris[lo * 5 + 2], tris[lo * 5 + 3]];
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = [1 - u - v, u, v];
    for (let a = 0; a < 3; a++) positions[k * 3 + a] = w[0] * m.positions[ids[0] * 3 + a] + w[1] * m.positions[ids[1] * 3 + a] + w[2] * m.positions[ids[2] * 3 + a];
    let c = m.tint ? [...m.tint] : [1, 1, 1];
    if (m.colors) for (let a = 0; a < 3; a++) c[a] *= w[0] * m.colors[ids[0] * 3 + a] + w[1] * m.colors[ids[1] * 3 + a] + w[2] * m.colors[ids[2] * 3 + a];
    if (m.texture && m.uvs) {
      const tu = w[0] * m.uvs[ids[0] * 2] + w[1] * m.uvs[ids[1] * 2] + w[2] * m.uvs[ids[2] * 2];
      const tv = w[0] * m.uvs[ids[0] * 2 + 1] + w[1] * m.uvs[ids[1] * 2 + 1] + w[2] * m.uvs[ids[2] * 2 + 1];
      const T = m.texture;
      const fu = tu - Math.floor(tu), fv = tv - Math.floor(tv);
      const px = Math.min(T.width - 1, Math.floor(fu * T.width));
      const py = Math.min(T.height - 1, Math.floor((T.flipY ? 1 - fv : fv) * T.height));
      const o = (py * T.width + px) * 4;
      for (let a = 0; a < 3; a++) c[a] *= T.data[o + a] / 255;
    }
    for (let a = 0; a < 3; a++) colors[k * 3 + a] = Math.max(0, Math.min(255, Math.round(c[a] * 255)));
  }
  return { positions, colors };
}

// ===== PLY =====
// 点群（x,y,z + red,green,blue）、メッシュ（face があれば表面から点を取れる）、3D Gaussian Splatting（f_dc_0..2・opacity）
export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  const headerEnd = findHeaderEnd(bytes);
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd)).split(/\r?\n/);
  let format = "ascii";
  const elements = [];
  for (const line of header) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "element") elements.push({ name: t[1], count: parseInt(t[2]), props: [] });
    else if (t[0] === "property") {
      const e = elements[elements.length - 1];
      if (t[1] === "list") e.props.push({ name: t[4], list: true, countType: t[2], type: t[3] });
      else e.props.push({ name: t[2], type: t[1] });
    }
  }
  const data = {};
  if (format === "ascii") {
    const text = new TextDecoder().decode(bytes.subarray(headerEnd)).split(/\r?\n/);
    let li = 0;
    for (const e of elements) {
      const rows = [];
      for (let r = 0; r < e.count; r++) {
        while (li < text.length && text[li].trim() === "") li++;
        const v = text[li++].trim().split(/\s+/).map(Number);
        rows.push(v);
      }
      data[e.name] = { element: e, rows };
    }
  } else {
    const little = format === "binary_little_endian";
    const dv = new DataView(buffer, headerEnd);
    let o = 0;
    const read = (type) => {
      switch (type) {
        case "char": case "int8": { const v = dv.getInt8(o); o += 1; return v; }
        case "uchar": case "uint8": { const v = dv.getUint8(o); o += 1; return v; }
        case "short": case "int16": { const v = dv.getInt16(o, little); o += 2; return v; }
        case "ushort": case "uint16": { const v = dv.getUint16(o, little); o += 2; return v; }
        case "int": case "int32": { const v = dv.getInt32(o, little); o += 4; return v; }
        case "uint": case "uint32": { const v = dv.getUint32(o, little); o += 4; return v; }
        case "float": case "float32": { const v = dv.getFloat32(o, little); o += 4; return v; }
        case "double": case "float64": { const v = dv.getFloat64(o, little); o += 8; return v; }
        default: throw new Error("PLY の型が読めません: " + type);
      }
    };
    for (const e of elements) {
      // 頂点は数が多いので、列ごとの Float32Array に直接読む
      const columns = {};
      const lists = {};
      e.props.forEach(p => { if (p.list) lists[p.name] = []; else columns[p.name] = new Float32Array(e.count); });
      for (let r = 0; r < e.count; r++)
        for (const p of e.props) {
          if (p.list) { const n = read(p.countType); const l = new Array(n); for (let k = 0; k < n; k++) l[k] = read(p.type); lists[p.name].push(l); }
          else columns[p.name][r] = read(p.type);
        }
      data[e.name] = { element: e, columns, lists };
    }
  }
  return plyToCloud(data);
}

function findHeaderEnd(bytes) {
  const key = "end_header";
  for (let i = 0; i < Math.min(bytes.length, 1 << 20); i++) {
    let ok = true;
    for (let k = 0; k < key.length && ok; k++) ok = bytes[i + k] === key.charCodeAt(k);
    if (ok) { let j = i + key.length; while (bytes[j] !== 10) j++; return j + 1; }
  }
  throw new Error("PLY のヘッダーが見つかりません");
}

function plyToCloud(data) {
  const v = data.vertex;
  if (!v) throw new Error("PLY に頂点がありません");
  const n = v.element.count;
  const names = v.element.props.map(p => p.name);
  const col = (name) => {
    if (v.columns) return v.columns[name];
    const i = names.indexOf(name), out = new Float32Array(n);
    for (let r = 0; r < n; r++) out[r] = v.rows[r][i];
    return out;
  };
  const has = (name) => names.includes(name);
  const X = col("x"), Y = col("y"), Z = col("z");
  const colors = new Uint8Array(n * 3);
  let kind = "points";
  if (has("f_dc_0")) {
    // 3D Gaussian Splatting：0 次の球面調和の色（＋不透明度の低い点は捨てる）
    kind = "splat";
    const R = col("f_dc_0"), G = col("f_dc_1"), B = col("f_dc_2");
    for (let i = 0; i < n; i++) {
      colors[i * 3] = sh0(R[i]); colors[i * 3 + 1] = sh0(G[i]); colors[i * 3 + 2] = sh0(B[i]);
    }
  } else {
    const pick = (...cands) => cands.find(c => has(c));
    const rn = pick("red", "r", "diffuse_red"), gn = pick("green", "g", "diffuse_green"), bn = pick("blue", "b", "diffuse_blue");
    if (rn && gn && bn) {
      const R = col(rn), G = col(gn), B = col(bn);
      const type = v.element.props.find(p => p.name === rn).type;
      const s = type.startsWith("float") || type === "double" ? 255 : (type.includes("short") || type.includes("16") ? 1 / 257 : 1);
      for (let i = 0; i < n; i++) { colors[i * 3] = R[i] * s; colors[i * 3 + 1] = G[i] * s; colors[i * 3 + 2] = B[i] * s; }
    } else colors.fill(200);
  }
  let keep = null;
  if (kind === "splat" && has("opacity")) {
    const O = col("opacity");
    keep = [];
    for (let i = 0; i < n; i++) if (1 / (1 + Math.exp(-O[i])) > 0.2) keep.push(i); // 半透明すぎる霧のような点を除く
  }
  const idx = keep || Array.from({ length: n }, (_, i) => i);
  const positions = new Float32Array(idx.length * 3), cols = new Uint8Array(idx.length * 3);
  idx.forEach((i, k) => {
    positions[k * 3] = X[i]; positions[k * 3 + 1] = Y[i]; positions[k * 3 + 2] = Z[i];
    cols[k * 3] = colors[i * 3]; cols[k * 3 + 1] = colors[i * 3 + 1]; cols[k * 3 + 2] = colors[i * 3 + 2];
  });

  // 面があればメッシュとしても返す（点が少ないときは表面から取る）
  let faces = null;
  const f = data.face;
  if (f && f.element.count > 0 && !keep) {
    const listName = f.element.props.find(p => p.list)?.name;
    const lists = f.lists ? f.lists[listName] : f.rows.map(r => r.slice(1, 1 + r[0]));
    const tri = [];
    for (const l of lists) for (let k = 1; k + 1 < l.length; k++) tri.push(l[0], l[k], l[k + 1]);
    faces = Uint32Array.from(tri);
  }
  return { kind, positions, colors: cols, faces, vertexCount: n };
}

const SH_C0 = 0.28209479177387814;
function sh0(v) { return Math.max(0, Math.min(255, Math.round((0.5 + SH_C0 * v) * 255))); }

// ===== SPZ（Niantic / Scaniverse の圧縮 Gaussian Splatting）=====
// gzip の中に: ヘッダー 16 バイト（magic 'NGSP', version, 点の数, SH の次数, 小数部のビット数, flags, reserved）、
// 位置（v1: float16×3, v2以降: 24bit 固定小数×3）、不透明度（uchar）、色（uchar×3）、…（大きさ・回転・SH は使わない）
export async function parseSPZ(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x5053474e) throw new Error("SPZ ではありません");
  const version = dv.getUint32(4, true), n = dv.getUint32(8, true), fractional = dv.getUint8(13);
  let o = 16;
  const positions = new Float32Array(n * 3);
  if (version === 1) {
    for (let i = 0; i < n * 3; i++) positions[i] = half(dv.getUint16(o + i * 2, true));
    o += n * 6;
  } else {
    const s = 1 / (1 << fractional);
    for (let i = 0; i < n * 3; i++) {
      let v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      if (v & 0x800000) v |= ~0xffffff;
      positions[i] = v * s;
      o += 3;
    }
  }
  const alpha = bytes.subarray(o, o + n); o += n;
  const colorBytes = bytes.subarray(o, o + n * 3);
  // 色は (sh0 * 0.15 + 0.5) * 255 で入っている → 表示色 0.5 + C0 * sh0
  const keep = [];
  for (let i = 0; i < n; i++) if (alpha[i] / 255 > 0.2) keep.push(i);
  const P = new Float32Array(keep.length * 3), C = new Uint8Array(keep.length * 3);
  keep.forEach((i, k) => {
    for (let a = 0; a < 3; a++) {
      P[k * 3 + a] = positions[i * 3 + a];
      C[k * 3 + a] = sh0((colorBytes[i * 3 + a] / 255 - 0.5) / 0.15);
    }
  });
  return { kind: "splat", positions: P, colors: C, faces: null, vertexCount: n };
}

function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

// ===== 1つにまとめる：ファイルの中身 → 点群（Unity の座標）=====
// source: { cloud }（PLY/SPZ の結果）または { meshes }（sampleMeshes の入力）
// clean: 床・台の面と離れたかけらを消す（物のスキャン向け。部屋・景色のスキャンでは false に）
export function buildCloud(source, { budget = DEFAULT_POINTS, up = "y", outliers = true, clean = false } = {}) {
  budget = Math.min(MAX_POINTS, Math.max(1000, budget | 0));
  // 消す分を見込んで多めに点を取り、最後に budget まで減らす
  const take = clean ? budget * 3 : budget;
  let cloud;
  if (source.meshes) cloud = sampleMeshes(source.meshes, take);
  else if (source.cloud.faces && source.cloud.positions.length / 3 < take) {
    // 頂点の少ないメッシュの PLY は表面から取る（頂点色を補間）
    const c = source.cloud, colors = new Float32Array(c.colors.length);
    for (let i = 0; i < colors.length; i++) colors[i] = c.colors[i] / 255;
    cloud = sampleMeshes([{ positions: c.positions, indices: c.faces, colors, uvs: null, texture: null }], take);
  } else cloud = subsample(source.cloud, take);
  if (outliers) cloud = removeOutliers(cloud);
  cloud = toUnity(cloud, up);
  if (clean) {
    const c = cleanObject(cloud);
    cloud = c.cloud;
    // 物が全体の一部だけだったときは、メッシュならもう一度たくさん点を取り、床の面より上・物の箱の中だけ使う
    const kept = cloud.positions.length / 3;
    if (source.meshes && kept < budget && kept > 0) {
      const more = Math.min(4000000, Math.ceil(take * budget / kept * 1.3));
      let again = toUnity(sampleMeshes(source.meshes, more, 11), up);
      if (c.plane) again = cutBelowPlane(again, c.plane);
      cloud = cropToBox(again, c.box);
    }
    cloud = subsample(cloud, budget);
  }
  return cloud;
}
