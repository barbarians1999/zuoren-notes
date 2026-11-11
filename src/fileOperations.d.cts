export function normalizeWindowsPath(value: string): string;
export function sameOrDescendantPath(candidate: string, parent: string): boolean;
export function remapDescendantPath(candidate: string, previousRoot: string, nextRoot: string): string;
export class MutationBarrier {
  constructor(ttlMs?: number);
  block(path: string, now?: number): void;
  pin(path: string): void;
  unpin(path: string): void;
  release(path: string, now?: number): void;
  releaseExact(path: string): void;
  has(path: string, now?: number): boolean;
}
