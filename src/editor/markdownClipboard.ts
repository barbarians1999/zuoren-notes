import DOMPurify from 'dompurify';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';

const escape = (text: string) => text.replace(/([\\`*_[\]~])/g, '\\$1');
export function htmlToMarkdown(html: string): string {
  const root = document.createElement('template');
  root.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'form'] });
  function children(node: Node): string { return Array.from(node.childNodes).map(walk).join(''); }
  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent || '');
    if (!(node instanceof HTMLElement)) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'pre') {
      const body = (node.textContent || '').replace(/\n$/, '');
      const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), match => match[0].length + 1)));
      return '\n\n' + fence + '\n' + body + '\n' + fence + '\n\n';
    }
    if (tag === 'code') {
      const body = node.textContent || '';
      const fence = '`'.repeat(Math.max(1, ...Array.from(body.matchAll(/`+/g), match => match[0].length + 1)));
      const padding = /^[` ]|[` ]$/.test(body) ? ' ' : '';
      return fence + padding + body + padding + fence;
    }
    if (tag === 'input') return node.getAttribute('type') === 'checkbox' ? (node.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr')).map(row => Array.from(row.children).filter(cell => /^(TH|TD)$/.test(cell.tagName)).map(cell => children(cell).trim().replace(/\n/g, '<br>').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const line = (row: string[]) => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |';
      return '\n\n' + [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
    }
    if (tag === 'ul' || tag === 'ol') {
      const requestedStart = node.getAttribute('start'), parsedStart = Number(requestedStart);
      const start = requestedStart !== null && Number.isInteger(parsedStart) && parsedStart >= 0 && parsedStart <= 999999999 ? parsedStart : 1;
      return '\n' + Array.from(node.children).filter(item => item.tagName === 'LI').map((item, index) => {
        const body = children(item).trim();
        const marker = tag === 'ol' ? (start + index) + '. ' : '- ';
        return marker + body.replace(/\n/g, '\n' + ' '.repeat(marker.length));
      }).join('\n') + '\n';
    }
    let text = children(node);
    if (!/^(strong|b)$/.test(tag) && (/^(bold|bolder)$/.test(node.style.fontWeight) || Number(node.style.fontWeight) >= 600)) text = '**' + text + '**';
    if (!/^(em|i)$/.test(tag) && /^(italic|oblique)/.test(node.style.fontStyle)) text = '*' + text + '*';
    if (tag === 'strong' || tag === 'b') return '**' + text + '**';
    if (tag === 'em' || tag === 'i') return '*' + text + '*';
    if (tag === 'del' || tag === 's' || tag === 'strike') return '~~' + text + '~~';
    if (tag === 'mark') return '==' + text + '==';
    if (tag === 'a') { const href = node.getAttribute('href'); return href ? '[' + text + '](' + href.replace(/\)/g, '%29') + ')' : text; }
    if (tag === 'img') { const src = node.getAttribute('src'); return src ? '![' + (node.getAttribute('alt') || '') + '](' + src + ')' : ''; }
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + text.trim() + '\n\n';
    if (tag === 'blockquote') return '\n\n' + text.trim().replace(/^/gm, '> ') + '\n\n';
    if (tag === 'p') return text + '\n\n';
    if (tag === 'div') return text + '\n';
    return text;
  }
  return children(root.content).replace(/\n{3,}/g, '\n\n').trim();
}

export const markdownClipboard = EditorView.domEventHandlers({
  copy(event, view) { return copy(event, view, false); },
  cut(event, view) { return copy(event, view, true); },
  paste(event, view) {
    if (view.state.readOnly || !event.clipboardData) return false;
    const data = event.clipboardData;
    const markdown = data.getData('text/markdown');
    const text = data.getData('text/plain');
    const html = data.getData('text/html');
    if (!markdown && !html) return false; // CodeMirror preserves plain text itself.
    const wrapper = document.createElement('template');
    wrapper.innerHTML = DOMPurify.sanitize(html);
    const rich = wrapper.content.querySelector('strong,b,em,i,del,s,mark,a,img,table,ul,ol,pre,code,blockquote,h1,h2,h3,h4,h5,h6,input') ||
      Array.from(wrapper.content.querySelectorAll<HTMLElement>('[style]')).some(el => /bold|bolder|[6-9]00/.test(el.style.fontWeight) || /italic|oblique/.test(el.style.fontStyle));
    const source = markdown || (html && !data.getData('vscode-editor-data') && (rich || !text) ? htmlToMarkdown(html) : text);
    if (!source) return false;
    event.preventDefault();
    view.dispatch(view.state.replaceSelection(source), { userEvent: 'input.paste', scrollIntoView: true, annotations: isolateHistory.of('full') });
    return true;
  },
});
function copy(event: ClipboardEvent, view: EditorView, cut: boolean) {
  if (!event.clipboardData) return false;
  const ranges = view.state.selection.ranges;
  if (ranges.every(range => range.empty)) return false;
  const source = ranges.map(range => view.state.sliceDoc(range.from, range.to)).join('\n');
  event.clipboardData.clearData();
  event.clipboardData.setData('text/plain', source);
  event.clipboardData.setData('text/markdown', source);
  event.preventDefault(); event.stopPropagation();
  if (cut && !view.state.readOnly) view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut', scrollIntoView: true, annotations: isolateHistory.of('full') });
  return true;
}
