import type { JoinFailureReason, Role } from '../../shared/signaling';

/** 一个房间最多两个人 —— 这是 1对1 demo，不做多人 mesh。 */
export const ROOM_CAPACITY = 2;

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type JoinResult =
  | { ok: true; role: Role; peerIds: string[] }
  | { ok: false; reason: JoinFailureReason };

export interface LeaveResult {
  roomId: string;
  /** 离开后房间里剩下的人 */
  peerIds: string[];
}

/**
 * 房间成员管理。纯内存、纯逻辑，不认识 WebSocket，
 * 这样才能脱离网络单独测试。
 */
export class RoomRegistry {
  private readonly members = new Map<string, Set<string>>();
  private readonly roomOfClient = new Map<string, string>();

  join(clientId: string, roomId: string): JoinResult {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      return { ok: false, reason: 'invalid-room-id' };
    }
    if (this.roomOfClient.has(clientId)) {
      return { ok: false, reason: 'already-joined' };
    }

    const occupants = this.members.get(roomId) ?? new Set<string>();
    if (occupants.size >= ROOM_CAPACITY) {
      return { ok: false, reason: 'room-full' };
    }

    const peerIds = [...occupants];
    occupants.add(clientId);
    this.members.set(roomId, occupants);
    this.roomOfClient.set(clientId, roomId);

    // 房间里已经有人 → 后进来的当发起方，由它创建 offer 和 DataChannel。
    // 先到的人只要等 offer 就行，省掉一轮「通知你去发起」的往返。
    return { ok: true, role: peerIds.length > 0 ? 'caller' : 'callee', peerIds };
  }

  leave(clientId: string): LeaveResult | null {
    const roomId = this.roomOfClient.get(clientId);
    if (roomId === undefined) return null;

    this.roomOfClient.delete(clientId);
    const occupants = this.members.get(roomId);
    if (occupants === undefined) return { roomId, peerIds: [] };

    occupants.delete(clientId);
    if (occupants.size === 0) this.members.delete(roomId);

    return { roomId, peerIds: [...occupants] };
  }

  /** 同房间的其他人；不在任何房间时返回空数组。 */
  peersOf(clientId: string): string[] {
    const roomId = this.roomOfClient.get(clientId);
    if (roomId === undefined) return [];
    const occupants = this.members.get(roomId);
    if (occupants === undefined) return [];
    return [...occupants].filter((id) => id !== clientId);
  }

  isInRoom(clientId: string): boolean {
    return this.roomOfClient.has(clientId);
  }

  get roomCount(): number {
    return this.members.size;
  }
}
