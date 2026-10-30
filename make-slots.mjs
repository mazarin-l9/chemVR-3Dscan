// 空きスロット用の点群PNG（slot1.png .. slot64.png）を作る。ワールドで読み込むと、点で書いた番号が表示される
// 使い方: node Tools/scan-site/make-slots.mjs [出力フォルダ（既定: Tools/scan-site/scans）] [数（既定: 64）]
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePointCloud, decodePointCloud, pngBytes, rng } from "./scan2png-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(here, "scans");
const count = parseInt(process.argv[3] || "64");
mkdirSync(outDir, { recursive: true });

// 5×7 の数字
const FONT = {
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

function slotCloud(n) {
  const r = rng(n), pos = [], col = [];
  const digits = String(n).split("").map(Number);
  const cell = 0.1, gap = 0.6 * cell, totalW = digits.length * 5 * cell + (digits.length - 1) * gap;
  digits.forEach((d, di) => {
    FONT[d].forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit !== "1") return;
      for (let k = 0; k < 60; k++) {
        const px = -totalW / 2 + di * (5 * cell + gap) + (x + r()) * cell;
        const py = 0.15 + (6 - y + r()) * cell;
        const pz = (r() - 0.5) * cell;
        pos.push(-px, py, pz); // Unity では X が左右反転しないよう、手前から見て読める向きにする
        col.push(255, 190 + Math.floor(r() * 40), 60);
      }
    }));
  });
  // 台座の円盤（未登録の目印。灰色）
  for (let k = 0; k < 1500; k++) {
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * 0.45;
    pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    const g = 110 + Math.floor(r() * 30);
    col.push(g, g, g + 10);
  }
  return { positions: Float32Array.from(pos), colors: Uint8Array.from(col) };
}

for (let n = 1; n <= count; n++) {
  const cloud = slotCloud(n);
  const img = encodePointCloud(cloud.positions, cloud.colors, { title: `スロット${n}（未登録）`, date: new Date(2026, 0, 1, 0, 0, 0) });
  const back = decodePointCloud(img.width, img.height, img.rgba);
  if (!back.ok || back.count !== cloud.positions.length / 3 || back.title !== `スロット${n}（未登録）`) throw new Error(`slot${n}: 読み戻しに失敗 ${back.reason || ""}`);
  const png = await pngBytes(img.width, img.height, img.rgba);
  writeFileSync(join(outDir, `slot${n}.png`), png);
}
console.log(`${count} 個のスロット画像を作りました: ${outDir}`);
