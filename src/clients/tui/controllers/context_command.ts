import type { GatewayClient } from "../../../libs/channel/channel";

type WithConnectionTracking = <T>(operation: () => Promise<T>) => Promise<T>;

export type ExecuteContextCommandCallbacks = {
  onStart: () => void;
  onSuccess: (body: string, context: unknown) => void;
  onError: (message: string) => void;
  onFinally: () => void;
};

export type ExecuteContextCommandInput = {
  client: GatewayClient;
  withConnectionTracking: WithConnectionTracking;
  formatJson: (value: unknown) => string;
  formatErrorMessage: (error: unknown) => string;
  callbacks: ExecuteContextCommandCallbacks;
};

export const executeContextCommand = async (input: ExecuteContextCommandInput): Promise<void> => {
  const { client, withConnectionTracking, formatJson, formatErrorMessage, callbacks } = input;
  callbacks.onStart();
  try {
    if (typeof client.getAgentContextLite === "function") {
      try {
        const lite = await withConnectionTracking(() => client.getAgentContextLite!());
        callbacks.onSuccess(formatJson(lite.modelContext), lite.modelContext);
        return;
      } catch {
        // fallback to legacy endpoint
      }
    }

    const legacy = await withConnectionTracking(() => client.getAgentContext());
    callbacks.onSuccess(formatJson(legacy.injectedContext ?? legacy.context), legacy.injectedContext ?? legacy.context);
  } catch (error) {
    callbacks.onError(formatErrorMessage(error));
  } finally {
    callbacks.onFinally();
  }
};
