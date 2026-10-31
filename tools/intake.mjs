// フォームから届いたスキャンを点群PNGにして、空いているスロットに入れる（GitHub Actions の scan-intake から動かす）
//
// incoming/<名前>.json … { "title": "題名", "time": "2026-10-31T11:21:20+09:00", "link": "https://…", "file": "incoming/…glb" }
//   link: KIRI Engine の共有リンク（https://www.kiriengine.app/share/shareModel/<id>）か、モデルのファイルを直接さす URL
//   file: Apps Script がリポジトリに上げたモデルのファイル（GLB / glTF(GLB) / OBJ の ZIP / PLY / SPZ）
// 結果は scans/slotN.png と scans/slots.json（どのスロットに何を入れたか）。失敗したものは incoming/failed/ に理由と一緒に移す
//
// 使い方: node tools/intake.mjs   （リポジトリのいちばん上で）
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { unzipSync } from "fflate";
import { encodePointCloud, decodePointCloud, pngBytes, parsePLY, parseSPZ, buildCloud, DEFAULT_POINTS } from "../scan2png-core.js";

const SLOT_COUNT = 64;
let io; // glTF の読み込み（Draco 付き）。最初に使うときに作る
const MAX_DOWNLOAD = 150 * 1024 * 1024;

const slotsPath = "scans/slots.json";
const slots = existsSync(slotsPath) ? JSON.parse(readFileSync(slotsPath, "utf8")) : {};
mkdirSync("incoming/failed", { recursive: true });

const jobs = readdirSync("incoming").filter(f => f.endsWith(".json")).sort();
const failures = []; // 失敗したもの（ワークフローが GitHub の Issue にして知らせる）
if (jobs.length === 0) console.log("新しいスキャンはありません");

for (const name of jobs) {
  const jobPath = join("incoming", name);
  let job;
  try {
    job = JSON.parse(readFileSync(jobPath, "utf8"));
    const slot = nextFreeSlot();
    if (!slot) throw new Error("空いているスロットがありません（64 個すべて使用済み）");
    const { bytes, fileName } = await fetchModel(job);
    const source = await loadSource(bytes, fileName);
    const cloud = buildCloud(source, { budget: DEFAULT_POINTS, up: "y", outliers: true, clean: true });
    const title = (job.title || basename(fileName, extname(fileName))).trim().slice(0, 40);
    const date = job.time ? new Date(job.time) : new Date();
    const img = encodePointCloud(cloud.positions, cloud.colors, { title, date });
    const back = decodePointCloud(img.width, img.height, img.rgba);
    if (!back.ok) throw new Error("作った画像の読み戻しに失敗: " + back.reason);
    writeFileSync(`scans/slot${slot}.png`, await pngBytes(img.width, img.height, img.rgba));
    slots[slot] = { title, time: job.time || date.toISOString(), source: job.link || job.file || "", points: back.count, kind: source.kind };
    writeFileSync(slotsPath, JSON.stringify(slots, null, 2) + "\n");
    cleanup(jobPath, job);
    console.log(`slot${slot}: ${title}（${back.count} 点、${source.kind}）`);
  } catch (e) {
    console.error(`${name}: 失敗: ${e.message}`);
    failures.push(`- ${job && job.title ? job.title : name}: ${e.message}（${job && (job.link || job.file) || ""}）`);
    const failed = join("incoming/failed", name);
    writeFileSync(failed, JSON.stringify({ ...(job || {}), error: String(e.message || e) }, null, 2) + "\n");
    unlinkSync(jobPath);
    if (job && job.file && existsSync(job.file)) renameSync(job.file, join("incoming/failed", basename(job.file)));
  }
}

if (failures.length) writeFileSync(".intake-failures.txt", failures.join("\n") + "\n");

// 1 から順に、slots.json にない番号
function nextFreeSlot() {
  for (let i = 1; i <= SLOT_COUNT; i++) if (!slots[i]) return i;
  return 0;
}

function cleanup(jobPath, job) {
  unlinkSync(jobPath);
  if (job.file && existsSync(job.file)) unlinkSync(job.file);
}

// ===== モデルのファイルを用意する =====
async function fetchModel(job) {
  if (job.file) {
    if (!existsSync(job.file)) throw new Error(`ファイルがありません: ${job.file}`);
    return { bytes: new Uint8Array(readFileSync(job.file)), fileName: basename(job.file) };
  }
  if (!job.link) throw new Error("リンクもファイルもありません");
  const url = new URL(job.link.trim());
  // KIRI Engine の共有リンク → 共有ページが読み込むモデル（Draco 圧縮の GLB）
  const kiri = url.hostname.endsWith("kiriengine.app") && url.pathname.match(/shareModel\/([0-9a-f]{32})/i);
  // Scaniverse の共有リンク（https://scaniverse.com/scan/<id>）→ 共有ページが読み込む Gaussian Splatting（SPZ）
  const scaniverse = url.hostname.endsWith("scaniverse.com") && url.pathname.match(/\/scan\/([0-9a-z]+)/i);
  const target = kiri ? `https://display.kiriengine.com/${kiri[1]}/3DModel_Display.glb`
               : scaniverse ? `https://scaniverse.com/api/media/${scaniverse[1]}/gaussians.spz`
               : url.href;
  const res = await fetch(target, { redirect: "follow" });
  if (!res.ok) throw new Error(`ダウンロードできません（HTTP ${res.status}）: ${target}`);
  const size = Number(res.headers.get("content-length") || 0);
  if (size > MAX_DOWNLOAD) throw new Error(`ファイルが大きすぎます（${(size / 1048576).toFixed(0)} MB）`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const fileName = kiri ? "kiri.glb" : scaniverse ? "scaniverse.spz" : basename(url.pathname) || "model";
  return { bytes, fileName };
}

// ===== 読み込み（Web 版の loadSource と同じ結果の形にする）=====
async function loadSource(bytes, fileName) {
  const head = new TextDecoder().decode(bytes.subarray(0, 4));
  let ext = extname(fileName).toLowerCase();
  if (head === "glTF") ext = ".glb";
  else if (bytes[0] === 0x50 && bytes[1] === 0x4b) ext = ".zip";
  else if (head.startsWith("ply")) ext = ".ply";
  else if (bytes[0] === 0x1f && bytes[1] === 0x8b) ext = ".spz";

  if (ext === ".ply") {
    const cloud = parsePLY(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { cloud, kind: cloud.kind === "splat" ? "PLY（Gaussian Splatting）" : cloud.faces ? "PLY メッシュ" : "PLY 点群" };
  }
  if (ext === ".spz") return { cloud: await parseSPZ(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), kind: "SPZ（Gaussian Splatting）" };
  if (ext === ".glb") return { meshes: await loadGlb(bytes), kind: "GLB メッシュ" };
  if (ext === ".zip") {
    const files = unzipSync(bytes);
    const names = Object.keys(files).filter(n => !n.endsWith("/") && !n.startsWith("__MACOSX"));
    const pickName = (re) => names.find(n => re.test(n));
    const inner = pickName(/\.glb$/i) || pickName(/\.ply$/i) || pickName(/\.spz$/i);
    if (inner) return loadSource(files[inner], basename(inner));
    const obj = pickName(/\.obj$/i);
    if (obj) return { meshes: loadObj(files, names, obj), kind: "OBJ メッシュ" };
    throw new Error("ZIP の中にモデル（OBJ / GLB / PLY / SPZ）がありません");
  }
  throw new Error(`この形式は読めません: ${ext || fileName}（GLB / OBJ の ZIP / PLY / SPZ）`);
}

async function loadGlb(bytes) {
  if (!io) io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
  const doc = await io.readBinary(bytes);
  const meshes = [];
  const textures = new Map();
  for (const scene of doc.getRoot().listScenes())
  scene.traverse(node => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // 三角形だけ
      const pos = prim.getAttribute("POSITION");
      const n = pos.getCount(), positions = new Float32Array(n * 3), e = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, e);
        positions[i * 3]     = m[0] * e[0] + m[4] * e[1] + m[8]  * e[2] + m[12];
        positions[i * 3 + 1] = m[1] * e[0] + m[5] * e[1] + m[9]  * e[2] + m[13];
        positions[i * 3 + 2] = m[2] * e[0] + m[6] * e[1] + m[10] * e[2] + m[14];
      }
      const uvA = prim.getAttribute("TEXCOORD_0");
      let uvs = null;
      if (uvA) { uvs = new Float32Array(n * 2); const t = [0, 0]; for (let i = 0; i < n; i++) { uvA.getElement(i, t); uvs[i * 2] = t[0]; uvs[i * 2 + 1] = t[1]; } }
      const colA = prim.getAttribute("COLOR_0");
      let colors = null;
      if (colA) { colors = new Float32Array(n * 3); const c = [0, 0, 0, 1]; for (let i = 0; i < n; i++) { colA.getElement(i, c); for (let a = 0; a < 3; a++) colors[i * 3 + a] = toSrgb(c[a]); } }
      const idx = prim.getIndices();
      let indices;
      if (idx) { indices = new Uint32Array(idx.getCount()); for (let i = 0; i < indices.length; i++) indices[i] = idx.getScalar(i); }
      else indices = Uint32Array.from({ length: n }, (_, i) => i);
      const mat = prim.getMaterial();
      let texture = null, tint = [1, 1, 1];
      if (mat) {
        const f = mat.getBaseColorFactor();
        tint = [toSrgb(f[0]), toSrgb(f[1]), toSrgb(f[2])];
        const tex = mat.getBaseColorTexture();
        if (tex) {
          if (!textures.has(tex)) textures.set(tex, decodeImage(tex.getImage(), tex.getMimeType(), false));
          texture = textures.get(tex);
        }
      }
      meshes.push({ positions, indices, uvs, colors, texture, tint });
    }
  });
  if (!meshes.length) throw new Error("GLB にメッシュがありません");
  return meshes;
}

// OBJ（ZIP の中の .obj・.mtl・画像）。OBJ の UV は下が 0 なので flipY
function loadObj(files, names, objName) {
  const text = new TextDecoder().decode(files[objName]);
  const find = (n) => { const b = n.split(/[\\/]/).pop().toLowerCase(); return names.find(x => x.split("/").pop().toLowerCase() === b); };
  const materials = {};
  let current = null;
  const v = [], vt = [], vc = [];
  const out = new Map(); // マテリアル名 → { positions, uvs, colors, indices }
  const cornerCache = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === "v") { v.push([+t[1], +t[2], +t[3]]); vc.push(t.length >= 7 ? [+t[4], +t[5], +t[6]] : null); }
    else if (t[0] === "vt") vt.push([+t[1], +(t[2] || 0)]);
    else if (t[0] === "mtllib") {
      const mtl = find(t.slice(1).join(" "));
      if (mtl) {
        let m = null;
        for (const line of new TextDecoder().decode(files[mtl]).split(/\r?\n/)) {
          const u = line.trim().split(/\s+/);
          if (u[0] === "newmtl") m = materials[u.slice(1).join(" ")] = { kd: [1, 1, 1], map: null };
          else if (u[0] === "Kd" && m) m.kd = [+u[1], +u[2], +u[3]];
          else if (u[0] === "map_Kd" && m) m.map = find(u[u.length - 1]);
        }
      }
    } else if (t[0] === "usemtl") current = t.slice(1).join(" ");
    else if (t[0] === "f") {
      const key = current || "";
      if (!out.has(key)) out.set(key, { positions: [], uvs: [], colors: [], indices: [], hasColor: false });
      const g = out.get(key);
      const ids = t.slice(1).map(c => {
        const [a, b] = c.split("/");
        let vi = +a; vi = vi > 0 ? vi - 1 : v.length + vi;
        let ti = b ? +b : 0; ti = ti ? (ti > 0 ? ti - 1 : vt.length + ti) : -1;
        const ck = key + "|" + vi + "/" + ti;
        if (!cornerCache.has(ck)) {
          cornerCache.set(ck, g.positions.length / 3);
          g.positions.push(...v[vi]);
          g.uvs.push(...(ti >= 0 ? vt[ti] : [0, 0]));
          g.colors.push(...(vc[vi] || [1, 1, 1]));
          if (vc[vi]) g.hasColor = true;
        }
        return cornerCache.get(ck);
      });
      for (let k = 1; k + 1 < ids.length; k++) g.indices.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  const meshes = [];
  for (const [key, g] of out) {
    const mat = materials[key];
    let texture = null;
    if (mat && mat.map) {
      const ext = extname(mat.map).toLowerCase();
      texture = decodeImage(files[mat.map], ext === ".png" ? "image/png" : "image/jpeg", true);
    }
    meshes.push({
      positions: Float32Array.from(g.positions), indices: Uint32Array.from(g.indices), uvs: Float32Array.from(g.uvs),
      colors: g.hasColor ? Float32Array.from(g.colors) : null, texture, tint: mat ? mat.kd : [1, 1, 1],
    });
  }
  if (!meshes.length) throw new Error("OBJ に面がありません");
  return meshes;
}

// 画像（JPEG / PNG）→ 上の行からの RGBA
function decodeImage(bytes, mime, flipY) {
  if (!bytes) return null;
  try {
    if (mime === "image/png") {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: png.data, flipY };
    }
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, data: img.data, flipY };
  } catch (e) {
    console.warn("テクスチャを読めませんでした（色なしで続けます）: " + e.message);
    return null;
  }
}

function toSrgb(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
