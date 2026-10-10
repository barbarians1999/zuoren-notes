// Pure path identity rules shared by the renderer and the main process.
// Windows paths fold case; POSIX paths retain case and forward slashes.
const isWindowsPath = value => typeof value === 'string' && (/^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\'));
const isAbsoluteFilePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
  && (isWindowsPath(value) || value.startsWith('/'));

function normalizeFilePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return '';
  const posix = value.startsWith('/') && !isWindowsPath(value);
  const normalized = posix ? value : value.replaceAll('/', '\\');
  const separator = posix ? '/' : '\\';
  const unc = !posix && normalized.startsWith('\\\\');
  const drive = !posix && /^[a-z]:\\/i.test(normalized);
  const prefix = posix ? '/' : unc ? '\\\\' : drive ? normalized.slice(0, 3) : '';
  const rest = normalized.slice(prefix.length);
  const pieces = [];
  for (const piece of rest.split(posix ? /\/+/: /\\+/)) {
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      const floor = unc ? 2 : 0;
      if (pieces.length > floor && pieces.at(-1) !== '..') pieces.pop();
      else if (!prefix) pieces.push(piece);
    } else pieces.push(piece);
  }
  return prefix + pieces.join(separator);
}

function filePathKey(value) {
  const normalized = normalizeFilePath(value);
  return normalized.startsWith('/') ? normalized : normalized.toLocaleLowerCase('en-US');
}

module.exports = { isAbsoluteFilePath, normalizeFilePath, filePathKey };
