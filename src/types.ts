import type WebSocket from 'ws';

/** Options for constructing the HermesClient. */
export interface HermesClientOptions {
  /** Your Twitch application Client ID. Required. */
  clientId: string;
  /** An OAuth token (without "oauth:") for authenticated access. Optional. */
  authToken?: string;
  /** Advanced options passed directly to the underlying 'ws' WebSocket constructor. */
  wsOptions?: WebSocket.ClientOptions;
  /** Maximum number of reconnect attempts before emitting a fatal error. Default: Infinity */
  maxReconnectAttempts?: number;
  /** Initial delay in ms before the first reconnect attempt. Default: 1000 */
  initialReconnectDelayMs?: number;
  /** Maximum delay in ms between reconnect attempts. Default: 30000 */
  maxReconnectDelayMs?: number;
  /** Backoff factor for reconnect attempts. Default: 2 */
  reconnectBackoffFactor?: number;
}

/** Represents the connection state of the client. */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

// --- Incoming Message Interfaces ---

// Based on browser snippet and common patterns. May need refinement.
// All messages *should* have an 'id' according to the snippet analysis.

interface BaseIncomingMessage {
  id: string;
  timestamp?: string; // Observed in browser, maybe optional?
  parentId?: string; // Used in responses
}

export interface WelcomeMessage extends BaseIncomingMessage {
  type: 'welcome';
  welcome: {
    sessionId: string;
    keepaliveSec: number;
    recoveryUrl: string; // Full URL for reconnection attempts
    // Potentially other fields
  };
}

export interface ReconnectMessage extends BaseIncomingMessage {
  type: 'reconnect';
  reconnect: {
    url: string; // Full URL for immediate reconnection
    // Potentially other fields
  };
}

export interface KeepaliveMessage extends BaseIncomingMessage {
  type: 'reconnect';
  timestamp: string;
  id: string;
}

export interface NotificationMessage extends BaseIncomingMessage {
  type: 'notification';
  notification: {
    subscription: {
      id: string; // The subscription ID
      type: string; // e.g., "pubsub"
      // Potentially other fields like version, cost
    };
    pubsub?: string; // JSON string containing the actual PubSub message data
    telemetry?: {
      // Optional telemetry info seen in browser code
      eventHash?: string;
      eventIdHash?: string;
      filterHash?: string;
      subjectHash?: string;
      cellHash?: string;
    };
    // Potentially other fields based on notification type
  };
}

export interface SubscribeResponseMessage extends BaseIncomingMessage {
  type: 'subscribeResponse';
  subscribeResponse: {
    result: 'ok' | string; // 'ok' on success, error code string on failure (e.g., "SUB001")
    errorCode?: string; // e.g., "SUB001", "SUB004", "SUB007"
    error?: string; // Optional descriptive error message
    subscription: {
      // Echoes back the subscription details
      id: string;
      type: string;
      pubsub?: {
        topic: string;
      };
      // Potentially other fields
    };
    telemetry?: {
      // Optional telemetry info seen in browser code
      intervalSeconds: number;
      variations: Array<{
        eventHash?: string;
        filterHash?: string;
        subjectHash?: string;
        cellHash?: string;
      }>;
    };
    // Error-specific fields, e.g., for SUB004
    SUB004?: {
      existingSubscriptionId: string;
    };
  };
}

export interface AuthenticateResponseMessage extends BaseIncomingMessage {
  type: 'authenticateResponse';
  authenticateResponse: {
    result: 'ok' | string; // 'ok' or error code
    errorCode?: string;
    error?: string; // Optional descriptive error message
    // Potentially other fields
  };
}

export interface SubscriptionRevocationMessage extends BaseIncomingMessage {
  type: 'subscriptionRevocation';
  subscriptionRevocation: {
    reason: string; // Reason for revocation
    subscription: {
      id: string; // ID of the revoked subscription
      type: string;
      // Potentially other fields
    };
  };
}

// Internal status messages seen in browser code - we won't receive these types directly
// export interface StatusMessage {
//   type: 'status';
//   status: 'opened' | 'closed' | 'errored' | 'incoming_error' | 'outgoing_error' | 'closing';
//   // ... other fields based on status
// }

export type IncomingMessage =
  | WelcomeMessage
  | ReconnectMessage
  | NotificationMessage
  | SubscribeResponseMessage
  | AuthenticateResponseMessage
  | SubscriptionRevocationMessage;

// --- Outgoing Message Interfaces ---

interface BaseOutgoingMessage {
  id: string;
  type: string;
}

export interface SubscribeRequest extends BaseOutgoingMessage {
  type: 'subscribe';
  subscribe: {
    id: string; // Unique ID for this specific subscription instance
    type: 'pubsub';
    pubsub: {
      topic: string;
    };
  };
}

export interface UnsubscribeRequest extends BaseOutgoingMessage {
  type: 'unsubscribe';
  unsubscribe: {
    id: string; // The ID of the subscription instance to remove
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

// --- EventEmitter Event Map ---
// Provides type safety for event listeners
export interface HermesClientEvents {
  /** Emitted when the WebSocket connection is open and the initial 'welcome' message is received. */
  ready: () => void;
  /** Emitted when the WebSocket connection is successfully opened (before 'welcome'). */
  // open: () => void; // Not strictly needed based on requirements, but could be added
  /** Emitted when the WebSocket connection is closed. */
  disconnect: (payload: {
    code: number;
    reason: Buffer;
    wasClean: boolean;
  }) => void;
  /** Emitted when a WebSocket error occurs or an internal client error happens. */
  error: (error: Error) => void;
  /** Emitted when the client is attempting to reconnect after a disconnect. */
  reconnecting: (payload: { attempt: number; delay: number }) => void;

  /** Emitted when a 'welcome' message is received from the server. */
  welcome: (message: WelcomeMessage) => void;
  /** Emitted when a 'reconnect' message is received from the server, instructing the client to reconnect. */
  reconnect: (message: ReconnectMessage) => void;
  /** Emitted when a 'notification' message (a subscribed event) is received. Alias for notification. */
  message: (message: NotificationMessage) => void;
  /** Emitted when a response to a 'subscribe' request is received. */
  subscribeResponse: (message: SubscribeResponseMessage) => void;
  /** Emitted when a response to an 'authenticate' request is received. */
  authenticateResponse: (message: AuthenticateResponseMessage) => void;
  /** Emitted when the server indicates a subscription has been revoked. */
  subscriptionRevocation: (message: SubscriptionRevocationMessage) => void;

  keepalive: (message: KeepaliveMessage) => void;

  /** Emitted for any message received that couldn't be parsed or identified. */
  unknownMessage: (
    rawMessage: Buffer | ArrayBuffer | Buffer[],
    parsed?: unknown
  ) => void;
}

// --- Utility Types ---
// Helper type for async-retry
export type RetryFunction = <T>(
  retrier: (bail: (e: Error) => void, attempt: number) => Promise<T>
) => Promise<T>;
