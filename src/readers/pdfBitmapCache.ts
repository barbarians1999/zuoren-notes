export type PdfBitmapEntry<TCanvas extends { width: number; height: number } = HTMLCanvasElement> = {
  canvas: TCanvas;
  cssWidth: number;
  cssHeight: number;
  rotation: 0 | 90 | 180 | 270;
  bytes: number;
  hasDarkImages: boolean;
};

export function pdfBitmapCacheKey(
  pdfPath: string,
  page: number,
  scale: number,
  outputScale: number,
  dark: boolean,
): string {
  return `${pdfPath}::${page}::${scale.toFixed(3)}::${outputScale.toFixed(2)}::${dark ? 'dark' : 'light'}`;
}

export class PdfBitmapCache<TCanvas extends { width: number; height: number } = HTMLCanvasElement> {
  private entries = new Map<string, PdfBitmapEntry<TCanvas>>();
  private totalBytes = 0;
  readonly maxBytes: number;
  private disposeCanvas: (canvas: TCanvas) => void;

  constructor(
    maxBytes = 64 * 1024 * 1024,
    disposeCanvas: (canvas: TCanvas) => void = canvas => {
      canvas.width = 0;
      canvas.height = 0;
    },
  ) {
    this.maxBytes = maxBytes;
    this.disposeCanvas = disposeCanvas;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(key: string): PdfBitmapEntry<TCanvas> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: PdfBitmapEntry<TCanvas>): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.totalBytes -= existing.bytes;
      if (existing.canvas !== entry.canvas) this.disposeCanvas(existing.canvas);
    }
    this.entries.set(key, entry);
    this.totalBytes += entry.bytes;
    while (this.totalBytes > this.maxBytes && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      this.totalBytes -= oldest.bytes;
      this.disposeCanvas(oldest.canvas);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) this.disposeCanvas(entry.canvas);
    this.entries.clear();
    this.totalBytes = 0;
  }
}
