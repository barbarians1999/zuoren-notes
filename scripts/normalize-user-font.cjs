const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2];
const output = process.argv[3] || input;
if (!input) throw new Error('Usage: node normalize-user-font.cjs input.ttf [output.ttf]');

const bytes = fs.readFileSync(input);
const tableCount = bytes.readUInt16BE(4);
const tables = new Map();

for (let index = 0; index < tableCount; index += 1) {
  const record = 12 + index * 16;
  const tag = bytes.toString('ascii', record, record + 4);
  tables.set(tag, {
    record,
    offset: bytes.readUInt32BE(record + 8),
    length: bytes.readUInt32BE(record + 12),
  });
}

function checksum(offset, length) {
  let sum = 0;
  const end = offset + Math.ceil(length / 4) * 4;
  for (let at = offset; at < end; at += 4) {
    let word = 0;
    for (let byte = 0; byte < 4; byte += 1) word = (word << 8) | (bytes[at + byte] || 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

const vhea = tables.get('vhea');
const head = tables.get('head');
if (!vhea || !head) throw new Error('The font is missing vhea or head');

const originalVersion = bytes.readUInt32BE(vhea.offset);
if (originalVersion === 0x00010001) bytes.writeUInt32BE(0x00010000, vhea.offset);

bytes.writeUInt32BE(checksum(vhea.offset, vhea.length), vhea.record + 4);
bytes.writeUInt32BE(0, head.offset + 8);
bytes.writeUInt32BE(checksum(head.offset, head.length), head.record + 4);

let wholeFontSum = 0;
for (let at = 0; at < Math.ceil(bytes.length / 4) * 4; at += 4) {
  let word = 0;
  for (let byte = 0; byte < 4; byte += 1) word = (word << 8) | (bytes[at + byte] || 0);
  wholeFontSum = (wholeFontSum + (word >>> 0)) >>> 0;
}
bytes.writeUInt32BE((0xB1B0AFBA - wholeFontSum) >>> 0, head.offset + 8);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, bytes);
console.log(`vhea ${originalVersion.toString(16)} -> ${bytes.readUInt32BE(vhea.offset).toString(16)}`);
