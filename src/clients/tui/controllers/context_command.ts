/**
 * TUI context command controller.
 *
 * Purpose:
 * - Execute the "/context" command flow.
 * - Coordinate gateway calls and lifecycle callbacks without view coupling.
 */

import type { GatewayClient } from "../../../libs/channel/channel";

type WithConnectionTracking = <T>(operation: () => Promise<T>) => Promise<T>;

export type ExecuteContextCommandCallbacks = {
  onStart: () => void;
  onSuccess: (body: string) => void;
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
    const data = await withConnectionTracking(async () => {
      if (typeof client.getAgentContextLite === "function") {
        try {
          return await client.getAgentContextLite();
        } catch {
          // backward-compatible fallback to legacy endpoint
        }
      }
      return await client.getAgentContext();
    });
    callbacks.onSuccess(formatJson(data));
  } catch (error) {
    callbacks.onError(formatErrorMessage(error));
  } finally {
    callbacks.onFinally();
  }
};
