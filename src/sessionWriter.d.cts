export class SessionWriter {
  write<T>(snapshot: T, persist: (snapshot: T) => Promise<unknown>, force?: boolean): Promise<void>;
}
