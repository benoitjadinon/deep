// 의존성 없이 단색 PNG를 만들어 Stream Deck manifest가 요구하는 아이콘을 채운다.
// (키 위 실제 그림은 런타임에 SVG로 그리므로 이 PNG들은 플레이스홀더)
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const png = (w, h, [r, g, b, a]) => {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) { row[1 + x * 4] = r; row[1 + x * 4 + 1] = g; row[1 + x * 4 + 2] = b; row[1 + x * 4 + 3] = a; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

const base = "com.byjw.deep.sdPlugin/imgs/";
const color = [28, 28, 30, 255];
const items = [["plugin/marketplace", 256], ["plugin/category", 28], ["actions/slot/icon", 20], ["actions/slot/key", 72]];
for (const [p, s] of items) {
  for (const [suffix, mult] of [["", 1], ["@2x", 2]]) {
    const f = `${base}${p}${suffix}.png`;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, png(s * mult, s * mult, color));
  }
}
console.log("icons written under", base);
