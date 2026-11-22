import type * as PdfjsLib from 'pdfjs-dist';

export interface PdfRangeTransportOptions {
  length: number;
  readRange: (begin: number, end: number) => Promise<Uint8Array>;
  onError: (error: unknown) => void;
}

export function createPdfRangeTransport(
  pdfjsLib: typeof PdfjsLib,
  { length, readRange, onError }: PdfRangeTransportOptions,
): PdfjsLib.PDFDataRangeTransport {
  class IpcPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    private aborted = false;

    constructor() {
      super(length, null);
    }

    requestDataRange(begin: number, end: number): void {
      if (this.aborted) return;
      void readRange(begin, end).then(
        data => {
          if (this.aborted) return;
          const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
          this.onDataRange(begin, chunk);
        },
        error => {
          if (this.aborted) return;
          this.aborted = true;
          onError(error);
        },
      );
    }

    abort(): void {
      this.aborted = true;
    }
  }

  return new IpcPdfRangeTransport();
}
