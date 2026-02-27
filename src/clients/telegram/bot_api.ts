export type TelegramChat = {
  id: number;
  type: string;
};

export type TelegramMessage = {
  message_id: number;
  date?: number;
  text?: string;
  chat: TelegramChat;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramApiSuccess<T> = {
  ok: true;
  result: T;
};

type TelegramApiFailure = {
  ok: false;
  description?: string;
  error_code?: number;
};

type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

export type TelegramGetUpdatesOptions = {
  offset?: number;
  timeoutSec?: number;
  limit?: number;
};

export type TelegramSendMessageOptions = {
  chatId: string;
  text: string;
  parseMode?: "MarkdownV2";
};

export type TelegramBotApi = {
  getUpdates: (options?: TelegramGetUpdatesOptions) => Promise<TelegramUpdate[]>;
  sendMessage: (options: TelegramSendMessageOptions) => Promise<void>;
};

type CreateTelegramBotApiOptions = {
  botToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, "");

const toApiErrorMessage = (payload: TelegramApiFailure, endpoint: string): string => {
  const code = typeof payload.error_code === "number" ? ` ${payload.error_code}` : "";
  const description = payload.description?.trim() || "Unknown Telegram API error";
  return `Telegram API${code} ${endpoint}: ${description}`;
};

export const createTelegramBotApi = (
  options: CreateTelegramBotApiOptions,
): TelegramBotApi => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.telegram.org");
  const token = options.botToken.trim();
  const apiBase = `${baseUrl}/bot${token}`;

  const request = async <T>(
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase}/${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new Error(
        `Failed to reach Telegram API (${endpoint}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Telegram API (${endpoint}) returned invalid JSON`);
    }

    if (typeof body !== "object" || body === null || !("ok" in body)) {
      throw new Error(`Telegram API (${endpoint}) returned invalid payload`);
    }

    const data = body as TelegramApiResponse<T>;
    if (!response.ok || data.ok === false) {
      const failurePayload: TelegramApiFailure =
        data.ok === false ? data : { ok: false, description: response.statusText };
      throw new Error(toApiErrorMessage(failurePayload, endpoint));
    }

    return data.result;
  };

  return {
    async getUpdates(options): Promise<TelegramUpdate[]> {
      return await request<TelegramUpdate[]>("getUpdates", {
        offset: options?.offset,
        timeout: options?.timeoutSec,
        limit: options?.limit,
        allowed_updates: ["message"],
      });
    },
    async sendMessage(options): Promise<void> {
      await request<unknown>("sendMessage", {
        chat_id: options.chatId,
        text: options.text,
        ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      });
    },
  };
};
