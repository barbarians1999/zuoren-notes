import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EpubAnchor, EpubAnnotation, EpubMeta, MarkdownScrollMemory, NoteRead, PdfAnchor, PdfAnnotation, PdfMeta, PdfRect, ReaderAnchor, RecoveryCheckResult, RecoveryV1, SaveNoteResult, WorkspaceFile } from '../types';
import { reader, resolveLocal, NOTE_BODY_FONTS, EPUB_MIN_SPREAD_WIDTH, type ActivePdf, type ActiveEpub, type FlatNavItem, type OcrDialog, type NoteMode, type NoteBodyFont, type SaveLabel, type FindCommand } from '../readerContext';
import { renderMarkdown } from './markdownRendering';
import { decodeReaderAnchor } from '../readerAnchor.cjs';
export const MarkdownPreview = React.memo(function MarkdownPreview({ notePath, text, onJump }: { notePath: string; text: string; onJump: (anchor: ReaderAnchor) => void }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let disposed = false;
    let timeout: number | undefined;
    setHtml('');
    const fallback = () => {
      const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
      return `<p>${escaped || '<br>'}</p>`;
    };
    const render = async () => {
      // Resolve actual rendered images, never image-looking text inside code.
      const container = document.createElement('template');
      container.innerHTML = renderMarkdown(text || '<p><br></p>');
      await Promise.all(Array.from(container.content.querySelectorAll('img[src]')).map(async image => {
        const source = image.getAttribute('src') || '';
        if (/^(https?:|data:|blob:|reader-asset:)/i.test(source)) return;
        try { image.setAttribute('src', await reader().assetUrl(resolveLocal(notePath, decodeURIComponent(source)))); }
        catch { /* Keep the broken image visible without stalling other images. */ }
      }));
      return container.innerHTML;
    };
    void (async () => {
      try {
        const result = await Promise.race([
          render(),
          new Promise<string>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('preview timeout')), 5000); }),
        ]);
        if (!disposed) setHtml(result);
      } catch {
        // A broken attachment or a stalled renderer must not leave the pane
        // stuck on “正在排版…”.  Plain text is a safe and useful fallback.
        if (!disposed) setHtml(fallback());
      } finally { if (timeout !== undefined) window.clearTimeout(timeout); }
    })();
    return () => { disposed = true; if (timeout !== undefined) window.clearTimeout(timeout); };
  }, [notePath, text]);
  if (!html && text.trim()) return <div className="markdown-preview preview-loading">正在排版…</div>;
  return <div className="markdown-preview" tabIndex={0} aria-label="Markdown 预览" onClick={event => { const link = (event.target as Element).closest?.('a'); const anchor = link && decodeReaderAnchor(link.getAttribute('href') || ''); if (anchor) { event.preventDefault(); onJump(anchor); } }} dangerouslySetInnerHTML={{ __html: html }}/>;
});
