import { markdownLanguage } from '@codemirror/lang-markdown';

export type MarkdownTask = { position: number; checked: boolean; insertAt: number };

// Only parser-confirmed GFM markers are writable, never task-like code or HTML.
export function findMarkdownTasks(source: string): MarkdownTask[] {
  if (!/\[[ xX]\][ \t]/.test(source)) return [];
  const tasks: MarkdownTask[] = [];
  markdownLanguage.parser.parse(source).iterate({ enter(node) {
    if (node.name !== 'TaskMarker') return;
    const marker = source.slice(node.from, node.to);
    if (!/^\[[ xX]\]$/.test(marker) || !/[ \t]/.test(source[node.to] || '')) return;
    tasks.push({ position: node.from + 1, checked: /x/i.test(marker), insertAt: node.to + 1 });
  } });
  return tasks;
}

export function taskPreviewSource(source: string, tasks: readonly MarkdownTask[], nonce: string): string {
  const parts: string[] = [];
  let from = 0;
  for (const task of tasks) {
    parts.push(source.slice(from, task.insertAt), `<span data-zuoren-task="${nonce}:${task.position}"></span>`);
    from = task.insertAt;
  }
  return parts.join('') + source.slice(from);
}

export function taskToggleChange(source: string, expectedSource: string, position: number, checked: boolean) {
  if (source !== expectedSource || !Number.isInteger(position)) return null;
  const task = findMarkdownTasks(source).find(item => item.position === position);
  if (!task || task.checked === checked) return null;
  return { from: position, to: position + 1, insert: checked ? 'x' : ' ' };
}
