import DOMPurify from 'dompurify';
import { EditorView } from '@codemirror/view';
import type { NoteDocument } from '../workspace/noteDocument';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function markdownImagePaste(getDocument: () => NoteDocument | null, message: (text: string) => void) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      if (view.state.readOnly || !data) return false;
      const files = Array.from(data.files).filter(file => file.type.startsWith('image/'));
      if (!files.length) return false;
      const plain = data.getData('text/plain').trim();
      const markdown = data.getData('text/markdown').trim();
      const template = document.createElement('template');
      template.innerHTML = DOMPurify.sanitize(data.getData('text/html'));
      const images = Array.from(template.content.querySelectorAll('img'));
      const nodes = Array.from(template.content.childNodes);
      const pureHtmlImage = images.length === 1 && nodes.every(node =>
        node.nodeType === Node.TEXT_NODE ? !node.textContent?.trim() : node instanceof HTMLImageElement);
      const pureImage = !plain && !markdown && (pureHtmlImage || (!nodes.length && !data.getData('text/html')));
      if (!pureImage) return false;
      event.preventDefault();
      if (files.length !== 1 || !IMAGE_TYPES.has(files[0].type)) { message('请一次粘贴一张 PNG、JPEG 或 WebP 图片。'); return true; }
      const file = files[0];
      if (file.size > MAX_IMAGE_BYTES) { message('图片超过 20 MiB，未插入。'); return true; }
      const target = getDocument();
      if (!target) { message('当前没有可写入的笔记。'); return true; }
      const selection = view.state.selection.main;
      const anchor = target.captureImagePaste({ from: selection.from, to: selection.to });
      const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1];
      try { target.enqueueImagePaste({ name: file.name || `pasted.${extension}`, extension, size: file.size,
        read: async () => new Uint8Array(await file.arrayBuffer()), anchor }); }
      catch (error) { target.releaseImageAnchor(anchor.id); message(error instanceof Error ? error.message : String(error)); }
      return true;
    },
  });
}
