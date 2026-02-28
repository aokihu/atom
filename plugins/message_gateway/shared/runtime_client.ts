import type {
  ApiErrorResponse,
  ApiSuccessResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  TaskStatusResponse,
} from "./types";

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const isApiErrorResponse = (value: unknown): value is ApiErrorResponse => {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (payload.ok !== false) return false;
  if (typeof payload.error !== "object" || payload.error === null) return false;
  const errorPayload = payload.error as Record<string, unknown>;
  return typeof errorPayload.code === "string" && typeof errorPayload.message === "string";
};

const isApiSuccessResponse = <T>(value: unknown): value is ApiSuccessResponse<T> => {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return payload.ok === true && "data" in payload;
};

const formatNetworkError = (baseUrl: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to reach ${baseUrl}: ${message}`;
};

export class RuntimeHttpClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async createTask(request: CreateTaskRequest): Promise<CreateTaskResponse> {
    return await this.request<CreateTaskResponse>("/v1/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async getTask(taskId: string): Promise<TaskStatusResponse> {
    return await this.request<TaskStatusResponse>(`/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new Error(formatNetworkError(this.baseUrl, error));
    }

    const text = await response.text();
    let payload: unknown;

    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON response from ${this.baseUrl}${path}`);
      }
    }

    if (!response.ok) {
      if (isApiErrorResponse(payload)) {
        throw new Error(`${payload.error.code}: ${payload.error.message}`);
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    if (!isApiSuccessResponse<T>(payload)) {
      throw new Error(`Invalid API response from ${this.baseUrl}${path}`);
    }

    return payload.data;
  }
}
