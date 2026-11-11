import { findClusterBreak, Transaction, type EditorState, type ChangeSet } from '@codemirror/state';

export const EDIT_CARET_DURATION = 75;
export const DELETE_ECHO_DURATION = 110;
export type EditInputType = 'insertText' | 'deleteContentBackward' | 'deleteContentForward';

export class EditMotionGate {
  private lastInput = -Infinity;
  private quietUntil = 0;
  private composing = false;
  compositionStart(now: number) { this.composing = true; this.quietUntil = now + 160; }
  compositionEnd(now: number) { this.composing = false; this.quietUntil = now + 160; }
  repeat(now: number) { this.quietUntil = now + 160; }
  accept(now: number) {
    const rapid = now - this.lastInput < 60;
    this.lastInput = now;
    if (rapid) this.quietUntil = now + 140;
    return !this.composing && !rapid && now >= this.quietUntil;
  }
}

export function plainEdit(before: EditorState, after: EditorState, transactions: readonly Transaction[], changes: ChangeSet, inputType: EditInputType) {
  if (transactions.length !== 1 || before.selection.ranges.length !== 1 || after.selection.ranges.length !== 1
      || !before.selection.main.empty || !after.selection.main.empty) return null;
  const event = transactions[0].annotation(Transaction.userEvent);
  const ranges: { fromA: number; toA: number; fromB: number; toB: number; insert: string }[] = [];
  let oversized = false;
  changes.iterChanges((fromA, toA, fromB, toB, text) => {
    if (text.length > 8) oversized = true;
    ranges.push({ fromA, toA, fromB, toB, insert: text.length > 8 ? '' : text.toString() });
  });
  if (oversized) return null;
  if (ranges.length !== 1) return null;
  const change = ranges[0], head = before.selection.main.head;
  if (inputType === 'insertText') {
    if (event !== 'input.type' || change.fromA !== head || change.toA !== head || !change.insert.length
        || change.insert.length > 8 || /[\r\n\t\x00-\x1f]/.test(change.insert)
        || after.selection.main.head !== change.toB) return null;
  } else {
    if (event !== (inputType === 'deleteContentBackward' ? 'delete.backward' : 'delete.forward')
        || change.insert || change.toA - change.fromA < 1 || change.toA - change.fromA > 8
        || /[\r\n\t\x00-\x1f]/.test(before.sliceDoc(change.fromA, change.toA))
        || after.selection.main.head !== change.fromB
        || (inputType === 'deleteContentBackward' ? change.toA !== head : change.fromA !== head)) return null;
  }
  return change;
}

export function deletionGrapheme(state: EditorState, forward: boolean) {
  const selection = state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return null;
  const head = selection.main.head, line = state.doc.lineAt(head);
  if (line.length > 1024 || forward && head === line.to || !forward && head === line.from) return null;
  const next = line.from + findClusterBreak(line.text, head - line.from, forward, true);
  const from = Math.min(head, next), to = Math.max(head, next);
  const text = state.sliceDoc(from, to);
  return text && text.length <= 8 && !/[\r\n\t\x00-\x1f]/.test(text) ? { from, to, text } : null;
}

export function shortHorizontalMove(from: { left: number; top: number; height: number }, to: { left: number; top: number; height: number }, allowStationary = false) {
  const values = [from.left, from.top, from.height, to.left, to.top, to.height];
  return values.every(Number.isFinite) && Math.abs(from.top - to.top) <= 1.5
    && Math.abs(from.height - to.height) <= 4 && (allowStationary || Math.abs(from.left - to.left) >= .5) && Math.abs(from.left - to.left) <= 48;
}
