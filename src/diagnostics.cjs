// Bounded, metadata-only trace. Never retain note text, clipboard or full paths.
class DiagnosticRing {
  constructor(limit = 200) { this.limit = limit; this.events = []; this.sequence = 0; }
  record(operation, detail = {}) {
    const event = { sequence: ++this.sequence, at: Date.now(), operation };
    for (const key of ['pane', 'documentId', 'revision', 'submittedRevision', 'committedRevision', 'status'])
      if (typeof detail[key] === 'number' || typeof detail[key] === 'string') event[key] = detail[key];
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }
  snapshot() { return this.events.map(event => ({ ...event })); }
}
const diagnostics = new DiagnosticRing();
module.exports = { DiagnosticRing, diagnostics };
