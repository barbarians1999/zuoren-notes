export class MetadataWriter<T extends { id: string }> {
  tail: Promise<unknown>;
  write(options: { key: unknown; initial: T; change(current: T): T; persist(value: T): Promise<unknown>; commit(value: T): void }): Promise<boolean>;
}
