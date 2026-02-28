import type { GatewayClient } from "./channel";
import type { GetTaskOptions } from "./channel";
import type {
  AgentMemoryCompactResponse,
  AgentMemoryDeleteRequest,
  AgentMemoryDeleteResponse,
  AgentMemoryFeedbackRequest,
  AgentMemoryFeedbackResponse,
  AgentMemoryGetRequest,
  AgentMemoryGetResponse,
  AgentMemoryListRecentRequest,
  AgentMemoryListRecentResponse,
  AgentMemorySearchRequest,
  AgentMemorySearchResponse,
  AgentMemoryStatsResponse,
  AgentMemoryTagResolveRequest,
  AgentMemoryTagResolveResponse,
  AgentMemoryUpdateRequest,
  AgentMemoryUpdateResponse,
  AgentMemoryUpsertRequest,
  AgentMemoryUpsertResponse,
  CancelScheduleResponse,
  ApiErrorResponse,
  ApiSuccessResponse,
  CreateScheduleRequest,
  CreateScheduleResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  ForceAbortResponse,
  HealthzResponse,
  ListSchedulesResponse,
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

  async getHealth(options?: { probeMcpHttp?: boolean }): Promise<HealthzResponse> {
    const query = new URLSearchParams();
    if (options?.probeMcpHttp) {
      query.set("probeMcpHttp", "1");
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return await this.request<HealthzResponse>(`/healthz${suffix}`, { method: "GET" });
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

  async createSchedule(request: CreateScheduleRequest): Promise<CreateScheduleResponse> {
    return await this.request<CreateScheduleResponse>("/v1/schedules", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async listSchedules(): Promise<ListSchedulesResponse> {
    return await this.request<ListSchedulesResponse>("/v1/schedules", {
      method: "GET",
    });
  }

  async cancelSchedule(scheduleId: string): Promise<CancelScheduleResponse> {
    return await this.request<CancelScheduleResponse>(
      `/v1/schedules/${encodeURIComponent(scheduleId)}`,
      {
        method: "DELETE",
      },
    );
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

  async memorySearch(request: AgentMemorySearchRequest): Promise<AgentMemorySearchResponse> {
    return await this.request<AgentMemorySearchResponse>("/v1/agent/memory/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async memoryGet(request: AgentMemoryGetRequest): Promise<AgentMemoryGetResponse> {
    return await this.request<AgentMemoryGetResponse>("/v1/agent/memory/get", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async memoryUpsert(request: AgentMemoryUpsertRequest): Promise<AgentMemoryUpsertResponse> {
    return await this.request<AgentMemoryUpsertResponse>("/v1/agent/memory/upsert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async memoryUpdate(request: AgentMemoryUpdateRequest): Promise<AgentMemoryUpdateResponse> {
    return await this.request<AgentMemoryUpdateResponse>("/v1/agent/memory/update", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async memoryDelete(request: AgentMemoryDeleteRequest): Promise<AgentMemoryDeleteResponse> {
    return await this.request<AgentMemoryDeleteResponse>("/v1/agent/memory/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async memoryFeedback(request: AgentMemoryFeedbackRequest): Promise<AgentMemoryFeedbackResponse> {
    return await this.request<AgentMemoryFeedbackResponse>("/v1/agent/memory/feedback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async memoryTagResolve(
    request: AgentMemoryTagResolveRequest,
  ): Promise<AgentMemoryTagResolveResponse> {
    return await this.request<AgentMemoryTagResolveResponse>("/v1/agent/memory/tag_resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  }

  async memoryStats(): Promise<AgentMemoryStatsResponse> {
    return await this.request<AgentMemoryStatsResponse>("/v1/agent/memory/stats", {
      method: "GET",
    });
  }

  async memoryCompact(): Promise<AgentMemoryCompactResponse> {
    return await this.request<AgentMemoryCompactResponse>("/v1/agent/memory/compact", {
      method: "POST",
    });
  }

  async memoryListRecent(request?: AgentMemoryListRecentRequest): Promise<AgentMemoryListRecentResponse> {
    return await this.request<AgentMemoryListRecentResponse>("/v1/agent/memory/list_recent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request ?? {}),
    });
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
