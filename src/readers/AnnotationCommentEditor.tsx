import { useState } from 'react';

export function AnnotationCommentEditor({ comment, busy, onSave, onCancel }: {
  comment: string; busy: boolean; onSave: (comment: string) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(comment);
  return <form className="annotation-comment-editor" onSubmit={event => { event.preventDefault(); if (!busy) onSave(draft.trim()); }}>
    <textarea autoFocus disabled={busy} aria-label="批注内容" maxLength={10000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="写下批注"/>
    <div>
      <button type="submit" className="primary" disabled={busy}>保存批注</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </form>;
}
