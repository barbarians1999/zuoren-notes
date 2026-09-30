export function countTextUnits(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length || 0;
  const nonHan = text.replace(/\p{Script=Han}/gu, ' ');
  const words = nonHan.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length || 0;
  return han + words;
}

export function markdownTextForCount(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/^\s{0,3}(?:```|~~~).*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ');
}

export function countMarkdownUnits(markdown: string): number {
  return countTextUnits(markdownTextForCount(markdown));
}
