import type { GatewayClient } from "./channel";
import type { GetTaskOptions } from "./channel";
import type {
  ApiErrorResponse,
  ApiSuccessResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  ForceAbortResponse,
  HealthzResponse,
  TaskStatusResponse,
  AgentContextResponse,
  AgentContextLiteResponse,
  AgentMessagesResponse,
} from "../../types/http";

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

const isApiErrorResponse = (value: unknown): value is ApiErrorResponse => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== false) return false;
  if (typeof v.error !== "object" || v.error === null) return false;
  const error = v.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
};

const isApiSuccessResponse = <T>(value: unknown): value is ApiSuccessResponse<T> => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.ok === true && "data" in v;
};

const formatNetworkError = (baseUrl: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to reach ${baseUrl}: ${message}`;
};

export class HttpGatewayClient implements GatewayClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async getHealth(): Promise<HealthzResponse> {
    return await this.request<HealthzResponse>("/healthz", { method: "GET" });
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

  async getTask(taskId: string, options?: GetTaskOptions): Promise<TaskStatusResponse> {
    const query = new URLSearchParams();
    if (options?.afterSeq !== undefined) {
      query.set("afterSeq", String(options.afterSeq));
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";

    return await this.request<TaskStatusResponse>(`/v1/tasks/${encodeURIComponent(taskId)}${suffix}`, {
      method: "GET",
    });
  }

  async getAgentContext(): Promise<AgentContextResponse> {
    return await this.request<AgentContextResponse>("/v1/agent/context", { method: "GET" });
  }

  async getAgentContextLite(): Promise<AgentContextLiteResponse> {
    return await this.request<AgentContextLiteResponse>("/v1/agent/context-lite", { method: "GET" });
  }

  async getAgentMessages(): Promise<AgentMessagesResponse> {
    return await this.request<AgentMessagesResponse>("/v1/agent/messages", { method: "GET" });
  }

  async forceAbort(): Promise<ForceAbortResponse> {
    return await this.request<ForceAbortResponse>("/forceabort", { method: "POST" });
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
    let payload: unknown = undefined;

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
