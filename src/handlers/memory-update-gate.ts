/**
 * Per-session memory update gate.
 *
 * Guarantees that only one memory update pipeline runs at a time within the
 * same session: background review, correction save, flush, and consolidation.
 *
 * Re-entrant by design: if a memory update triggers another memory update
 * inside the same async call chain (for example, reviewAndApply -> store.add ->
 * auto-consolidation), the nested call runs inline instead of queueing behind
 * itself and deadlocking.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): PromiseWithResolvers<T>;
  }
}

export class MemoryUpdateGate {
  readonly #owner = new AsyncLocalStorage<number>();
  #tail: Promise<void> = Promise.resolve();
  #activeOrQueued = 0;
  #nextOwnerId = 1;

  /** Returns true when another top-level memory update is active or queued. */
  isBusy(): boolean {
    return this.#activeOrQueued > 0;
  }

  /**
   * Serialize a memory update behind any earlier one.
   * Re-entrant calls from the current owner run inline.
   */
  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.#owner.getStore() !== undefined) {
      return task();
    }

    const previous = this.#tail.catch(() => undefined);
    const { promise, resolve } = Promise.withResolvers<void>();

    this.#activeOrQueued++;
    this.#tail = previous.then(() => promise);

    await previous;

    const ownerId = this.#nextOwnerId++;
    try {
      return await this.#owner.run(ownerId, task);
    } finally {
      this.#activeOrQueued--;
      resolve();
    }
  }

  /**
   * Run only if no other top-level memory update is active or queued.
   * Re-entrant calls from the current owner still run inline.
   */
  async runIfIdle<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (this.#owner.getStore() !== undefined) {
      return task();
    }
    if (this.#activeOrQueued > 0) {
      return undefined;
    }
    return this.runExclusive(task);
  }
}
