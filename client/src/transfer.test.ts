import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, FileReceiver, splitIntoRanges, type FileMeta } from './transfer';

function meta(size: number, overrides: Partial<FileMeta> = {}): FileMeta {
  return { kind: 'file-meta', id: 'f1', name: 'demo.bin', size, mime: 'application/octet-stream', ...overrides };
}

function bytes(n: number): ArrayBuffer {
  return new Uint8Array(n).buffer;
}

describe('splitIntoRanges', () => {
  it('整除时每片一样大', () => {
    expect(splitIntoRanges(30, 10)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ]);
  });

  it('除不尽时最后一片是余数', () => {
    expect(splitIntoRanges(25, 10)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 25 },
    ]);
  });

  it('比一片还小的文件只切出一片', () => {
    expect(splitIntoRanges(5, 10)).toEqual([{ start: 0, end: 5 }]);
  });

  it('空文件切不出任何分片', () => {
    expect(splitIntoRanges(0)).toEqual([]);
  });

  it('所有区间首尾相接且覆盖整个文件', () => {
    const total = CHUNK_SIZE * 3 + 123;
    const ranges = splitIntoRanges(total);

    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(total);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end);
    }
  });

  it('chunkSize 非法时报错', () => {
    expect(() => splitIntoRanges(10, 0)).toThrow(RangeError);
  });
});

describe('FileReceiver', () => {
  it('按分片累计进度', () => {
    const receiver = new FileReceiver(meta(100));

    receiver.push(bytes(40));
    expect(receiver.progress).toBeCloseTo(0.4);
    expect(receiver.isComplete).toBe(false);

    receiver.push(bytes(60));
    expect(receiver.progress).toBe(1);
    expect(receiver.isComplete).toBe(true);
  });

  it('收完后能拼回原始字节数和 MIME 类型', async () => {
    const receiver = new FileReceiver(meta(6, { mime: 'text/plain' }));
    receiver.push(new Uint8Array([104, 101, 108]).buffer);
    receiver.push(new Uint8Array([108, 111, 33]).buffer);

    const blob = receiver.toBlob();
    expect(blob.size).toBe(6);
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('hello!');
  });

  it('数据超出声明大小时报错，而不是悄悄接受', () => {
    const receiver = new FileReceiver(meta(10));
    receiver.push(bytes(8));

    expect(() => receiver.push(bytes(5))).toThrow(/超出声明大小/);
  });

  it('收完之后再来分片会报错', () => {
    const receiver = new FileReceiver(meta(4));
    receiver.push(bytes(4));

    expect(() => receiver.push(bytes(1))).toThrow(/已经收完/);
  });

  it('没收完就取 Blob 会报错', () => {
    const receiver = new FileReceiver(meta(10));
    receiver.push(bytes(3));

    expect(() => receiver.toBlob()).toThrow(/还没收完/);
  });

  it('空文件一开始就是完成状态', () => {
    const receiver = new FileReceiver(meta(0));

    expect(receiver.isComplete).toBe(true);
    expect(receiver.progress).toBe(1);
    expect(receiver.toBlob().size).toBe(0);
  });
});
