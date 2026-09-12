// 의존성 없이 PNG 아이콘을 생성한다 (node:zlib 만 사용)
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolor + alpha
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 아이콘: 인디고 라운드 사각형 + 흰 캘린더 글리프 */
function drawIcon(size, { rounded }) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size / 180; // 180px 기준 좌표계
  const radius = rounded ? 40 * S : 0;

  const bgTop = [0x4f, 0x6d, 0xf5];
  const bgBottom = [0x6b, 0x4f, 0xf5];

  const px = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255;
    const da = buf[i + 3] / 255;
    const out = sa + da * (1 - sa);
    if (out === 0) return;
    buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / out);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / out);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / out);
    buf[i + 3] = Math.round(out * 255);
  };

  // 라운드 사각형 배경 (세로 그라데이션 + 코너 안티에일리어싱)
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const col = [0, 1, 2].map((i) => Math.round(bgTop[i] + (bgBottom[i] - bgTop[i]) * t));
    for (let x = 0; x < size; x++) {
      let a = 255;
      if (radius > 0) {
        const cx = Math.min(Math.max(x + 0.5, radius), size - radius);
        const cy = Math.min(Math.max(y + 0.5, radius), size - radius);
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > radius + 0.5) continue;
        if (d > radius - 0.5) a = Math.round((radius + 0.5 - d) * 255);
      }
      px(x, y, col, a);
    }
  }

  const white = [0xff, 0xff, 0xff];
  const rect = (x, y, w, h, r = 0, col = white, a = 255) => {
    for (let yy = Math.floor(y); yy < Math.ceil(y + h); yy++) {
      for (let xx = Math.floor(x); xx < Math.ceil(x + w); xx++) {
        if (r > 0) {
          const cx = Math.min(Math.max(xx + 0.5, x + r), x + w - r);
          const cy = Math.min(Math.max(yy + 0.5, y + r), y + h - r);
          if (Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) > r) continue;
        }
        px(xx, yy, col, a);
      }
    }
  };

  // 캘린더 본체
  rect(34 * S, 46 * S, 112 * S, 100 * S, 16 * S);
  // 상단 띠 (반투명하게 파내는 대신 배경색으로 덮음)
  rect(34 * S, 46 * S, 112 * S, 26 * S, 16 * S, [0x33, 0x46, 0xc2]);
  rect(34 * S, 62 * S, 112 * S, 10 * S, 0, [0x33, 0x46, 0xc2]);
  // 고리 두 개
  rect(56 * S, 30 * S, 10 * S, 26 * S, 5 * S);
  rect(114 * S, 30 * S, 10 * S, 26 * S, 5 * S);
  // 날짜 점 (가족 구성원 느낌으로 색 다르게)
  const dots = [
    [52, 88, [0x4f, 0x6d, 0xf5]],
    [80, 88, [0xff, 0x6b, 0x6b]],
    [108, 88, [0x2b, 0xb6, 0x73]],
    [52, 114, [0xf5, 0x9f, 0x00]],
    [80, 114, [0xa8, 0x55, 0xf7]],
  ];
  for (const [dx, dy, col] of dots) rect(dx * S, dy * S, 20 * S, 16 * S, 5 * S, col);
  // 체크 표시 자리: 마지막 칸은 옅은 회색
  rect(108 * S, 114 * S, 20 * S, 16 * S, 5 * S, [0xd6, 0xdb, 0xe8]);

  return buf;
}

mkdirSync(new URL("../public/icons/", import.meta.url), { recursive: true });
const targets = [
  ["icon-192.png", 192, true],
  ["icon-512.png", 512, true],
  ["apple-touch-icon.png", 180, false], // iOS가 알아서 라운딩하므로 꽉 채운다
  ["favicon-64.png", 64, true],
];
for (const [name, size, rounded] of targets) {
  const out = new URL(`../public/icons/${name}`, import.meta.url);
  writeFileSync(out, png(size, size, drawIcon(size, { rounded })));
  console.log(`  ${name}  ${size}x${size}`);
}
