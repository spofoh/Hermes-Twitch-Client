import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import retry from 'async-retry';

import type {
  HermesClientOptions,
  ConnectionState,
  KeepaliveMessage,
  WelcomeMessage,
  ReconnectMessage,
  NotificationMessage,
  SubscribeResponseMessage,
  AuthenticateResponseMessage,
  SubscriptionRevocationMessage,
  OutgoingMessage,
  SubscribeRequest,
  UnsubscribeRequest,
  AuthenticateRequest,
  HermesClientEvents, // Use this for type safety
  RetryFunction,
} from './types';

// Type assertion for EventEmitter to use our specific event map
interface TypedEventEmitter<
  Events extends { [K in keyof Events]: (...args: any[]) => void }
> extends EventEmitter {
  // Overloads to maintain compatibility with base EventEmitter
  on<E extends keyof Events>(event: E, listener: Events[E]): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;

  once<E extends keyof Events>(event: E, listener: Events[E]): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;

  emit<E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ): boolean;
  emit(event: string | symbol, ...args: any[]): boolean;

  off<E extends keyof Events>(event: E, listener: Events[E]): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;

  removeAllListeners<E extends keyof Events>(event?: E): this;
  removeAllListeners(event?: string | symbol): this;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = Infinity;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30000; // 30 seconds
const DEFAULT_RECONNECT_BACKOFF_FACTOR = 2;
const KEEPALIVE_GRACE_PERIOD_SEC = 5; // Grace period beyond server's keepalive timeout
const MESSAGE_ID_CACHE_SIZE = 1000;

export class HermesClient extends (EventEmitter as new () => TypedEventEmitter<HermesClientEvents>) {
  private options: Required<
    Omit<HermesClientOptions, 'wsOptions' | 'authToken'>
  > &
    Pick<HermesClientOptions, 'wsOptions' | 'authToken'>;
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private lastMessageId: string | null = null;
  private welcomeMessage: WelcomeMessage | null = null;
  private reconnectUrl: string | null = null; // Overrides default URL if provided by welcome/reconnect

  // Track active subscriptions: topic -> subscriptionId
  private activeSubscriptions: Map<string, string> = new Map();
  // Simple message ID cache to prevent duplicates
  private messageIdCache: Set<string> = new Set();
  // Buffer for messages sent before 'welcome'
  private outgoingBuffer: OutgoingMessage[] = [];

  constructor(options: HermesClientOptions) {
    super();
    if (!options?.clientId) {
      throw new Error('Twitch Client ID (clientId) is required.');
    }
    this.options = {
      ...options, // Includes clientId, authToken?, wsOptions?
      maxReconnectAttempts:
        options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      initialReconnectDelayMs:
        options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS,
      maxReconnectDelayMs:
        options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      reconnectBackoffFactor:
        options.reconnectBackoffFactor ?? DEFAULT_RECONNECT_BACKOFF_FACTOR,
    };

    // Increase max listeners slightly for potentially many subscriptions + internal handlers
    this.setMaxListeners(this.getMaxListeners() + 10);
  }

  public connect(): void {
    if (this.connectionState !== 'disconnected') {
      this.emit(
        'error',
        new Error(`Cannot connect when state is ${this.connectionState}`)
      );
      return;
    }
    this.connectionState = 'connecting';
    this.reconnectAttempts = 0; // Reset attempts on manual connect
    this._doConnect().catch((err) => {
      // Initial connection failure
      this.emit(
        'error',
        new Error(`Initial connection failed: ${err.message}`)
      );
      this._transitionToDisconnected(); // Ensure state is correct
      // Optionally trigger automatic reconnect here if desired, or rely on user to call connect() again
      // this._scheduleReconnect();
    });
  }

  public disconnect(): void {
    if (this.connectionState === 'disconnected') {
      return;
    }
    this._transitionToDisconnected();
    this._closeWebSocket(1000, 'Client requested disconnect'); // 1000 = Normal closure
  }

  public get state(): ConnectionState {
    return this.connectionState;
  }

  // --- Subscription Management ---

  public subscribe(topics: string | string[]): void {
    const topicsArray = Array.isArray(topics) ? topics : [topics];

    for (const topic of topicsArray) {
      if (!topic || typeof topic !== 'string') {
        this.emit('error', new Error(`Invalid topic provided: ${topic}`));
        continue;
      }

      // Avoid duplicate active/pending subscriptions (simple check)
      if (this.activeSubscriptions.has(topic)) {
        // console.warn(`Already subscribed to topic: ${topic}`); // Optional warning
        continue;
      }

      const requestId = randomUUID();
      const subscriptionId = randomUUID(); // Pre-generate, associate on success

      const message: SubscribeRequest = {
        id: requestId,
        type: 'subscribe',
        subscribe: {
          id: subscriptionId,
          type: 'pubsub',
          pubsub: { topic },
        },
      };

      // Temporary store potential mapping, confirmed in response handler
      // In this simple fire-and-forget model, we might add optimistically
      // or wait for the response. Waiting is safer. Let's just send.
      this._sendMessage(message);
    }
  }

  public unsubscribe(topics: string | string[]): void {
    const topicsArray = Array.isArray(topics) ? topics : [topics];

    for (const topic of topicsArray) {
      const subscriptionId = this.activeSubscriptions.get(topic);
      if (subscriptionId) {
        const message: UnsubscribeRequest = {
          id: randomUUID(),
          type: 'unsubscribe',
          unsubscribe: { id: subscriptionId },
        };
        this._sendMessage(message);
        // Remove optimistically, or wait for confirmation? Let's remove optimistically.
        this.activeSubscriptions.delete(topic);
      } else {
        // console.warn(`Not subscribed to topic, cannot unsubscribe: ${topic}`); // Optional warning
      }
    }
  }

  // --- Private Connection Logic ---

  private async _doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (
        this.ws &&
        (this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING)
      ) {
        this.emit(
          'error',
          new Error(
            `WebSocket already connecting or open (state: ${this.ws.readyState})`
          )
        );
        return reject(new Error('Already connected or connecting'));
      }

      this._cleanupSocket(); // Ensure any old socket is fully gone

      const url = this.reconnectUrl || this._buildUrl();
      this.reconnectUrl = null; // Consume the reconnect URL

      try {
        this.ws = new WebSocket(url, this.options.wsOptions);
      } catch (err) {
        this.emit(
          'error',
          new Error(
            `Failed to create WebSocket: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
        this._scheduleReconnect(); // Attempt reconnect after creation failure
        return reject(err);
      }

      this.ws.on('open', () => {
        if (this.ws?.readyState !== WebSocket.OPEN) return; // Guard against stale events
        this.connectionState = 'connected'; // Tentative state, confirmed by 'welcome'
        this.reconnectAttempts = 0; // Reset on successful open
        // Don't emit 'ready' yet, wait for 'welcome'
        // Flush buffer now that connection is open (before welcome/auth potentially)
        this._flushBuffer();
        resolve(); // Promise resolves on open
      });

      this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        this._resetKeepaliveTimer(); // Activity detected
        try {
          const parsed = JSON.parse(data.toString());
          this._handleIncomingMessage(parsed);
        } catch (e) {
          this.emit(
            'error',
            new Error(
              `Failed to parse incoming message: ${(e as Error).message}`
            )
          );
          this.emit('unknownMessage', data);
        }
      });

      this.ws.on('error', (error: Error) => {
        // If the promise hasn't resolved yet (initial connection failed), reject it.
        if (this.connectionState === 'connecting') {
          reject(error);
        }
        this.emit('error', error);
        // WS errors often precede 'close'. The 'close' handler handles reconnect logic.
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const wasClean = code === 1000;
        const reasonString = reason.toString();
        // If the promise hasn't resolved yet (initial connection failed), reject it.
        if (this.connectionState === 'connecting') {
          reject(
            new Error(
              `Connection closed during initial connect: ${code} - ${reasonString}`
            )
          );
        }
        const previouslyConnected =
          this.connectionState === 'connected' ||
          this.connectionState === 'reconnecting';
        this._cleanupSocket(); // Clears timers, WS instance

        // Only emit disconnect and attempt reconnect if we weren't already manually disconnected
        if (this.connectionState !== 'disconnected') {
          this.connectionState = 'reconnecting'; // Assume reconnect unless told otherwise
          this.emit('disconnect', { code, reason, wasClean });
          this._scheduleReconnect();
        }
      });
    });
  }

  private _scheduleReconnect(): void {
    if (
      this.connectionState === 'disconnected' ||
      this.connectionState === 'connecting'
    ) {
      // Don't schedule if manually disconnected or already trying initial connect
      return;
    }
    this.connectionState = 'reconnecting';
    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.options.maxReconnectAttempts) {
      this.emit(
        'error',
        new Error('Maximum reconnect attempts reached. Disconnecting.')
      );
      this.disconnect();
      return;
    }

    const retryOptions = {
      retries: 1, // We manage retries externally, this just handles the delay
      factor: this.options.reconnectBackoffFactor,
      minTimeout: this.options.initialReconnectDelayMs,
      maxTimeout: this.options.maxReconnectDelayMs,
      randomize: true,
      onRetry: (e: Error, attempt: number) => {
        // This 'attempt' is from async-retry (always 2 here), use our counter
        const delay = Math.min(
          this.options.initialReconnectDelayMs *
            Math.pow(
              this.options.reconnectBackoffFactor,
              this.reconnectAttempts - 1
            ),
          this.options.maxReconnectDelayMs
        );
        // Add jitter approx +/- 10%
        const jitterDelay = Math.round(delay * (0.9 + Math.random() * 0.2));
        this.emit('reconnecting', {
          attempt: this.reconnectAttempts,
          delay: jitterDelay,
        });
      },
    };

    // Cast retry to the helper type to avoid TS issues with async-retry types
    const retryExecutor = retry as RetryFunction;

    retryExecutor(async (bail) => {
      if (this.connectionState === 'disconnected') {
        bail(new Error('Client disconnected manually.')); // Stop retrying
        return;
      }
      try {
        await this._doConnect();
        // If _doConnect succeeds, the retry loop is exited.
      } catch (error) {
        // _doConnect failed, retry will schedule the next attempt
        throw error; // Throw error to trigger retry
      }
    }).catch(() => {
      // This catch is primarily for the 'bail' case or if retry itself fails unexpectedly
      if (this.connectionState !== 'disconnected') {
        // If we bailed due to max attempts or another reason, but aren't disconnected, log error.
        this.emit(
          'error',
          new Error('Reconnect retry loop exited unexpectedly.')
        );
        this.disconnect(); // Go to fully disconnected state
      }
    });
  }

  private _buildUrl(): string {
    const params = new URLSearchParams({ clientId: this.options.clientId });
    // Append lastMessageId ONLY if we have a recoveryUrl (handled in _doConnect)
    // Do not append it to the base URL.
    return `wss://hermes.twitch.tv/v1?${params.toString()}`;
  }

  private _transitionToDisconnected(): void {
    this.connectionState = 'disconnected';
    this._cleanupSocket();
  }

  private _cleanupSocket(): void {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ws) {
      // Remove all listeners to prevent memory leaks and processing stale events
      this.ws.removeAllListeners();
      // Only close if not already closed/closing
      if (
        this.ws.readyState !== WebSocket.CLOSED &&
        this.ws.readyState !== WebSocket.CLOSING
      ) {
        try {
          this.ws.close(1001, 'Client cleaning up'); // 1001 = Going Away
        } catch (e) {
          /* Ignore closure errors during cleanup */
        }
      }
      this.ws = null;
    }
    this.welcomeMessage = null;
    this.lastMessageId = null;
    // Clear buffer on disconnect? Or keep for next connection? Let's clear.
    this.outgoingBuffer = [];
    // Optionally clear cache on disconnect? Browser code didn't seem to clear everything.
    // this.messageIdCache.clear();
    // this.activeSubscriptions.clear(); // Keep subs, try to resubscribe on reconnect implicitly? Or require user? Assume implicit for now.
  }

  private _closeWebSocket(code?: number, reason?: string): void {
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch (e) {
        this.emit(
          'error',
          new Error(`Error closing WebSocket: ${(e as Error).message}`)
        );
      }
    }
    this.ws = null; // Ensure it's nulled even if close throws
  }

  // --- Private Message Handling ---

  private _handleIncomingMessage(message: any): void {
    if (
      !message ||
      typeof message !== 'object' ||
      !message.type ||
      !message.id
    ) {
      this.emit(
        'error',
        new Error(
          `Received invalid message structure: ${JSON.stringify(message)}`
        )
      );
      this.emit(
        'unknownMessage',
        Buffer.from(JSON.stringify(message)),
        message
      ); // Emit raw and parsed if possible
      return;
    }

    // Deduplication
    if (this.messageIdCache.has(message.id)) {
      // console.warn(`Received duplicate message ID: ${message.id}`); // Optional warning
      return;
    }
    this._addMessageIdToCache(message.id);

    // Store last ID for potential recovery
    this.lastMessageId = message.id;

    // Route based on type
    switch (message.type) {
      case 'welcome':
        this._handleWelcome(message as WelcomeMessage);
        break;
      case 'reconnect':
        this._handleReconnect(message as ReconnectMessage);
        break;
      case 'notification': {
        let parsedPubsub = message;
        if (message.notification.pubsub) {
          try {
            parsedPubsub = {
              ...message,
              ...message.notification,
              pubsub: JSON.parse(message.notification.pubsub),
            };
          } catch (e) {
            this.emit(
              'error',
              new Error(
                `Failed to parse pubsub payload: ${(e as Error).message}`
              )
            );
          }
        }
        this.emit('message', parsedPubsub as NotificationMessage);
        break;
      }
      case 'subscribeResponse':
        this._handleSubscribeResponse(message as SubscribeResponseMessage);
        break;
      case 'authenticateResponse':
        this.emit(
          'authenticateResponse',
          message as AuthenticateResponseMessage
        );
        // Could update internal auth state here if needed
        break;
      case 'subscriptionRevocation':
        this._handleSubscriptionRevocation(
          message as SubscriptionRevocationMessage
        );
        break;
      case 'keepalive':
        this.emit('keepalive', message as KeepaliveMessage);
        break;
      default:
        this.emit(
          'error',
          new Error(`Received unknown message type: ${message.type}`)
        );
        this.emit(
          'unknownMessage',
          Buffer.from(JSON.stringify(message)),
          message
        );
    }
  }

  private _handleWelcome(message: WelcomeMessage): void {
    this.welcomeMessage = message;
    this.reconnectUrl = message.welcome.recoveryUrl; // Store for future reconnects
    this.emit('welcome', message);
    this._resetKeepaliveTimer(); // Start keepalive based on server interval

    // If authenticated, send auth message now
    if (this.options.authToken) {
      this._attemptAuthentication();
    }

    // Flush any buffered messages (e.g., subscriptions sent before welcome)
    this._flushBuffer();

    // Re-subscribe to topics we think we should be subscribed to
    this._resubscribeActiveTopics();

    // Connection is now fully ready
    this.emit('ready');
  }

  private _handleReconnect(message: ReconnectMessage): void {
    this.emit('reconnect', message);
    this.reconnectUrl = message.reconnect.url; // Use this specific URL for the next immediate attempt
    this._closeWebSocket(1012, 'Server requested reconnect'); // 1012 = Service Restart
    // The 'close' event handler will trigger _scheduleReconnect, which will use the reconnectUrl
  }

  private _handleSubscribeResponse(message: SubscribeResponseMessage): void {
    this.emit('subscribeResponse', message);
    const subInfo = message.subscribeResponse.subscription;
    const topic = subInfo?.pubsub?.topic;

    if (message.subscribeResponse.result === 'ok' && subInfo?.id && topic) {
      // Success! Store the mapping
      this.activeSubscriptions.set(topic, subInfo.id);
    } else if (topic) {
      // Failed - ensure it's not in our active list
      const activeSubId = this.activeSubscriptions.get(topic);
      if (activeSubId === subInfo?.id) {
        // Check if the failed ID matches our stored one
        this.activeSubscriptions.delete(topic);
      }
      // Could emit a specific subscription error event
      // this.emit('subscriptionError', { topic, error: message.subscribeResponse });
    }
  }

  private _handleSubscriptionRevocation(
    message: SubscriptionRevocationMessage
  ): void {
    this.emit('subscriptionRevocation', message);
    const revokedSubId = message.subscriptionRevocation.subscription.id;
    // Find the topic associated with this ID and remove it
    for (const [topic, subId] of this.activeSubscriptions.entries()) {
      if (subId === revokedSubId) {
        this.activeSubscriptions.delete(topic);
        // Could emit specific notification: this.emit('subscriptionEnded', { topic, reason: message.subscriptionRevocation.reason });
        break; // Assuming IDs are unique
      }
    }
  }

  private _resubscribeActiveTopics(): void {
    const topicsToResubscribe = Array.from(this.activeSubscriptions.keys());
    // Clear current knowledge, we'll repopulate on success responses
    this.activeSubscriptions.clear();
    if (topicsToResubscribe.length > 0) {
      this.subscribe(topicsToResubscribe);
    }
  }

  private _resetKeepaliveTimer(): void {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
    }
    if (this.welcomeMessage && this.connectionState === 'connected') {
      const intervalSeconds = this.welcomeMessage.welcome.keepaliveSec;
      const timeoutMs = (intervalSeconds + KEEPALIVE_GRACE_PERIOD_SEC) * 1000;

      this.keepaliveTimer = setTimeout(() => {
        if (this.connectionState === 'connected') {
          this.emit(
            'error',
            new Error(`Keepalive timeout (${timeoutMs}ms). Reconnecting.`)
          );
          this._closeWebSocket(1001, 'Keepalive timeout');
          // Close handler will trigger reconnect
        }
      }, timeoutMs);
    }
  }

  private _addMessageIdToCache(id: string): void {
    if (this.messageIdCache.size >= MESSAGE_ID_CACHE_SIZE) {
      // Evict the oldest (approximated by iteration order)
      const oldestId = this.messageIdCache.values().next().value;
      if (oldestId) {
        this.messageIdCache.delete(oldestId);
      }
    }
    this.messageIdCache.add(id);
  }

  // --- Private Sending Logic ---

  private _attemptAuthentication(): void {
    if (!this.options.authToken) {
      this.emit(
        'error',
        new Error('Cannot authenticate without an auth token.')
      );
      return;
    }
    const message: AuthenticateRequest = {
      id: randomUUID(),
      type: 'authenticate',
      authenticate: { token: this.options.authToken },
    };
    this._sendMessage(message, true); // Prioritize auth message
  }

  private _sendMessage(message: OutgoingMessage, prioritize = false): void {
    // Buffer if not ready (connected + welcome received)
    if (
      this.connectionState !== 'connected' ||
      !this.welcomeMessage ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      if (prioritize) {
        this.outgoingBuffer.unshift(message); // Add to front
      } else {
        this.outgoingBuffer.push(message); // Add to back
      }
      return;
    }

    try {
      const jsonPayload = JSON.stringify(message);
      this.ws.send(jsonPayload, (error) => {
        if (error) {
          this.emit(
            'error',
            new Error(`Failed to send message: ${error.message}`)
          );
          // Should we re-buffer? Or assume connection is dead? Assume dead.
          this._closeWebSocket(1011, `Send error: ${error.message}`); // 1011 = Internal Error
        }
      });
    } catch (e) {
      this.emit(
        'error',
        new Error(
          `Failed to stringify outgoing message: ${(e as Error).message}`
        )
      );
    }
  }

  private _flushBuffer(): void {
    const buffer = this.outgoingBuffer;
    this.outgoingBuffer = []; // Clear buffer immediately
    for (const msg of buffer) {
      this._sendMessage(msg); // Resend through the proper channel (will send if ready, re-buffer if not)
    }
  }
}
