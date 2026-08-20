import type { ClientMessage, ServerMessage } from '../../shared/signaling';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SignalingHandlers {
  onMessage: (message: ServerMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * WebSocket 信令客户端。
 *
 * 负责三件事：JSON 编解码、指数退避重连、断线期间把待发消息排队。
 * 它不理解 WebRTC —— offer/answer/candidate 对它来说只是要转发的字节。
 */
export class Signaling {
  private socket: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: number | null = null;
  private closedByUser = false;
  /** 断线期间要发的消息先攒着，连上之后按序补发。 */
  private outbox: ClientMessage[] = [];

  constructor(
    private readonly url: string,
    private readonly handlers: SignalingHandlers,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.handlers.onStatusChange(this.retryCount === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryCount = 0;
      this.handlers.onStatusChange('open');
      const pending = this.outbox;
      this.outbox = [];
      for (const message of pending) this.send(message);
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        console.warn('[signaling] 收到无法解析的消息', event.data);
        return;
      }
      this.handlers.onMessage(message);
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.closedByUser) {
        this.handlers.onStatusChange('closed');
        return;
      }
      this.scheduleReconnect();
    });

    // error 之后浏览器一定会再触发 close，重连逻辑统一放在 close 里，这里只记日志。
    socket.addEventListener('error', () => {
      console.warn('[signaling] 连接出错，等待重连');
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** this.retryCount, MAX_RETRY_DELAY_MS);
    this.retryCount += 1;
    this.handlers.onStatusChange('reconnecting');
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.outbox.push(message);
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.outbox = [];
    this.socket?.close();
    this.socket = null;
    this.handlers.onStatusChange('closed');
  }
}

/**
 * 开发模式下 vite 在 5173、信令服务器在 8080，是两个端口；
 * 生产构建由信令服务器自己托管，同源。
 */
export function defaultSignalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV ? `${location.hostname}:8080` : location.host;
  return `${protocol}//${host}/ws`;
}
