import { useEffect, useRef, useState } from 'react';
import ePub from 'epubjs';
import type Section from 'epubjs/types/section';
import type { FlatNavItem } from '../readerContext';
import { stepMatchIndex } from '../findReplace';
import { collectEpubMatches, findEpubSectionMatches, EPUB_SEARCH_LIMIT, type EpubSearchResult, type EpubSearchStatus } from './epubSearch';

export function EpubSearchPanel({ data, toc, onNavigate, onClose, onClear }: {
  data: Uint8Array; toc: FlatNavItem[]; onNavigate: (result: EpubSearchResult) => Promise<boolean>; onClose: () => void; onClear: () => void;
}) {
  const [query, setQuery] = useState(''), [caseSensitive, setCaseSensitive] = useState(false);
  const [snapshot, setSnapshot] = useState<{ query: string; caseSensitive: boolean; status: EpubSearchStatus; busy: boolean; error: string } | null>(null);
  const [activeCfi, setActiveCfi] = useState(''), [jumping, setJumping] = useState(false);
  const jumpingRef = useRef(false);
  const generation = useRef(0);
  const clearRef = useRef(onClear); clearRef.current = onClear;
  const needle = query.trim();
  const current = snapshot?.query === needle && snapshot.caseSensitive === caseSensitive ? snapshot : null;
  useEffect(() => {
    const token = ++generation.current, controller = new AbortController();
    clearRef.current(); setActiveCfi('');
    if (!needle) { setSnapshot(null); return () => { controller.abort(); generation.current++; }; }
    const timer = window.setTimeout(() => {
      const update = (status: EpubSearchStatus, busy = true, error = '') => {
        if (!controller.signal.aborted && token === generation.current) setSnapshot({ query: needle, caseSensitive, status, busy, error });
      };
      const initial: EpubSearchStatus = { processed: 0, total: 0, errors: 0, truncated: false, results: [] };
      update(initial);
      void (async () => {
        // A separate, non-rendering Book avoids invalidating the visible
        // section or its annotations when searched chapters are unloaded.
        const book = ePub(data.slice().buffer as ArrayBuffer, { replacements: 'none' });
        try {
          await book.loaded.spine;
          if (controller.signal.aborted) return;
          const sections: Section[] = [];
          book.spine.each((section: Section) => sections.push(section));
          const status = await collectEpubMatches(sections, async (section, limit) => {
            try {
              await section.load(book.load.bind(book));
              if (controller.signal.aborted) throw new DOMException('Search cancelled', 'AbortError');
              return findEpubSectionMatches(section, needle, caseSensitive, limit);
            } finally { section.unload(); }
          }, { signal: controller.signal, onProgress: status => update(status) });
          update(status, false);
        } catch (error) {
          if (!controller.signal.aborted) update(initial, false, `搜索失败：${error instanceof Error ? error.message : String(error)}`);
        } finally { try { book.destroy(); } catch { /* already released */ } }
      })();
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); generation.current++; };
  }, [data, needle, caseSensitive]);

  async function jump(result: EpubSearchResult) {
    if (jumpingRef.current) return;
    const token = generation.current;
    jumpingRef.current = true; setJumping(true);
    try {
      const located = await onNavigate(result);
      if (located && token === generation.current) setActiveCfi(result.cfi);
    } finally {
      jumpingRef.current = false;
      setJumping(false);
    }
  }
  const status = current?.status;
  return <aside className="epub-search-panel" aria-label="EPUB 全书搜索" onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'text' && status?.results.length) {
      event.preventDefault();
      const index = status.results.findIndex(result => result.cfi === activeCfi);
      void jump(status.results[stepMatchIndex(status.results.length, index, event.shiftKey ? -1 : 1)]);
    }
  }}>
    <div className="epub-search-head"><strong>全书搜索</strong><button aria-label="关闭 EPUB 搜索" title="关闭（Esc）" onClick={onClose}>×</button></div>
    <div className="epub-search-query"><input autoFocus type="text" aria-label="EPUB 搜索文本" maxLength={200} placeholder="查找整本书" value={query} onChange={event => setQuery(event.target.value)}/><button className={caseSensitive ? 'selected' : ''} aria-label="EPUB 搜索区分大小写" aria-pressed={caseSensitive} title="区分大小写" onClick={() => setCaseSensitive(value => !value)}>Aa</button></div>
    <p className="epub-search-status" role="status">{!needle ? '输入关键词，可按 Enter 跳到下一项' : current?.error || (!current || current.busy ? `正在搜索${status?.total ? ` ${status.processed}/${status.total} 章` : '…'}` : status?.results.length ? `${status.results.length} 项结果` : '没有找到匹配内容')}</p>
    {!!status?.errors && <p className="epub-search-warning">{status.errors} 个章节无法读取，其他章节仍可搜索。</p>}
    {status?.truncated && <p className="epub-search-warning">最多显示 {EPUB_SEARCH_LIMIT} 项，请缩小关键词范围。</p>}
    <div className="epub-search-results">{status?.results.map(result => <button key={result.cfi} className={activeCfi === result.cfi ? 'current' : ''} disabled={jumping} onClick={() => void jump(result)}><small>{toc.find(item => item.href.split('#')[0] === result.href)?.label || `第 ${result.sectionIndex + 1} 章`}</small><span>{result.excerpt}</span></button>)}</div>
  </aside>;
}
