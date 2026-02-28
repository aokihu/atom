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
    const data = await withConnectionTracking(() => client.getAgentContext());
    callbacks.onSuccess(formatJson(data.context), data.context);
  } catch (error) {
    callbacks.onError(formatErrorMessage(error));
  } finally {
    callbacks.onFinally();
  }
};
