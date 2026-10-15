// epub.js locations runs Section.load in a background queue. Clearing pending
// work does not cancel the active load: its hooks must live until it settles.
export async function releaseEpubBook(book: { locations: unknown; destroy: () => void }, pending?: Promise<unknown>) {
  const locations = book.locations as { q?: { clear: () => void } } | undefined;
  locations?.q?.clear();
  if (pending) await pending.catch(() => undefined);
  book.destroy();
}
