type QueuedTask<T> = {
  page: number;
  seq: number;
  started: boolean;
  cancelled: boolean;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createCancellationError(): Error {
  const error = new Error('PDF render cancelled');
  error.name = 'RenderingCancelledException';
  return error;
}

export class PdfRenderQueue {
  private pending: QueuedTask<any>[] = [];
  private active = 0;
  private nextSeq = 0;
  private maxConcurrent: number;
  private getPriorityPage: () => number;

  constructor(
    maxConcurrent = 2,
    getPriorityPage: () => number = () => 1,
  ) {
    this.maxConcurrent = maxConcurrent;
    this.getPriorityPage = getPriorityPage;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.active;
  }

  enqueue<T>(page: number, run: () => Promise<T>): { promise: Promise<T>; cancel: () => void } {
    let item!: QueuedTask<T>;
    const promise = new Promise<T>((resolve, reject) => {
      item = {
        page,
        seq: this.nextSeq++,
        started: false,
        cancelled: false,
        run,
        resolve,
        reject,
      };
      this.pending.push(item);
      this.pump();
    });

    const cancel = () => {
      if (item.cancelled) return;
      item.cancelled = true;
      if (!item.started) {
        const index = this.pending.indexOf(item);
        if (index >= 0) this.pending.splice(index, 1);
        item.reject(createCancellationError());
      }
    };

    return { promise, cancel };
  }

  clear(): void {
    const toCancel = this.pending.splice(0, this.pending.length);
    for (const item of toCancel) {
      item.cancelled = true;
      item.reject(createCancellationError());
    }
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const targetPage = this.getPriorityPage();
      let bestIndex = 0;
      let bestDistance = Math.abs(this.pending[0].page - targetPage);
      for (let i = 1; i < this.pending.length; i += 1) {
        const candidate = this.pending[i];
        const distance = Math.abs(candidate.page - targetPage);
        if (distance < bestDistance || (distance === bestDistance && candidate.seq < this.pending[bestIndex].seq)) {
          bestIndex = i;
          bestDistance = distance;
        }
      }
      const [task] = this.pending.splice(bestIndex, 1);
      if (task.cancelled) continue;
      task.started = true;
      this.active += 1;
      Promise.resolve()
        .then(() => task.run())
        .then(
          value => task.resolve(value),
          error => task.reject(error),
        )
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}
