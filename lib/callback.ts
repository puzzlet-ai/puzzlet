// Constants
const DEFAULT_TIMEOUT_SECONDS: number = 0; // Default timeout for callback execution in seconds

export interface CallbackEvent {
  name: string;
  // Anything available at the time the event happens. It is passed to the callback
  data: any;
  // Timestamp in nanoseconds. Use Date.now()
  ts_ns?: number;
}

// Type Aliases
type Callback = (event: CallbackEvent) => Promise<any>;
// type Result = Ok<any> | Err<any>;

async function withTimeout(
  promise: Promise<any>,
  timeout: number
): Promise<any> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Timeout"));
    }, timeout * 1000);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutPromise,
  ]);
}

export class CallbackManager {
  callbacks: Callback[];
  results: any[];
  timeout: number;

  constructor(
    callbacks: Callback[],
    timeout: number = DEFAULT_TIMEOUT_SECONDS
  ) {
    this.callbacks = callbacks;
    this.results = [];
    this.timeout = timeout;
  }

  async runCallbacks(event: CallbackEvent): Promise<void> {
    const eventWithTimeStamp = {
      ...event,
      ts_ns: event.ts_ns ?? Date.now(),
    };

    const tasks = this.callbacks.map((callback) =>
      withTimeout(callback(eventWithTimeStamp), this.timeout)
    );
    this.results = await Promise.all(tasks);
  }
}
