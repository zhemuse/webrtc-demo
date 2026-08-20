/**
 * 文件传输的纯逻辑：切片和收片。
 * 这里不碰 RTCDataChannel，所以可以在 Node 里直接单元测试。
 */

/**
 * 16 KB。SCTP 单条消息虽然能更大，但 16 KB 是各浏览器都稳的保守值，
 * 也是 WebRTC 官方样例用的大小。
 */
export const CHUNK_SIZE = 16 * 1024;

export interface FileMeta {
  kind: 'file-meta';
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface ChunkRange {
  start: number;
  end: number;
}

/** 把 [0, totalSize) 切成左闭右开的区间，最后一片可能不满。 */
export function splitIntoRanges(totalSize: number, chunkSize = CHUNK_SIZE): ChunkRange[] {
  if (totalSize <= 0) return [];
  if (chunkSize <= 0) throw new RangeError('chunkSize 必须大于 0');

  const ranges: ChunkRange[] = [];
  for (let start = 0; start < totalSize; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize, totalSize) });
  }
  return ranges;
}

/**
 * 按到达顺序拼装一个文件。
 *
 * DataChannel 在默认（可靠有序）模式下保证顺序，所以不需要给分片编号 ——
 * 收到多少就是第多少片。
 */
export class FileReceiver {
  private readonly chunks: ArrayBuffer[] = [];
  private receivedBytes = 0;

  constructor(readonly meta: FileMeta) {
    if (meta.size < 0) throw new RangeError('文件大小不能为负');
  }

  push(chunk: ArrayBuffer): void {
    if (this.isComplete) {
      throw new Error(`文件 ${this.meta.name} 已经收完，不应再有分片`);
    }
    if (this.receivedBytes + chunk.byteLength > this.meta.size) {
      throw new Error(
        `文件 ${this.meta.name} 收到的数据超出声明大小 ` +
          `(${this.receivedBytes + chunk.byteLength} > ${this.meta.size})`,
      );
    }
    this.chunks.push(chunk);
    this.receivedBytes += chunk.byteLength;
  }

  get received(): number {
    return this.receivedBytes;
  }

  /** 0 到 1。大小为 0 的文件视为已完成。 */
  get progress(): number {
    if (this.meta.size === 0) return 1;
    return this.receivedBytes / this.meta.size;
  }

  get isComplete(): boolean {
    return this.receivedBytes >= this.meta.size;
  }

  toBlob(): Blob {
    if (!this.isComplete) {
      throw new Error(`文件 ${this.meta.name} 还没收完，不能生成 Blob`);
    }
    return new Blob(this.chunks, { type: this.meta.mime });
  }
}
