export type MessageGatewayChannelType = "telegram" | "http";

export type ResolvedMessageGatewayChannelEndpoint = {
  host: string;
  port: number;
  healthPath: string;
  invokePath: string;
  startupTimeoutMs: number;
};

export type ResolvedMessageGatewayChannelConfig = {
  id: string;
  type: MessageGatewayChannelType;
  enabled: boolean;
  channelEndpoint: ResolvedMessageGatewayChannelEndpoint;
  settings: Record<string, unknown>;
};

export type MessageGatewayInboundRequest = {
  requestId: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  rawBody: string;
  receivedAt: number;
};

export type MessageGatewayInboundMessage = {
  messageId?: string;
  conversationId: string;
  senderId?: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type MessageGatewayImmediateResponse = {
  conversationId: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type MessageGatewayParseInboundResult = {
  accepted: boolean;
  messages: MessageGatewayInboundMessage[];
  immediateResponses?: MessageGatewayImmediateResponse[];
};

export type TaskStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export type TaskExecutionStopReason =
  | "tool_budget_exhausted"
  | "step_limit_segment_continue"
  | "model_step_budget_exhausted"
  | "continuation_limit_reached"
  | "tool_policy_blocked"
  | "intent_execution_failed";

export type TaskExecutionMetadata = {
  completed: boolean;
  stopReason: TaskExecutionStopReason;
  segmentCount?: number;
  totalToolCalls?: number;
  totalModelSteps?: number;
  retrySuppressed?: boolean;
};

export type TaskSnapshot = {
  id: string;
  type: string;
  priority: number;
  status: TaskStatus;
  input: string;
  result?: string;
  error?: {
    message: string;
    stack?: string;
  };
  retries: number;
  maxRetries: number;
  createAt: number;
  startedAt?: number;
  finishedAt?: number;
  parentId?: string;
  metadata?: Record<string, unknown> & {
    execution?: TaskExecutionMetadata;
  };
  cancellable?: boolean;
};

export type CreateTaskRequest = {
  input: string;
  priority?: number;
  type?: string;
};

export type CreateTaskResponse = {
  taskId: string;
  task: TaskSnapshot;
};

export type TaskStatusResponse = {
  task: TaskSnapshot;
  messages?: {
    items: unknown[];
    nextSeq: number;
    latestSeq: number;
  };
};

export type ApiErrorResponse = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type ApiSuccessResponse<T> = {
  ok: true;
  data: T;
};
