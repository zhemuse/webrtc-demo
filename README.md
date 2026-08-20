# WebRTC Demo

一个 WebRTC 入门 demo：**1对1 音视频通话 + DataChannel 文字/文件传输**，配一个自己写的 WebSocket 信令服务器。

代码刻意写得直白，目的是把 WebRTC 的协商流程完整地摊开给人看，而不是藏在库后面。

设计文档见 [docs/design.md](docs/design.md)：需求、技术栈选型、WebRTC 原理介绍、实现思路。

## 快速开始

```bash
pnpm install
pnpm dev
```

然后打开 **两个** 标签页访问 <http://localhost:5173>，两边填**同一个房间号**，点「加入房间」。

- 浏览器会请求摄像头和麦克风权限。拒绝也能继续，只是没有画面，数据通道照常可用。
- 两个标签页是同一台机器上的两个 peer，走本地回环，一定能连通。跨设备测试见下面的「局限」。
- 房间号会写进 URL hash，可以直接把链接发给对方。

生产模式（前端构建产物由信令服务器一并托管，同源，只需要一个端口）：

```bash
pnpm build
pnpm start         # http://localhost:8080
```

## 它是怎么跑起来的

```
浏览器 A                信令服务器 (ws)                浏览器 B
   |                          |                          |
   |---- join {roomId} ------>|                          |
   |<--- joined {role:callee} |                          |
   |                          |<----- join {roomId} -----|
   |<--- peer-joined ---------|------ joined {caller} -->|
   |                          |                          |
   |<--- offer ---------------|<----- offer -------------|  B 建 DataChannel 并发起
   |---- answer ------------->|------ answer ----------->|
   |<==> ice-candidate <=====>|<====> ice-candidate <===>|  双向持续交换
   |                          |                          |
   |<==================== P2P 音视频 + DataChannel =====>|  不再经过服务器
```

几个关键点：

1. **信令服务器只是个邮差。** 它维护「谁在哪个房间」，然后把 `offer` / `answer` / `ice-candidate` 原样转发给房间里的另一个人。它从不解析 SDP —— WebRTC 规范根本没规定信令怎么做，用 WebSocket、HTTP 轮询甚至手动复制粘贴都行。

2. **后进房间的人当发起方（caller）。** 因为他一进来就知道房里已经有人，可以立刻发 offer，省掉一轮「通知你去发起」的往返。先到的人只需要等。

3. **DataChannel 必须在 `createOffer()` 之前创建。** 否则 SDP 里不会带上 SCTP 那一段，数据通道就建不起来。这是最常见的坑之一，见 `client/src/main.ts` 里 caller 分支的顺序。

4. **candidate 可能比 SDP 先到。** 在 `setRemoteDescription()` 之前调 `addIceCandidate()` 会抛错，所以 `client/src/peer.ts` 里先把早到的 candidate 攒起来，等远端描述设好再补进去。

5. **文件传输走 16 KB 分片。** 先发一条 JSON 元信息（文件名/大小/MIME），紧跟着发二进制块。DataChannel 默认可靠有序，所以不需要给分片编号 —— 收到第几片就是第几片。发送端用 `bufferedAmount` 做背压，避免大文件把发送队列撑爆。

## 目录结构

```
shared/signaling.ts     前后端共享的信令消息类型（纯类型，编译后消失）
server/src/rooms.ts     房间成员管理，纯逻辑，可单测
server/src/index.ts     HTTP + WebSocket 服务，消息转发
client/src/signaling.ts WebSocket 客户端：JSON 编解码、指数退避重连、断线排队
client/src/peer.ts      RTCPeerConnection 封装：offer/answer/ICE/轨道
client/src/transfer.ts  文件切片与拼装，纯逻辑，可单测
client/src/chat.ts      DataChannel 上的应用层协议：文字 + 文件
client/src/main.ts      UI 与上述模块的粘合
```

## 测试

```bash
pnpm test         # 单元测试（房间管理、文件切片/拼装）
pnpm typecheck    # 两个 tsconfig 分别检查前后端
```

单元测试只覆盖不依赖浏览器的纯逻辑。媒体协商部分靠手动验证 —— 真机摄像头和 NAT 打洞在 CI 里成本高、价值低。

手动验证清单：

- [ ] 两个标签页同房间号 → 两边都看到对方画面
- [ ] 发文字消息 → 对面收到
- [ ] 发一个几十 MB 的文件 → 进度条推进，对面能下载且大小一致
- [ ] 关闭麦克风/摄像头 → 对面画面或声音停止
- [ ] 关掉一个标签页 → 另一边提示「对方已离开」
- [ ] 通话中重启信令服务器 → 页面显示「重连中」并自动恢复，已建立的 P2P 通话不受影响（媒体不经过信令服务器）

## 局限

**没有 TURN。** 只配了 Google 的公共 STUN。STUN 能解决大部分家用 NAT，但对称 NAT、严格的企业防火墙、部分移动网络下会连不通，界面会显示「连接失败」。这是所有入门 demo 的共同局限 —— 生产环境必须自己部署 TURN 中继（例如 [coturn](https://github.com/coturn/coturn)），然后把它加进 `client/src/peer.ts` 的 `ICE_SERVERS`。

**跨设备需要 HTTPS。** 浏览器只在安全上下文里给 `getUserMedia` 权限，`localhost` 是唯一豁免。想用手机连电脑测试，得配自签证书或用 ngrok 之类的隧道。

**只支持 1对1。** 房间上限两人。多人要么做 mesh（N×(N-1) 条连接，人一多就崩），要么上 SFU（mediasoup / Janus / LiveKit），那已经不是 demo 的范畴了。

**没有鉴权。** 知道房间号就能进。真实产品需要在信令层做身份校验。

## 技术栈

Vite + TypeScript（前端，无框架）· Node + Express + ws（信令）· Vitest（单测）
