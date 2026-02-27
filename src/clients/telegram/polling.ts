import { sleep } from "bun";

import type { TelegramBotApi, TelegramUpdate } from "./bot_api";

export type RunTelegramPollingOptions = {
  api: TelegramBotApi;
  signal: AbortSignal;
  pollingIntervalMs: number;
  longPollTimeoutSec: number;
  dropPendingUpdatesOnStart: boolean;
  onUpdate: (update: TelegramUpdate) => Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
};

export const nextBackoffMs = (
  current: number,
  base = 1000,
  max = 30000,
): number => {
  if (current <= 0) return base;
  return Math.min(current * 2, max);
};

const getNextOffset = (currentOffset: number, updates: TelegramUpdate[]): number => {
  let nextOffset = currentOffset;
  for (const update of updates) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);
  }
  return nextOffset;
};

const dropPendingUpdates = async (
  api: TelegramBotApi,
  logger: Pick<Console, "log" | "warn">,
): Promise<number> => {
  let offset = 0;

  for (;;) {
    const updates = await api.getUpdates({
      offset,
      timeoutSec: 0,
      limit: 100,
    });
    if (updates.length === 0) {
      return offset;
    }

    offset = getNextOffset(offset, updates);
    logger.log(`[telegram] dropped ${updates.length} pending updates`);
  }
};

export const runTelegramPolling = async (
  options: RunTelegramPollingOptions,
): Promise<void> => {
  const logger = options.logger ?? console;
  let offset = 0;
  let backoffMs = 0;

  if (options.dropPendingUpdatesOnStart) {
    offset = await dropPendingUpdates(options.api, logger);
  }

  while (!options.signal.aborted) {
    try {
      const updates = await options.api.getUpdates({
        offset,
        timeoutSec: options.longPollTimeoutSec,
        limit: 100,
      });

      if (updates.length === 0) {
        if (options.pollingIntervalMs > 0) {
          await sleep(options.pollingIntervalMs);
        }
        backoffMs = 0;
        continue;
      }

      for (const update of updates) {
        if (options.signal.aborted) {
          return;
        }

        try {
          await options.onUpdate(update);
        } catch (error) {
          logger.warn(
            `[telegram] update ${update.update_id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      offset = getNextOffset(offset, updates);
      backoffMs = 0;
    } catch (error) {
      backoffMs = nextBackoffMs(backoffMs);
      logger.warn(
        `[telegram] polling failed, retry in ${backoffMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(backoffMs);
    }
  }
};
