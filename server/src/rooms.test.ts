import { describe, expect, it } from 'vitest';
import { RoomRegistry, ROOM_CAPACITY } from './rooms';

describe('RoomRegistry', () => {
  it('第一个加入的人是 callee，房间里没有其他人', () => {
    const rooms = new RoomRegistry();
    const result = rooms.join('a', 'room1');

    expect(result).toEqual({ ok: true, role: 'callee', peerIds: [] });
  });

  it('第二个加入的人是 caller，并且能看到已有成员', () => {
    const rooms = new RoomRegistry();
    rooms.join('a', 'room1');
    const result = rooms.join('b', 'room1');

    expect(result).toEqual({ ok: true, role: 'caller', peerIds: ['a'] });
  });

  it('房间满员后拒绝加入', () => {
    const rooms = new RoomRegistry();
    for (let i = 0; i < ROOM_CAPACITY; i++) rooms.join(`client${i}`, 'room1');

    expect(rooms.join('extra', 'room1')).toEqual({ ok: false, reason: 'room-full' });
  });

  it('同一个连接不能重复加入', () => {
    const rooms = new RoomRegistry();
    rooms.join('a', 'room1');

    expect(rooms.join('a', 'room2')).toEqual({ ok: false, reason: 'already-joined' });
  });

  it.each(['', 'a'.repeat(65), 'room 1', 'room/1', '房间'])(
    '拒绝非法房间号 %j',
    (roomId) => {
      const rooms = new RoomRegistry();
      expect(rooms.join('a', roomId)).toEqual({ ok: false, reason: 'invalid-room-id' });
    },
  );

  it('不同房间互不影响', () => {
    const rooms = new RoomRegistry();
    rooms.join('a', 'room1');
    rooms.join('b', 'room2');

    expect(rooms.peersOf('a')).toEqual([]);
    expect(rooms.peersOf('b')).toEqual([]);
    expect(rooms.roomCount).toBe(2);
  });

  it('peersOf 返回同房间的其他人', () => {
    const rooms = new RoomRegistry();
    rooms.join('a', 'room1');
    rooms.join('b', 'room1');

    expect(rooms.peersOf('a')).toEqual(['b']);
    expect(rooms.peersOf('b')).toEqual(['a']);
  });

  it('离开后通知剩下的人，并腾出位置', () => {
    const rooms = new RoomRegistry();
    rooms.join('a', 'room1');
    rooms.join('b', 'room1');

    expect(rooms.leave('b')).toEqual({ roomId: 'room1', peerIds: ['a'] });
    expect(rooms.peersOf('a')).toEqual([]);
    expect(rooms.join('c', 'room1')).toEqual({ ok: true, role: 'caller', peerIds: ['a'] });
  });

  it('最后一个人离开后房间被回收', () => {
    const rooms = new RoomRegistry();
    rooms.join('a', 'room1');

    expect(rooms.leave('a')).toEqual({ roomId: 'room1', peerIds: [] });
    expect(rooms.roomCount).toBe(0);
    expect(rooms.isInRoom('a')).toBe(false);
  });

  it('离开后可以重新加入', () => {
    const rooms = new RoomRegistry();
    rooms.join('a', 'room1');
    rooms.leave('a');

    expect(rooms.join('a', 'room2')).toEqual({ ok: true, role: 'callee', peerIds: [] });
  });

  it('没加入过房间时 leave 返回 null', () => {
    const rooms = new RoomRegistry();
    expect(rooms.leave('ghost')).toBeNull();
  });
});
