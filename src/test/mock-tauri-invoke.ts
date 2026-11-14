import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import type {
  DbMutationEffects,
  DbMutationEnvelope,
} from "../db/ipc";

export type TauriInvokeArgs = InvokeArgs | undefined;

export type TauriCommandHandler<TResult = unknown, TArgs = TauriInvokeArgs> = (
  args: TArgs,
) => TResult | Promise<TResult>;

export interface TauriInvokeCall {
  command: string;
  args: TauriInvokeArgs;
  options?: InvokeOptions;
}

export function dbMutationEnvelope<T>(
  value: T,
  effects: DbMutationEffects = {},
): DbMutationEnvelope<T> {
  return { value, effects };
}

export interface TauriInvokeRouter {
  readonly calls: readonly TauriInvokeCall[];
  invoke: <T = unknown>(
    command: string,
    args?: InvokeArgs,
    options?: InvokeOptions,
  ) => Promise<T>;
  handle: <TResult = unknown, TArgs = TauriInvokeArgs>(
    command: string,
    handler: TauriCommandHandler<TResult, TArgs>,
  ) => TauriInvokeRouter;
  mockQuery: <TResult>(
    command: string,
    valueOrHandler: TResult | TauriCommandHandler<TResult>,
  ) => TauriInvokeRouter;
  mockMutation: <TResult = null>(
    command: string,
    valueOrHandler?: TResult | TauriCommandHandler<TResult>,
    effects?: DbMutationEffects,
  ) => TauriInvokeRouter;
  reset: () => void;
  installOn: (target: {
    mockImplementation: (
      fn: <T>(
        command: string,
        args?: InvokeArgs,
        options?: InvokeOptions,
      ) => Promise<T>,
    ) => unknown;
  }) => TauriInvokeRouter;
}

function isHandler<TResult>(
  value: TResult | TauriCommandHandler<TResult>,
): value is TauriCommandHandler<TResult> {
  return typeof value === "function";
}

export function createTauriInvokeRouter(
  initialHandlers: Record<string, TauriCommandHandler> = {},
): TauriInvokeRouter {
  const handlers = new Map<string, TauriCommandHandler>(
    Object.entries(initialHandlers),
  );
  const recordedCalls: TauriInvokeCall[] = [];

  const router: TauriInvokeRouter = {
    get calls() {
      return recordedCalls;
    },
    async invoke<T = unknown>(
      command: string,
      args?: InvokeArgs,
      options?: InvokeOptions,
    ): Promise<T> {
      recordedCalls.push({ command, args, options });
      const handler = handlers.get(command);
      if (!handler) {
        throw new Error(`Unexpected Tauri invoke command: ${command}`);
      }
      return (await handler(args)) as T;
    },
    handle(command, handler) {
      handlers.set(command, handler as TauriCommandHandler);
      return router;
    },
    mockQuery(command, valueOrHandler) {
      handlers.set(command, async (args) =>
        isHandler(valueOrHandler) ? await valueOrHandler(args) : valueOrHandler,
      );
      return router;
    },
    mockMutation(command, valueOrHandler = null as never, effects = {}) {
      handlers.set(command, async (args) => {
        const value = isHandler(valueOrHandler)
          ? await valueOrHandler(args)
          : valueOrHandler;
        return dbMutationEnvelope(value, effects);
      });
      return router;
    },
    reset() {
      handlers.clear();
      for (const [command, handler] of Object.entries(initialHandlers)) {
        handlers.set(command, handler);
      }
      recordedCalls.length = 0;
    },
    installOn(target) {
      target.mockImplementation((command, args, options) =>
        router.invoke(command, args, options),
      );
      return router;
    },
  };

  return router;
}
