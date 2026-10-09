export type ExcerptFlowFailure = 'source-changed' | 'target-changed' | 'save-failed' | 'insert-failed' | 'save-error' | 'insert-error';
export type ExcerptFlowResult = {
  done: boolean;
  saved: boolean;
  inserted: boolean;
  failure?: ExcerptFlowFailure;
  error?: string;
  retry?: () => Promise<ExcerptFlowResult>;
};
export type ExcerptFlowOptions = {
  sourceCurrent: () => boolean;
  targetCurrent?: () => boolean;
  save?: () => Promise<boolean>;
  insert?: () => Promise<boolean>;
  message?: (failure: ExcerptFlowFailure, error?: unknown, saved?: boolean) => string;
};

// Captured callbacks bind a flow to the source and destination that initiated it.
// Successful phases survive a retry; a phase is never repeated after confirmation.
export function createExcerptFlow(options: ExcerptFlowOptions): () => Promise<ExcerptFlowResult> {
  let saved = false, inserted = false, flight: Promise<ExcerptFlowResult> | null = null;
  const fail = (failure: ExcerptFlowFailure, cause?: unknown): ExcerptFlowResult => ({
    done: false, saved, inserted, failure,
    error: options.message?.(failure, cause, saved) ?? defaultMessage(failure, cause),
    retry: run,
  });
  async function execute(): Promise<ExcerptFlowResult> {
    if (!options.sourceCurrent()) return fail('source-changed');
    if (options.insert && !options.targetCurrent?.()) return fail('target-changed');
    if (options.save && !saved) {
      try {
        if (!(await options.save())) {
          if (!options.sourceCurrent()) return fail('source-changed');
          if (options.targetCurrent && !options.targetCurrent()) return fail('target-changed');
          return fail('save-failed');
        }
        saved = true;
      }
      catch (error) { return fail('save-error', error); }
    }
    if (options.insert && !inserted) {
      if (!options.sourceCurrent()) return fail('source-changed');
      if (!options.targetCurrent?.()) return fail('target-changed');
      try { if (!(await options.insert())) return fail('insert-failed'); inserted = true; }
      catch (error) { return fail('insert-error', error); }
    }
    return { done: true, saved, inserted };
  }
  function run(): Promise<ExcerptFlowResult> {
    if (!flight) {
      flight = execute();
      void flight.finally(() => { flight = null; });
    }
    return flight;
  }
  return run;
}

function defaultMessage(failure: ExcerptFlowFailure, error?: unknown) {
  if (failure === 'source-changed') return '来源资料已切换，未继续处理过期摘录。';
  if (failure === 'target-changed') return '目标笔记已切换或暂不可写入，未插入摘录。';
  if (failure === 'save-failed') return '标注保存失败，请重试。';
  if (failure === 'insert-failed') return '摘录未插入，请重试。';
  const detail = error instanceof Error ? error.message : String(error);
  return `${failure === 'save-error' ? '保存标注' : '插入摘录'}失败：${detail}`;
}
