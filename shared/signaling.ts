/**
 * 前后端共享的信令消息定义。
 *
 * 这个文件只包含类型，两端都用 `import type` 引入，编译后完全消失，
 * 所以它既不需要被打包也不会引入任何运行时依赖。
 */

/** caller 负责创建 offer 和 DataChannel；callee 等待 offer。 */
export type Role = 'caller' | 'callee';

/**
 * DOM 的 `RTCIceCandidateInit` 在 Node 端不可用，这里定义一个结构兼容的最小版本，
 * 浏览器侧可以直接把它当成 `RTCIceCandidateInit` 使用。
 */
export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type JoinFailureReason = 'room-full' | 'already-joined' | 'invalid-room-id';

export type ErrorReason = JoinFailureReason | 'bad-message' | 'not-in-room';

/** 浏览器 → 信令服务器 */
export type ClientMessage =
  | { type: 'join'; roomId: string }
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: IceCandidatePayload }
  | { type: 'leave' };

/** 信令服务器 → 浏览器 */
export type ServerMessage =
  | { type: 'joined'; roomId: string; role: Role }
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: IceCandidatePayload }
  | { type: 'error'; reason: ErrorReason };
