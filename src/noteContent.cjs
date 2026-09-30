function canonicalNoteContent(value) {
  return value.replace(/\r\n?/g, '\n');
}

function sameNoteContent(left, right) {
  return canonicalNoteContent(left) === canonicalNoteContent(right);
}

module.exports = { canonicalNoteContent, sameNoteContent };
