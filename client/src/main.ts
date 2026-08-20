import './style.css';

import { ChatChannel } from './chat';
import { PeerSession } from './peer';
import { Signaling, defaultSignalingUrl, type ConnectionStatus } from './signaling';
import type { FileMeta } from './transfer';
import type { Role, ServerMessage } from '../../shared/signaling';

const DATA_CHANNEL_LABEL = 'chat';

const ERROR_MESSAGES: Record<string, string> = {
  'room-full': '房间已满（1对1 demo 每个房间只能两个人）',
  'already-joined': '这个连接已经在别的房间里了',
  'invalid-room-id': '房间号只能是字母、数字、下划线或连字符，1–64 个字符',
  'not-in-room': '还没加入房间',
  'bad-message': '服务器无法解析这条消息',
};

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`页面上找不到元素 ${selector}`);
  return element;
}

const ui = {
  roomInput: required<HTMLInputElement>('#room-input'),
  joinButton: required<HTMLButtonElement>('#join-button'),
  leaveButton: required<HTMLButtonElement>('#leave-button'),
  hint: required<HTMLParagraphElement>('#hint'),
  signalingStatus: required<HTMLSpanElement>('#signaling-status'),
  peerStatus: required<HTMLSpanElement>('#peer-status'),
  roleStatus: required<HTMLSpanElement>('#role-status'),
  localVideo: required<HTMLVideoElement>('#local-video'),
  remoteVideo: required<HTMLVideoElement>('#remote-video'),
  toggleMic: required<HTMLButtonElement>('#toggle-mic'),
  toggleCam: required<HTMLButtonElement>('#toggle-cam'),
  messages: required<HTMLOListElement>('#messages'),
  chatForm: required<HTMLFormElement>('#chat-form'),
  chatInput: required<HTMLInputElement>('#chat-input'),
  sendButton: required<HTMLButtonElement>('#send-button'),
  fileInput: required<HTMLInputElement>('#file-input'),
  fileProgress: required<HTMLProgressElement>('#file-progress'),
};

let signaling: Signaling | null = null;
let session: PeerSession | null = null;
let chat: ChatChannel | null = null;
let localStream: MediaStream | null = null;
let role: Role | null = null;

// —— 日志区 ——————————————————————————————————————————————

type LogKind = 'system' | 'sent' | 'received' | 'error';

function log(kind: LogKind, text: string): void {
  const item = document.createElement('li');
  item.className = `message message--${kind}`;
  item.textContent = text;
  ui.messages.append(item);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function setSignalingStatus(status: ConnectionStatus): void {
  const labels: Record<ConnectionStatus, string> = {
    connecting: '连接中',
    open: '已连接',
    reconnecting: '重连中',
    closed: '未连接',
  };
  ui.signalingStatus.textContent = `信令：${labels[status]}`;
  ui.signalingStatus.dataset.state = status;
}

function setPeerStatus(state: RTCPeerConnectionState): void {
  const labels: Record<RTCPeerConnectionState, string> = {
    new: '未建立',
    connecting: '协商中',
    connected: '已连通',
    disconnected: '连接中断',
    failed: '连接失败',
    closed: '已关闭',
  };
  ui.peerStatus.textContent = `连接：${labels[state]}`;
  ui.peerStatus.dataset.state = state;
}

function setChatEnabled(enabled: boolean): void {
  ui.chatInput.disabled = !enabled;
  ui.sendButton.disabled = !enabled;
  ui.fileInput.disabled = !enabled;
}

// —— 媒体 ——————————————————————————————————————————————

async function acquireLocalMedia(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    ui.localVideo.srcObject = stream;
    ui.toggleMic.disabled = false;
    ui.toggleCam.disabled = false;
    return stream;
  } catch (error) {
    // 拿不到摄像头也要能继续 —— 数据通道不依赖媒体流。
    log('error', `摄像头/麦克风不可用：${error instanceof Error ? error.message : String(error)}。仍可使用数据通道。`);
    return null;
  }
}

function makeToggle(button: HTMLButtonElement, kind: 'audio' | 'video', onLabel: string, offLabel: string): void {
  button.addEventListener('click', () => {
    if (localStream === null) return;
    const tracks = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
    if (tracks.length === 0) return;

    const nextEnabled = !tracks[0].enabled;
    for (const track of tracks) track.enabled = nextEnabled;
    button.textContent = nextEnabled ? onLabel : offLabel;
    if (nextEnabled) delete button.dataset.off;
    else button.dataset.off = 'true';
  });
}

// —— 连接生命周期 ————————————————————————————————————————

function attachChat(channel: RTCDataChannel): void {
  chat = new ChatChannel(channel, {
    onOpen: () => {
      setChatEnabled(true);
      log('system', '数据通道已打开');
    },
    onClose: () => {
      setChatEnabled(false);
      log('system', '数据通道已关闭');
    },
    onText: (text) => log('received', `对方：${text}`),
    onSendProgress: (meta, progress) => showProgress(meta, progress, '发送'),
    onReceiveProgress: (meta, progress) => showProgress(meta, progress, '接收'),
    onFileComplete: (meta, blob) => {
      ui.fileProgress.hidden = true;
      appendDownload(meta, blob);
    },
    onError: (message) => log('error', message),
  });
}

function showProgress(meta: FileMeta, progress: number, verb: string): void {
  ui.fileProgress.hidden = false;
  ui.fileProgress.value = progress;
  ui.fileProgress.title = `${verb} ${meta.name} — ${Math.round(progress * 100)}%`;
  if (progress >= 1 && verb === '发送') ui.fileProgress.hidden = true;
}

function appendDownload(meta: FileMeta, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const item = document.createElement('li');
  item.className = 'message message--received';

  const link = document.createElement('a');
  link.href = url;
  link.download = meta.name;
  link.textContent = `${meta.name}（${formatBytes(meta.size)}）`;

  item.append('对方发来文件：', link);
  ui.messages.append(item);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function createSession(): PeerSession {
  const created = new PeerSession({
    onRemoteStream: (stream) => {
      ui.remoteVideo.srcObject = stream;
    },
    onLocalCandidate: (candidate) => signaling?.send({ type: 'ice-candidate', candidate }),
    onDataChannel: (channel) => attachChat(channel),
    onConnectionStateChange: setPeerStatus,
    onIceFailed: () => {
      log('error', 'ICE 连接失败，尝试重新打洞（没有 TURN 时对称 NAT 下大概率仍会失败）');
      void restartIce();
    },
  });

  if (localStream !== null) created.addLocalStream(localStream);
  return created;
}

/** 收 offer 时对端可能刚重连，这里保证总有一个可用的 PeerSession。 */
function ensureSession(): PeerSession {
  session ??= createSession();
  return session;
}

async function restartIce(): Promise<void> {
  if (session === null || role !== 'caller') return;
  try {
    const sdp = await session.createOffer({ iceRestart: true });
    signaling?.send({ type: 'offer', sdp });
  } catch (error) {
    log('error', `ICE restart 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function teardownPeer(): void {
  chat?.close();
  chat = null;
  session?.close();
  session = null;
  ui.remoteVideo.srcObject = null;
  setChatEnabled(false);
  setPeerStatus('closed');
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  switch (message.type) {
    case 'joined': {
      role = message.role;
      ui.roleStatus.hidden = false;
      ui.roleStatus.textContent = role === 'caller' ? '角色：发起方' : '角色：应答方';
      log('system', `已加入房间 ${message.roomId}`);

      const peer = ensureSession();
      if (role === 'caller') {
        // 房间里已经有人在等，直接发起。DataChannel 必须在 createOffer 之前建，
        // 否则 SDP 里不会带上 SCTP 那一段。
        attachChat(peer.createDataChannel(DATA_CHANNEL_LABEL));
        const sdp = await peer.createOffer();
        signaling?.send({ type: 'offer', sdp });
      } else {
        log('system', '等待对方加入…');
      }
      return;
    }

    case 'peer-joined':
      log('system', '对方已加入，等待对方发起协商…');
      return;

    case 'peer-left':
      log('system', '对方已离开');
      teardownPeer();
      return;

    case 'offer': {
      const peer = ensureSession();
      const sdp = await peer.acceptOffer(message.sdp);
      signaling?.send({ type: 'answer', sdp });
      return;
    }

    case 'answer':
      await ensureSession().acceptAnswer(message.sdp);
      return;

    case 'ice-candidate':
      await ensureSession().addIceCandidate(message.candidate);
      return;

    case 'error':
      log('error', ERROR_MESSAGES[message.reason] ?? `服务器返回错误：${message.reason}`);
      if (message.reason === 'room-full' || message.reason === 'invalid-room-id') leaveRoom();
      return;
  }
}

async function joinRoom(): Promise<void> {
  const roomId = ui.roomInput.value.trim();
  if (roomId === '') {
    log('error', '请先填写房间号');
    return;
  }

  ui.joinButton.hidden = true;
  ui.leaveButton.hidden = false;
  ui.roomInput.disabled = true;
  ui.hint.textContent = `房间号 ${roomId} —— 把这个号填到另一个标签页里。`;
  location.hash = roomId;

  localStream = await acquireLocalMedia();

  signaling = new Signaling(defaultSignalingUrl(), {
    onStatusChange: setSignalingStatus,
    onMessage: (message) => {
      void handleServerMessage(message).catch((error: unknown) => {
        log('error', `处理 ${message.type} 出错：${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });
  signaling.connect();
  signaling.send({ type: 'join', roomId });
}

function leaveRoom(): void {
  signaling?.send({ type: 'leave' });
  signaling?.close();
  signaling = null;
  role = null;
  teardownPeer();

  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;
  ui.localVideo.srcObject = null;

  ui.joinButton.hidden = false;
  ui.leaveButton.hidden = true;
  ui.roomInput.disabled = false;
  ui.roleStatus.hidden = true;
  ui.toggleMic.disabled = true;
  ui.toggleCam.disabled = true;
  ui.hint.textContent = '已离开房间。';
  log('system', '已离开房间');
}

// —— 绑定 ——————————————————————————————————————————————

ui.joinButton.addEventListener('click', () => {
  void joinRoom();
});
ui.leaveButton.addEventListener('click', leaveRoom);

ui.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui.chatInput.value.trim();
  if (text === '' || chat === null) return;
  chat.sendText(text);
  log('sent', `我：${text}`);
  ui.chatInput.value = '';
});

ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files?.[0];
  if (file === undefined || chat === null) return;

  log('sent', `发送文件：${file.name}（${formatBytes(file.size)}）`);
  chat
    .sendFile(file)
    .then(() => log('system', `${file.name} 发送完成`))
    .catch((error: unknown) => {
      log('error', `发送失败：${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      ui.fileInput.value = '';
    });
});

makeToggle(ui.toggleMic, 'audio', '关闭麦克风', '开启麦克风');
makeToggle(ui.toggleCam, 'video', '关闭摄像头', '开启摄像头');

window.addEventListener('beforeunload', () => {
  signaling?.send({ type: 'leave' });
});

// 用 URL hash 预填房间号，方便把链接直接发给对方。
if (location.hash.length > 1) {
  ui.roomInput.value = decodeURIComponent(location.hash.slice(1));
}

setSignalingStatus('closed');
setPeerStatus('new');
