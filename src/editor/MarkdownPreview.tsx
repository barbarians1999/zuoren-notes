import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReaderAnchor } from '../types';
import { reader, resolveLocal } from '../readerContext';
import { renderMarkdown } from './markdownRendering';
import { decodeReaderAnchor } from '../readerAnchor.cjs';
import { findMarkdownTasks, markdownPreviewSource } from './markdownTasks';
export const MarkdownPreview = React.memo(function MarkdownPreview({ notePath, text, headings, onJump, onToggleTask, onOpenLink }: { notePath: string; text: string; headings: readonly { line: number; previewAt: number }[]; onJump: (anchor: ReaderAnchor) => void; onToggleTask?: (position: number, checked: boolean, expectedSource: string) => boolean; onOpenLink?: (href: string) => void }) {
  const [rendered, setRendered] = useState<{ notePath: string; source: string; html: string; taskNonce: string | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef<{ notePath: string; top: number } | null>(null);
  const html = rendered?.notePath === notePath ? rendered.html : null;
  useLayoutEffect(() => {
    const saved = restoreScroll.current;
    restoreScroll.current = null;
    if (saved?.notePath === notePath && rendered?.notePath === notePath && root.current) root.current.scrollTop = saved.top;
  }, [rendered, notePath]);
  useEffect(() => {
    let disposed = false;
    let timeout: number | undefined;
    const commit = (nextHtml: string, taskNonce: string | null = null) => {
      if (disposed) return;
      const element = root.current;
      restoreScroll.current = element?.dataset.notePath === notePath && !element.classList.contains('preview-loading')
        ? { notePath, top: element.scrollTop } : null;
      setRendered({ notePath, source: text, html: nextHtml, taskNonce });
    };
    const fallback = () => {
      const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
      return `<p>${escaped || '<br>'}</p>`;
    };
    const render = async () => {
      // Resolve actual rendered images, never image-looking text inside code.
      const container = document.createElement('template');
      const tasks = findMarkdownTasks(text), taskNonce = crypto.randomUUID();
      container.innerHTML = renderMarkdown(markdownPreviewSource(text, tasks, taskNonce, headings) || '<p><br></p>');
      for (const heading of headings) {
        const identity = `${taskNonce}:${heading.line}`;
        const marker = container.content.querySelector(`[data-zuoren-heading="${identity}"]`);
        const element = marker?.closest('h1,h2,h3,h4,h5,h6');
        if (element) element.setAttribute('data-zuoren-heading', identity);
        marker?.remove();
      }
      for (const input of container.content.querySelectorAll<HTMLInputElement>('input')) input.disabled = true;
      for (const task of tasks) {
        const marker = container.content.querySelector(`[data-zuoren-task="${taskNonce}:${task.position}"]`);
        const input = marker?.previousElementSibling;
        // Only the generated checkbox beside our fresh nonce is writable.
        if (input instanceof HTMLInputElement && input.type === 'checkbox' && marker?.closest('li')) {
          input.disabled = !onToggleTask;
          input.dataset.taskNonce = taskNonce;
          input.dataset.taskPosition = String(task.position);
          input.dataset.taskChecked = String(task.checked);
          input.setAttribute('aria-label', `${task.checked ? '取消完成' : '完成任务'}：${marker.closest('li')?.textContent?.trim().slice(0, 100) || '待办事项'}`);
        }
        marker?.remove();
      }
      await Promise.all(Array.from(container.content.querySelectorAll('img[src]')).map(async image => {
        const source = image.getAttribute('src') || '';
        if (/^(https?:|data:|blob:|reader-asset:)/i.test(source)) return;
        try { image.setAttribute('src', await reader().assetUrl(resolveLocal(notePath, decodeURIComponent(source)))); }
        catch { /* Keep the broken image visible without stalling other images. */ }
      }));
      return { html: container.innerHTML, taskNonce };
    };
    void (async () => {
      try {
        const result = await Promise.race([
          render(),
          new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('preview timeout')), 5000); }),
        ]);
        commit(result.html, result.taskNonce);
      } catch {
        // A broken attachment or a stalled renderer must not leave the pane
        // stuck on “正在排版…”.  Plain text is a safe and useful fallback.
        commit(fallback());
      } finally { if (timeout !== undefined) window.clearTimeout(timeout); }
    })();
    return () => { disposed = true; if (timeout !== undefined) window.clearTimeout(timeout); };
  }, [notePath, text, headings, !!onToggleTask]);
  return <div ref={root} data-note-path={notePath} data-heading-nonce={rendered?.taskNonce || undefined} data-preview-current={rendered?.notePath === notePath && rendered.source === text} className={'markdown-preview' + (html === null ? ' preview-loading' : '')} tabIndex={0} aria-label="Markdown 预览" aria-busy={html === null} onClick={event => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.type === 'checkbox') {
      event.preventDefault();
      if (!rendered || rendered.notePath !== notePath || rendered.source !== text || input.dataset.taskNonce !== rendered.taskNonce) return;
      if (onToggleTask?.(Number(input.dataset.taskPosition), input.dataset.taskChecked !== 'true', rendered.source)) root.current?.focus({ preventScroll: true });
      return;
    }
    const link = (event.target as Element).closest?.('a'), href = link?.getAttribute('href') || '';
    const anchor = link && decodeReaderAnchor(href);
    if (anchor) { event.preventDefault(); onJump(anchor); return; }
    if (link && !href.startsWith('#') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); onOpenLink?.(href);
    }
  }} dangerouslySetInnerHTML={{ __html: html ?? (text.trim() ? '正在排版…' : '') }}/>;
});
