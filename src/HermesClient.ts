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
  OutgoingMessage,
  SubscribeRequest,
  UnsubscribeRequest,
  AuthenticateRequest,
  HermesClientEvents,
  RetryFunction,
} from './types';

interface TypedEventEmitter<
  Events extends { [K in keyof Events]: (...args: any[]) => void }
> extends EventEmitter {
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
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30000;
const DEFAULT_RECONNECT_BACKOFF_FACTOR = 2;
const KEEPALIVE_GRACE_PERIOD_SEC = 5;
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
  private reconnectUrl: string | null = null;

  private activeSubscriptions: Map<string, string> = new Map();
  private messageIdCache: Set<string> = new Set();
  private outgoingBuffer: OutgoingMessage[] = [];

  constructor(options: HermesClientOptions) {
    super();
    if (!options?.clientId) {
      throw new Error('Twitch Client ID (clientId) is required.');
    }
    this.options = {
      ...options,
      maxReconnectAttempts:
        options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      initialReconnectDelayMs:
        options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS,
      maxReconnectDelayMs:
        options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      reconnectBackoffFactor:
        options.reconnectBackoffFactor ?? DEFAULT_RECONNECT_BACKOFF_FACTOR,
    };

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
    this.reconnectAttempts = 0;
    this._doConnect().catch((err) => {
      this.emit(
        'error',
        new Error(`Initial connection failed: ${err.message}`)
      );
      this._transitionToDisconnected();
      // Optionally trigger automatic reconnect here if desired, or rely on user to call connect() again
      // this._scheduleReconnect();
    });
  }

  public disconnect(): void {
    if (this.connectionState === 'disconnected') {
      return;
    }
    this._transitionToDisconnected();
    this._closeWebSocket(1000, 'Client requested disconnect');
  }

  public get state(): ConnectionState {
    return this.connectionState;
  }

  public subscribe(topics: string | string[]): void {
    const topicsArray = Array.isArray(topics) ? topics : [topics];

    for (const topic of topicsArray) {
      if (!topic || typeof topic !== 'string') {
        this.emit('error', new Error(`Invalid topic provided: ${topic}`));
        continue;
      }

      if (this.activeSubscriptions.has(topic)) {
        continue;
      }

      const requestId = randomUUID();
      const subscriptionId = randomUUID();

      const message: SubscribeRequest = {
        id: requestId,
        type: 'subscribe',
        subscribe: {
          id: subscriptionId,
          type: 'pubsub',
          pubsub: { topic },
        },
      };

      this.activeSubscriptions.set(topic, subscriptionId);

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
        this.activeSubscriptions.delete(topic);
      }
    }
  }

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

      this._cleanupSocket();

      const url = this.reconnectUrl || this._buildUrl();
      this.reconnectUrl = null;

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
        this._scheduleReconnect();
        return reject(err);
      }

      this.ws.on('open', () => {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        this.connectionState = 'connected';
        this.reconnectAttempts = 0;
        this._flushBuffer();
        resolve();
      });

      this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        this._resetKeepaliveTimer();
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
        if (this.connectionState === 'connecting') {
          reject(error);
        }
        this.emit('error', error);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const wasClean = code === 1000;
        const reasonString = reason.toString();
        if (this.connectionState === 'connecting') {
          reject(
            new Error(
              `Connection closed during initial connect: ${code} - ${reasonString}`
            )
          );
        }
        // const previouslyConnected =
        //   this.connectionState === 'connected' ||
        //   this.connectionState === 'reconnecting';
        this._cleanupSocket();

        if (this.connectionState !== 'disconnected') {
          this.connectionState = 'reconnecting';
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

    // const retryOptions = {
    //   retries: 1,
    //   factor: this.options.reconnectBackoffFactor,
    //   minTimeout: this.options.initialReconnectDelayMs,
    //   maxTimeout: this.options.maxReconnectDelayMs,
    //   randomize: true,
    //   onRetry: (e: Error, attempt: number) => {
    //     const delay = Math.min(
    //       this.options.initialReconnectDelayMs *
    //         Math.pow(
    //           this.options.reconnectBackoffFactor,
    //           this.reconnectAttempts - 1
    //         ),
    //       this.options.maxReconnectDelayMs
    //     );
    //     const jitterDelay = Math.round(delay * (0.9 + Math.random() * 0.2));
    //     this.emit('reconnecting', {
    //       attempt: this.reconnectAttempts,
    //       delay: jitterDelay,
    //     });
    //   },
    // };

    const retryExecutor = retry as RetryFunction;

    retryExecutor(async (bail) => {
      if (this.connectionState === 'disconnected') {
        bail(new Error('Client disconnected manually.'));
        return;
      }
      try {
        await this._doConnect();
      } catch (error) {
        throw error;
      }
    }).catch(() => {
      if (this.connectionState !== 'disconnected') {
        this.emit(
          'error',
          new Error('Reconnect retry loop exited unexpectedly.')
        );
        this.disconnect();
      }
    });
  }

  private _buildUrl(): string {
    const params = new URLSearchParams({ clientId: this.options.clientId });
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
      this.ws.removeAllListeners();
      if (
        this.ws.readyState !== WebSocket.CLOSED &&
        this.ws.readyState !== WebSocket.CLOSING
      ) {
        try {
          this.ws.close(1001, 'Client cleaning up');
        } catch (e) {
          this.emit(
            'error',
            new Error(`Error closing WebSocket: ${(e as Error).message}`)
          );
        }
      }
      this.ws = null;
    }
    this.welcomeMessage = null;
    this.lastMessageId = null;
    this.outgoingBuffer = [];
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
    this.ws = null;
  }

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
      );
      return;
    }

    if (this.messageIdCache.has(message.id)) {
      return;
    }
    this._addMessageIdToCache(message.id);

    this.lastMessageId = message.id;

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
    this.reconnectUrl = message.welcome.recoveryUrl;
    this.emit('welcome', message);
    this._resetKeepaliveTimer();

    if (this.options.authToken) {
      this._attemptAuthentication();
    }

    this._flushBuffer();

    this._resubscribeActiveTopics();

    this.emit('ready');
  }

  private _handleReconnect(message: ReconnectMessage): void {
    this.emit('reconnect', message);
    this.reconnectUrl = message.reconnect.url;
    this._closeWebSocket(1012, 'Server requested reconnect');
  }

  private _handleSubscribeResponse(message: SubscribeResponseMessage): void {
    this.emit('subscribeResponse', message);
    const subInfo = message.subscribeResponse.subscription;

    if (message.subscribeResponse.result !== 'ok' && subInfo?.id) {
      const activeSubId = this.activeSubscriptions.get(subInfo?.id);
      if (activeSubId === subInfo?.id) {
        this.activeSubscriptions.delete(subInfo?.id);
      }
    }
  }

  private _resubscribeActiveTopics(): void {
    const topicsToResubscribe = Array.from(this.activeSubscriptions.keys());
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
        }
      }, timeoutMs);
    }
  }

  private _addMessageIdToCache(id: string): void {
    if (this.messageIdCache.size >= MESSAGE_ID_CACHE_SIZE) {
      const oldestId = this.messageIdCache.values().next().value;
      if (oldestId) {
        this.messageIdCache.delete(oldestId);
      }
    }
    this.messageIdCache.add(id);
  }

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
    this._sendMessage(message, true);
  }

  private _sendMessage(message: OutgoingMessage, prioritize = false): void {
    if (
      this.connectionState !== 'connected' ||
      !this.welcomeMessage ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      if (prioritize) {
        this.outgoingBuffer.unshift(message);
      } else {
        this.outgoingBuffer.push(message);
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
          this._closeWebSocket(1011, `Send error: ${error.message}`);
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
    this.outgoingBuffer = [];
    for (const msg of buffer) {
      this._sendMessage(msg);
    }
  }
}
