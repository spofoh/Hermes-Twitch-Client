import type WebSocket from 'ws';

export interface HermesClientOptions {
  clientId: string;
  authToken?: string;
  wsOptions?: WebSocket.ClientOptions;
  maxReconnectAttempts?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectBackoffFactor?: number;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

interface BaseIncomingMessage {
  id: string;
  timestamp?: string;
  parentId?: string;
}

export interface WelcomeMessage extends BaseIncomingMessage {
  type: 'welcome';
  welcome: {
    sessionId: string;
    keepaliveSec: number;
    recoveryUrl: string;
  };
}

export interface ReconnectMessage extends BaseIncomingMessage {
  type: 'reconnect';
  reconnect: {
    url: string;
  };
}

export interface KeepaliveMessage extends BaseIncomingMessage {
  type: 'reconnect';
  timestamp: string;
  id: string;
}

export interface NotificationMessage extends BaseIncomingMessage {
  type: 'notification';
  id: string;
  timestamp: string;
  notification: {
    subscription: {
      id: string;
    };
    type: string;
    pubsub?: Record<string, any>;
  };
}

export interface SubscribeResponseMessage extends BaseIncomingMessage {
  type: 'subscribeResponse';
  subscribeResponse: {
    result: 'ok' | 'error' | string;
    errorCode?: 'SUB004' | 'SUB007' | string;
    error?: 'unauthorized' | string;
    subscription: {
      id: string;
    };
  };
}

export interface UnSubscribeResponseMessage extends BaseIncomingMessage {
  type: 'unsubscribeResponse';
  unsubscribeResponse: {
    result: 'ok' | 'error' | string;
    errorCode?: 'UNSUB001' | string;
    error?: string;
    subscription: {
      id: string;
    };
  };
}

export interface AuthenticateResponseMessage extends BaseIncomingMessage {
  type: 'authenticateResponse';
  authenticateResponse: {
    result: 'ok' | string;
    errorCode?: string;
    error?: string;
  };
}

export type IncomingMessage =
  | WelcomeMessage
  | ReconnectMessage
  | NotificationMessage
  | SubscribeResponseMessage
  | UnSubscribeResponseMessage
  | AuthenticateResponseMessage;

interface BaseOutgoingMessage {
  id: string;
  type: string;
}

export interface SubscribeRequest extends BaseOutgoingMessage {
  type: 'subscribe';
  subscribe: {
    id: string;
    type: 'pubsub';
    pubsub: {
      topic: string;
    };
  };
}

export interface UnsubscribeRequest extends BaseOutgoingMessage {
  type: 'unsubscribe';
  unsubscribe: {
    id: string;
  };
}

export interface AuthenticateRequest extends BaseOutgoingMessage {
  type: 'authenticate';
  authenticate: {
    token: string;
  };
}

export type OutgoingMessage =
  | SubscribeRequest
  | UnsubscribeRequest
  | AuthenticateRequest;

export interface HermesClientEvents {
  ready: () => void;
  disconnect: (payload: {
    code: number;
    reason: Buffer;
    wasClean: boolean;
  }) => void;
  error: (error: Error) => void;
  reconnecting: (payload: { attempt: number; delay: number }) => void;
  welcome: (message: WelcomeMessage) => void;
  reconnect: (message: ReconnectMessage) => void;
  message: (message: NotificationMessage) => void;
  subscribeResponse: (message: SubscribeResponseMessage) => void;
  unsubscribeResponse: (message: UnSubscribeResponseMessage) => void;
  authenticateResponse: (message: AuthenticateResponseMessage) => void;
  keepalive: (message: KeepaliveMessage) => void;
  unknownMessage: (
    rawMessage: Buffer | ArrayBuffer | Buffer[],
    parsed?: unknown
  ) => void;
}

export type RetryFunction = <T>(
  retrier: (bail: (e: Error) => void, attempt: number) => Promise<T>
) => Promise<T>;
