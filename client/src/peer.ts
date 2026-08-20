import type { IceCandidatePayload } from '../../shared/signaling';

/**
 * 只配了公共 STUN，没有 TURN。
 * 对称 NAT / 严格企业防火墙下会连不通 —— 这是所有入门 demo 的共同局限，
 * 生产环境必须自己部署 TURN（例如 coturn），见 README。
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export interface PeerHandlers {
  onRemoteStream: (stream: MediaStream) => void;
  onLocalCandidate: (candidate: IceCandidatePayload) => void;
  onDataChannel: (channel: RTCDataChannel) => void;
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  /** ICE 走到 failed，调用方可以决定要不要重新协商。 */
  onIceFailed: () => void;
}

/**
 * RTCPeerConnection 的一层薄封装。
 *
 * 它只管协商，不管信令怎么传、也不管 UI —— 产出的 SDP 和 candidate
 * 交给调用方发出去，收到的对端数据喂回来即可。
 */
export class PeerSession {
  readonly pc: RTCPeerConnection;
  private readonly remoteStream = new MediaStream();
  /**
   * 对端的 candidate 可能比 answer/offer 先到。
   * setRemoteDescription 之前调 addIceCandidate 会抛错，所以先攒着。
   */
  private pendingCandidates: IceCandidatePayload[] = [];
  private hasRemoteDescription = false;

  constructor(private readonly handlers: PeerHandlers) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.addEventListener('icecandidate', (event) => {
      // candidate 为 null 表示收集结束，不用发给对端。
      if (event.candidate === null) return;
      this.handlers.onLocalCandidate(event.candidate.toJSON() as IceCandidatePayload);
    });

    this.pc.addEventListener('track', (event) => {
      this.remoteStream.addTrack(event.track);
      this.handlers.onRemoteStream(this.remoteStream);
    });

    this.pc.addEventListener('datachannel', (event) => {
      this.handlers.onDataChannel(event.channel);
    });

    this.pc.addEventListener('connectionstatechange', () => {
      this.handlers.onConnectionStateChange(this.pc.connectionState);
    });

    this.pc.addEventListener('iceconnectionstatechange', () => {
      if (this.pc.iceConnectionState === 'failed') this.handlers.onIceFailed();
    });
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  createDataChannel(label: string): RTCDataChannel {
    return this.pc.createDataChannel(label, { ordered: true });
  }

  /** 发起方：产出 offer 的 SDP。iceRestart 用于连接失败后重新打洞。 */
  async createOffer(options: { iceRestart?: boolean } = {}): Promise<string> {
    const offer = await this.pc.createOffer({ iceRestart: options.iceRestart ?? false });
    await this.pc.setLocalDescription(offer);
    return this.requireLocalSdp();
  }

  /** 应答方：收下 offer，产出 answer 的 SDP。 */
  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.drainPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.requireLocalSdp();
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    await this.drainPendingCandidates();
  }

  async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }

  private async drainPendingCandidates(): Promise<void> {
    this.hasRemoteDescription = true;
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn('[peer] 补加 candidate 失败', error);
      }
    }
  }

  private requireLocalSdp(): string {
    const sdp = this.pc.localDescription?.sdp;
    if (sdp === undefined) throw new Error('setLocalDescription 之后仍然没有本地 SDP');
    return sdp;
  }

  close(): void {
    for (const track of this.remoteStream.getTracks()) this.remoteStream.removeTrack(track);
    this.pc.close();
  }
}
