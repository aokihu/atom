export type MessageGatewayAuthConfig = {
  bearerToken?: string;
  bearerTokenEnv?: string;
};

export type MessageGatewayRootConfig = {
  enabled?: boolean;
  inboundPath?: string;
  auth?: MessageGatewayAuthConfig;
};

export type MessageGatewayChannelType = "telegram" | "http";

export type MessageGatewayChannelEndpointConfig = {
  host?: string;
  port: number;
  healthPath?: string;
  invokePath?: string;
  startupTimeoutMs?: number;
};

export type MessageGatewayChannelConfig = {
  id: string;
  type: MessageGatewayChannelType;
  enabled?: boolean;
  channelEndpoint: MessageGatewayChannelEndpointConfig;
  settings?: Record<string, unknown>;
};

export type MessageGatewayConfig = {
  gateway?: MessageGatewayRootConfig;
  channels?: MessageGatewayChannelConfig[];
};

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

export type ResolvedMessageGatewayConfig = {
  gateway: {
    enabled: boolean;
    inboundPath: string;
    auth: {
      bearerToken: string;
    };
  };
  channels: ResolvedMessageGatewayChannelConfig[];
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

export type MessageGatewayDeliverRequest = {
  conversationId: string;
  text: string;
  context?: Record<string, unknown>;
};

export type MessageGatewayDeliverResult = {
  delivered: boolean;
  externalMessageId?: string;
};

export type MessageGatewayHealthStatus = {
  enabled: boolean;
  inboundPath: string;
  configured: number;
  running: number;
  failed: number;
  channels: Array<{
    id: string;
    type: MessageGatewayChannelType;
    enabled: boolean;
    running: boolean;
    endpoint: string;
    pid?: number;
    error?: string;
  }>;
};
