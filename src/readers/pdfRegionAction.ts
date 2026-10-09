import type { PdfAnchor, PdfAnnotation } from '../types';
import { createExcerptFlow, type ExcerptFlowResult } from './excerptFlow';

export type PdfExcerptContext = {
  sourcePath: string;
  sourceCurrent: () => boolean;
  target: {
    path: string;
    valid: () => boolean;
    insert: (asset: string | null, anchor: PdfAnchor, quote?: string) => Promise<boolean>;
  } | null;
};
type Options = {
  context: PdfExcerptContext;
  annotation: PdfAnnotation;
  crop: () => Promise<Uint8Array>;
  attachment: (sourcePath: string, bytes: Uint8Array) => Promise<string>;
  save: (annotation: PdfAnnotation) => Promise<boolean>;
  saveText: (annotation: PdfAnnotation, text: string) => Promise<boolean>;
};
export type PdfRegionAction = {
  run: () => Promise<ExcerptFlowResult>;
  bytes: () => Promise<Uint8Array>;
  annotation: PdfAnnotation;
  createTextAction: (text: string) => () => Promise<ExcerptFlowResult>;
};

// The context is captured before cropping or attachment I/O. Both image and
// OCR insertion keep that destination, including after a partial-success retry.
export function createPdfRegionAction(options: Options): PdfRegionAction {
  const { context } = options;
  const annotation = { ...options.annotation };
  let imagePath: string | null = null;
  let cropped: Promise<Uint8Array> | null = null;
  const bytes = () => {
    if (!cropped) cropped = options.crop().catch(error => { cropped = null; throw error; });
    return cropped;
  };
  const current = () => context.sourceCurrent() && (!context.target || context.target.valid());
  const run = createExcerptFlow({
    sourceCurrent: context.sourceCurrent,
    targetCurrent: context.target?.valid,
    save: async () => {
      const data = await bytes();
      if (!current()) return false;
      if (!imagePath) imagePath = await options.attachment(context.target?.path || context.sourcePath, data);
      if (!current()) return false;
      annotation.attachment = imagePath;
      return options.save(annotation);
    },
    insert: context.target ? () => context.target!.insert(imagePath, annotation.anchor) : undefined,
    message: (failure, error, saved) => {
      if (failure === 'source-changed') return 'PDF 已切换，未继续处理原框选。';
      if (failure === 'target-changed') return saved ? '框选标记已保存，请返回原笔记后重试摘录。' : '目标笔记已切换，请返回原笔记后重试。';
      if (saved) return '框选标记已保存，摘录未插入；可以仅重试摘录。';
      return `框选保存未完成，请重试${error instanceof Error ? `：${error.message}` : '。'}`;
    },
  });
  return { run, bytes, annotation,
    createTextAction: text => createExcerptFlow({
      sourceCurrent: context.sourceCurrent,
      targetCurrent: context.target?.valid,
      save: () => options.saveText(annotation, text),
      insert: context.target && text.trim() ? () => context.target!.insert(null, annotation.anchor, text.trim()) : undefined,
      message: (failure, error, saved) => {
        if (failure === 'source-changed') return 'PDF 已切换，未继续处理原识别结果。';
        if (failure === 'target-changed') return '目标笔记已切换，请返回原笔记后重试插入识别文字。';
        if (saved) return '识别结果已保存，文字未插入；可以仅重试摘录。';
        return `识别结果保存未完成，请重试${error instanceof Error ? `：${error.message}` : '。'}`;
      },
    }),
  };
}
