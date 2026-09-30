'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

async function readSettingsFile(file, io = fs) {
  let source;
  try { source = await io.readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { parsed: null, backup: null };
    throw error;
  }
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('设置根节点不是对象');
    return { parsed, backup: null };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backup = `${file}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
    // Keep the unreadable bytes intact. If moving them fails, refuse all
    // settings writes rather than replacing the only surviving copy.
    await io.rename(file, backup);
    return { parsed: null, backup };
  }
}

module.exports = { readSettingsFile };
