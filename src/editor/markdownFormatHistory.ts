import { Annotation } from '@codemirror/state';
import { history } from '@codemirror/commands';

export const formatContinuation = Annotation.define<boolean>();

export function markdownHistory() {
  return history({ joinToEvent: (transaction, adjacent) => transaction.annotation(formatContinuation) === true || adjacent });
}
