/** A serial queue (an actor's mailbox): tasks run one at a time, in order; a failure does not block later tasks. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(task: () => Promise<T> | T): Promise<T> {
    this.pending++;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => this.pending--,
      () => this.pending--,
    );
    return result;
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  /** Resolves when everything queued so far has run. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
