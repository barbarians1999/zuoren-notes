import { createPortal } from 'react-dom';
import { BookOpen, Maximize2 } from 'lucide-react';

export function EmptyReaderPane({
  fullscreen,
  onToggleFullscreen,
  onActivate,
  onOpenFiles,
  onOpenWorkspace,
  headerTarget = null,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onActivate: () => void;
  onOpenFiles?: () => void;
  onOpenWorkspace?: () => void;
  headerTarget?: HTMLElement | null;
}) {
  const headerToolbar = (
    <div className="pane-toolbar pdf-top-bar" data-empty="true" role="group" aria-label="PDF 阅读操作" title="PDF 阅读工具">
      <span className="toolbar-spacer" />
      <div className="pdf-top-actions">
        {!fullscreen && (
          <button className="icon-button" aria-pressed={false} title="进入全屏阅读" aria-label="进入全屏阅读" onClick={onToggleFullscreen}>
            <Maximize2 size={17} />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <section
      className="pane pdf-pane"
      tabIndex={-1}
      onFocusCapture={onActivate}
      onPointerDownCapture={event => {
        onActivate();
        if (!(event.target instanceof Element) || !event.target.closest('button, input, textarea')) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
    >
      {headerTarget ? createPortal(headerToolbar, headerTarget) : headerToolbar}
      <div className="pdf-reader-body">
        <div className="pdf-viewport-stage">
          <div className="pdf-canvas-wrap continuous-pdf">
            <div className="empty-state">
              <div className="empty-icon"><BookOpen size={26} /></div>
              <p>打开 PDF 或 EPUB 开始阅读</p>
              <small>支持批注高亮、划词摘录，并与右侧 Markdown 笔记双向回跳原文</small>
              {(onOpenFiles || onOpenWorkspace) && (
                <div className="empty-reader-actions">
                  {onOpenFiles && <button type="button" className="empty-reader-primary" onClick={onOpenFiles}>打开 PDF / EPUB</button>}
                  {onOpenWorkspace && <button type="button" className="empty-reader-secondary" onClick={onOpenWorkspace}>打开资料文件夹</button>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
