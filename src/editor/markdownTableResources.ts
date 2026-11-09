import { resolveLocal } from '../readerContext';

type TableResources = {
  notePath: string;
  assetUrl(path: string): Promise<string>;
  openLink(href: string): Promise<unknown>;
  isCurrent(): boolean;
  requestMeasure(): void;
  onError?(error: unknown): void;
};

// TableWidget owns its events, so CodeMirror's prose-link handler cannot see
// them. Bind only the sanitized anchors and images, retaining normal cell clicks.
export function bindMarkdownTableResources(element: HTMLElement, resources: TableResources) {
  let alive = true, pressedLink: Element | null = null;
  const current = () => alive && element.isConnected && resources.isCurrent();
  const report = (error: unknown) => {
    if (!current()) return;
    try { resources.onError?.(error); } catch { /* keep the table editable */ }
  };
  const measure = () => { if (current()) resources.requestMeasure(); };
  const linkAt = (event: MouseEvent) => {
    if (event.button !== 0 || !current()) return null;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = link && element.contains(link) ? link.getAttribute('href') : '';
    return href && !href.startsWith('#') ? link : null;
  };
  for (const link of element.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    link.dataset.markdownLink = link.getAttribute('href') || '';
  }
  const press = (event: MouseEvent) => {
    pressedLink = null;
    const link = linkAt(event);
    if (!link || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault(); event.stopImmediatePropagation(); pressedLink = link;
    const href = link.getAttribute('href')!;
    void Promise.resolve().then(() => { if (current()) return resources.openLink(href); }).catch(report);
  };
  const click = (event: MouseEvent) => {
    const link = linkAt(event), opened = link && link === pressedLink;
    pressedLink = null;
    if (link && (opened || event.ctrlKey || event.metaKey)) {
      // Do not also activate the cell (or navigate the renderer) after opening.
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  element.addEventListener('mousedown', press);
  element.addEventListener('click', click);
  const imageCleanups: (() => void)[] = [];
  for (const image of element.querySelectorAll<HTMLImageElement>('img[src]')) {
    const source = image.getAttribute('src') || '', alt = image.alt;
    const remote = /^(?:https?:\/\/[^\s]+|data:image\/[^\s]+|blob:[^\s]+|reader-asset:\/\/local\/[^\s]+)$/i.test(source);
    // Prevent an app-relative fetch before the checked asset URL is available.
    if (!remote) image.removeAttribute('src');
    let failed = false;
    const fail = (error: unknown) => {
      if (!current() || failed) return;
      failed = true;
      image.alt = `${alt || '图片'}（无法加载，点击编辑源码）`;
      image.classList.add('cm-md-image-error'); report(error); measure();
    };
    const error = () => fail(new Error('Markdown table image could not be loaded'));
    image.addEventListener('load', measure); image.addEventListener('error', error);
    imageCleanups.push(() => { image.removeEventListener('load', measure); image.removeEventListener('error', error); });
    if (remote) continue;
    void Promise.resolve().then(() => {
      if (!current()) return;
      const reference = decodeURIComponent(source);
      if (!reference || /^(?![A-Za-z]:[\\/])[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) throw new Error('Unsupported Markdown table image URL');
      return resources.assetUrl(resolveLocal(resources.notePath, reference));
    }).then(url => { if (url !== undefined && current()) image.setAttribute('src', url); }).catch(fail);
  }
  return () => {
    alive = false; pressedLink = null;
    element.removeEventListener('mousedown', press); element.removeEventListener('click', click);
    for (const cleanup of imageCleanups) cleanup();
  };
}
