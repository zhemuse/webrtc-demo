import { CHUNK_SIZE, FileReceiver, splitIntoRanges, type FileMeta } from './transfer';

/** 缓冲区超过 1 MB 就暂停发送，等 bufferedamountlow 再继续，避免撑爆 SCTP 发送队列。 */
const BUFFER_HIGH_WATER_MARK = 1024 * 1024;
const BUFFER_LOW_WATER_MARK = 256 * 1024;

interface TextPayload {
  kind: 'text';
  text: string;
}

type ControlMessage = TextPayload | FileMeta;

export interface ChatHandlers {
  onOpen: () => void;
  onClose: () => void;
  onText: (text: string) => void;
  onSendProgress: (meta: FileMeta, progress: number) => void;
  onReceiveProgress: (meta: FileMeta, progress: number) => void;
  onFileComplete: (meta: FileMeta, blob: Blob) => void;
  onError: (message: string) => void;
}

/**
 * DataChannel 上的应用层协议。
 *
 * 字符串消息 = JSON 控制帧（文字消息、文件元信息），
 * 二进制消息 = 当前文件的分片。因为 DataChannel 默认可靠有序，
 * 「元信息之后紧跟着的二进制就是这个文件的内容」这个假设是成立的。
 */
export class ChatChannel {
  private incoming: FileReceiver | null = null;
  private sending = false;

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly handlers: ChatHandlers,
  ) {
    this.channel.binaryType = 'arraybuffer';
    this.channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER_MARK;

    this.channel.addEventListener('open', () => this.handlers.onOpen());
    this.channel.addEventListener('close', () => this.handlers.onClose());
    this.channel.addEventListener('message', (event) => this.handleMessage(event.data));
  }

  get isOpen(): boolean {
    return this.channel.readyState === 'open';
  }

  private handleMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.handleControl(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.handleChunk(data);
      return;
    }
    console.warn('[chat] 收到未知类型的数据', data);
  }

  private handleControl(raw: string): void {
    let message: ControlMessage;
    try {
      message = JSON.parse(raw) as ControlMessage;
    } catch {
      this.handlers.onError('收到无法解析的控制消息');
      return;
    }

    if (message.kind === 'text') {
      this.handlers.onText(message.text);
      return;
    }

    if (message.kind === 'file-meta') {
      this.incoming = new FileReceiver(message);
      this.handlers.onReceiveProgress(message, this.incoming.progress);
      if (this.incoming.isComplete) this.finishIncoming();
      return;
    }

    this.handlers.onError('收到未知的控制消息');
  }

  private handleChunk(chunk: ArrayBuffer): void {
    if (this.incoming === null) {
      this.handlers.onError('收到了没有元信息的文件分片，已丢弃');
      return;
    }
    try {
      this.incoming.push(chunk);
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error.message : String(error));
      this.incoming = null;
      return;
    }

    this.handlers.onReceiveProgress(this.incoming.meta, this.incoming.progress);
    if (this.incoming.isComplete) this.finishIncoming();
  }

  private finishIncoming(): void {
    const receiver = this.incoming;
    if (receiver === null) return;
    this.incoming = null;
    this.handlers.onFileComplete(receiver.meta, receiver.toBlob());
  }

  sendText(text: string): void {
    if (!this.isOpen) throw new Error('数据通道还没打开');
    const payload: TextPayload = { kind: 'text', text };
    this.channel.send(JSON.stringify(payload));
  }

  /** 一次只发一个文件；发送过程中再调用会抛错。 */
  async sendFile(file: File): Promise<void> {
    if (!this.isOpen) throw new Error('数据通道还没打开');
    if (this.sending) throw new Error('上一个文件还在发送中');

    this.sending = true;
    try {
      const meta: FileMeta = {
        kind: 'file-meta',
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      };
      this.channel.send(JSON.stringify(meta));
      this.handlers.onSendProgress(meta, 0);

      for (const range of splitIntoRanges(file.size, CHUNK_SIZE)) {
        await this.waitForDrain();
        if (!this.isOpen) throw new Error('发送过程中数据通道被关闭');

        const chunk = await file.slice(range.start, range.end).arrayBuffer();
        this.channel.send(chunk);
        this.handlers.onSendProgress(meta, file.size === 0 ? 1 : range.end / file.size);
      }

      this.handlers.onSendProgress(meta, 1);
    } finally {
      this.sending = false;
    }
  }

  /** 背压：缓冲区太满就等它降下来，否则大文件会把内存打爆。 */
  private waitForDrain(): Promise<void> {
    if (this.channel.bufferedAmount < BUFFER_HIGH_WATER_MARK) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const onLow = (): void => {
        this.channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      this.channel.addEventListener('bufferedamountlow', onLow);
    });
  }

  close(): void {
    this.channel.close();
  }
}
