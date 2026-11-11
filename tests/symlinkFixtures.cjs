'use strict';

const fs = require('node:fs/promises');

async function createSymlinkFixture(context, target, link, type) {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      context.skip('Windows denied symbolic-link fixture creation with EPERM; the symlink-specific assertions were not run.');
      return false;
    }
    throw error;
  }
}

module.exports = { createSymlinkFixture };
