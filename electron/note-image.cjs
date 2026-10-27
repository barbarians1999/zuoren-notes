const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

function noteImageBytes(input) {
  if (!(input.data instanceof Uint8Array) || !input.data.byteLength || input.data.byteLength > MAX_IMAGE_BYTES)
    throw new Error('图片必须是有效位图，且不能超过 20 MiB');
  const bytes = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  const requested = String(input.extension || 'png').toLowerCase().replace(/^jpg$/, 'jpeg');
  if (!['png', 'jpeg', 'webp'].includes(requested) || imageType(bytes) !== requested)
    throw new Error('图片内容与格式不一致，仅支持 PNG、JPEG 和 WebP');
  return { bytes, extension: requested === 'jpeg' ? 'jpg' : requested };
}

async function openImage(store, shell, file) {
  if (typeof file !== 'string') throw new Error('图片地址无效');
  if (/^https?:\/\//i.test(file)) {
    const url = new URL(file);
    await shell.openExternal(url.href);
    return;
  }
  const checked = await store.checked(file, { asset: true });
  const extension = path.extname(checked).slice(1).toLowerCase().replace(/^jpg$/, 'jpeg');
  if (!['png', 'jpeg', 'webp', 'gif', 'bmp'].includes(extension)) throw new Error('只能打开受支持的位图图片');
  const handle = await fs.open(checked, 'r');
  let type;
  try {
    const head = Buffer.alloc(12), { bytesRead } = await handle.read(head, 0, head.length, 0);
    type = imageType(head.subarray(0, bytesRead));
  } finally { await handle.close(); }
  if (type !== extension) throw new Error('图片内容与扩展名不一致，已停止打开');
  const error = await shell.openPath(checked);
  if (error) throw new Error(error);
}

module.exports = { MAX_IMAGE_BYTES, noteImageBytes, openImage };
