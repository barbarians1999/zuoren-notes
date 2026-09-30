export class DiagnosticRing {
  constructor(limit?: number);
  record(operation: string, detail?: Record<string, string | number>): void;
  snapshot(): Array<Record<string, string | number>>;
}
export const diagnostics: DiagnosticRing;
