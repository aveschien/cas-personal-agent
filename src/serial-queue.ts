export class IngestBusyError extends Error {
  readonly waitTimeoutMs: number;

  constructor(waitTimeoutMs: number) {
    super(`ingest queue wait timed out after ${waitTimeoutMs}ms`);
    this.name = "IngestBusyError";
    this.waitTimeoutMs = waitTimeoutMs;
  }
}

export interface SerialQueue {
  run<T>(
    work: () => Promise<T>,
    options?: { readonly waitTimeoutMs?: number },
  ): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    run<T>(
      work: () => Promise<T>,
      options: { readonly waitTimeoutMs?: number } = {},
    ): Promise<T> {
      let release = (): void => undefined;
      const previous = tail;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      tail = previous.catch(() => undefined).then(() => held);

      const acquired = previous.catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      const waitTimeoutMs = options.waitTimeoutMs;
      const wait =
        waitTimeoutMs === undefined
          ? acquired
          : Promise.race([
              acquired,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  reject(new IngestBusyError(waitTimeoutMs));
                }, waitTimeoutMs);
                timer.unref();
              }),
            ]);

      return wait.then(
        async () => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          try {
            return await work();
          } finally {
            release();
          }
        },
        (error: unknown) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          release();
          throw error;
        },
      );
    },
  };
}
