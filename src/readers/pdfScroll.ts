export function findVisiblePdfPageIndex(count: number, bottomAt: (index: number) => number, probeY: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bottomAt(mid) > probeY) high = mid;
    else low = mid + 1;
  }
  return low < count ? low : -1;
}

export function findVisiblePdfPage(host: HTMLElement, probeY: number): HTMLElement | null {
  const children = host.children;
  const count = children.length;
  if (!count) return null;
  const first = children[0] as HTMLElement;
  if (!first?.dataset || !('pdfPage' in first.dataset)) {
    const slots = host.querySelectorAll<HTMLElement>('[data-pdf-page]');
    const index = findVisiblePdfPageIndex(slots.length, i => slots[i].getBoundingClientRect().bottom, probeY);
    return index >= 0 ? slots[index] : null;
  }
  const index = findVisiblePdfPageIndex(count, i => (children[i] as HTMLElement).getBoundingClientRect().bottom, probeY);
  return index >= 0 ? (children[index] as HTMLElement) : null;
}
