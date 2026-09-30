import type { ReaderApi } from './types';

declare global {
  interface Window {
    reader: ReaderApi;
  }
}


export {};
