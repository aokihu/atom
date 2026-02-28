import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { MessageGatewayChannelType } from "../../types/message_gateway";

const PLUGIN_ENTRY_BY_TYPE: Record<MessageGatewayChannelType, string> = {
  telegram: "plugins/message_gateway/telegram/index.ts",
  http: "plugins/message_gateway/http/index.ts",
};

const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const resolveMessageGatewayPluginEntry = (
  type: MessageGatewayChannelType,
): string => resolve(projectRoot, PLUGIN_ENTRY_BY_TYPE[type]);
