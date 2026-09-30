// Starting a request invalidates its predecessor, including failed responses.
class LatestRequest {
  constructor() { this.generation = 0; }
  invalidate() { this.generation++; }
  begin() { const generation = ++this.generation; return () => generation === this.generation; }
}
module.exports = { LatestRequest };
