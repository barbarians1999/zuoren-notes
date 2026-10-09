import type { PdfAnnotation } from '../types';
import type { PdfTextSelection, PdfSelectedPage } from './pdfSelection';
import { createExcerptFlow, type ExcerptFlowResult } from './excerptFlow.ts';

export type PdfTextAction = 'highlight' | 'excerpt' | 'highlight-and-excerpt';
export type PdfTextActionResult = ExcerptFlowResult;
export type PdfTextActionHandler = (selection: PdfTextSelection, action: PdfTextAction) => Promise<PdfTextActionResult>;
type Context = {
  sourceCurrent: () => boolean; targetCurrent: () => boolean;
  save: (annotations: PdfAnnotation[]) => Promise<boolean>;
  insert: (pages: PdfSelectedPage[]) => Promise<boolean>;
};

// Geometry and annotation creation stay PDF-specific; phase ownership and
// partial-success retry semantics are shared with EPUB in ExcerptFlow.
export function createPdfTextAction(selection: PdfTextSelection, action: PdfTextAction, context: Context): () => Promise<PdfTextActionResult> {
  const needsSave = action !== 'excerpt', needsInsert = action !== 'highlight';
  const annotations: PdfAnnotation[] = needsSave ? selection.pages.map(part => ({ id: crypto.randomUUID(), type: 'highlight',
    anchor: { pdfId: selection.pdfId, page: part.page, rotation: part.rotation, rects: part.rects, quote: part.quote }, color: '#e4c95b', createdAt: new Date().toISOString() })) : [];
  return createExcerptFlow({
    sourceCurrent: context.sourceCurrent,
    targetCurrent: needsInsert ? context.targetCurrent : undefined,
    save: needsSave ? () => context.save(annotations) : undefined,
    insert: needsInsert ? () => context.insert(selection.pages) : undefined,
    message: (failure, error, saved) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (failure === 'source-changed') return saved ? '高亮已保存，但 PDF 已切换，摘录尚未插入。' : 'PDF 已切换，未处理过期选区。';
      if (failure === 'target-changed') return saved ? '高亮已保存，目标笔记已切换；请返回原笔记后重试摘录。' : '目标笔记已切换或暂不可写入，未插入过期摘录。';
      if (failure === 'save-failed') return '高亮保存失败，请重试。';
      if (failure === 'insert-failed') return saved ? '高亮已保存，摘录未插入；可以仅重试摘录。' : '摘录未插入，请重试。';
      return `${saved ? '高亮已保存，摘录未完成：' : 'PDF 文字操作失败：'}${detail}`;
    },
  });
}
