# WebSocket 源码核对与证据边界

核对日期：**2026年10月25日，北京时间**。本轮只读取官方文档、固定提交的源码；没有安装 `ws`、执行其代码/安装脚本、创建 WebSocket 或连接 Twitch。项目端口要求显式注入 `createSocket`，没有默认库依赖或默认网络。实际 `ws` 生产宿主尚未组合。

## 固定来源

官方 [8.22.0 release](https://github.com/websockets/ws/releases/tag/8.22.0)是本次访问时的 latest release。只读 `git ls-remote` 将该标签核对到提交 **`297202cdae9b0590629821373b3b679c407f3431`**；以下引用全部固定该提交，避免浮动 master。

官方原始文件只下载到工作目录 `work/ws-source-review-8.22.0/`，不复制进软件输出包。匿名 GitHub REST 请求曾受到共享出口限流；没有登录或索取凭据，随后通过官方 release 页面和 Git 远端引用完成固定。

## 选定的构造契约

未来宿主可把 `createSocket(url, options)` 映射为 `new WebSocket(url, [], options)`。初始地址固定为 Twitch 官方 EventSub WSS 地址，不接收任意 URL、认证头、代理或调用者追加选项。本地选定参数：

```js
{
  maxPayload: 65_536,
  maxFragments: 1_024,
  maxBufferedChunks: 1_024,
  perMessageDeflate: false,
  skipUTF8Validation: false,
  followRedirects: false,
  autoPong: true,
  handshakeTimeout: 5_000
}
```

这是本地资源/连接策略，不是 Twitch 要求的数值。[构造参数文档](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/doc/ws.md#L308-L358)支持这些选项：客户端压缩默认开启，因此需显式关闭；UTF-8 验证不能跳过；重定向关闭，握手超时为毫秒。传入对象冻结只能固定端口给出的契约，不能迫使任意工厂实际执行它。

## 长度限制究竟在何处生效

未压缩数据帧先解析长度，再由 [`Receiver.haveLength`](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/receiver.js#L438-L456)累计 `_totalPayloadLength`，包括同一消息的 fragments。超出正的 `maxPayload` 时以状态 1009 拒绝。该判断先于 [`getData` 的 payload consume](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/receiver.js#L480-L489)，也先于[完整文本消息 concat](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/receiver.js#L577-L638)；[concat 的目标分配](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/buffer-util.js#L15-L32)因此受已检查的消息长度约束。

**这只证明固定源码的消息解析/组装检查顺序。** [`_write`](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/receiver.js#L96-L116)已经拿到下层交付的 chunk，再缓存并解析。不能据此宣称 TCP/TLS chunk 分配前保护、整个进程内存不超过64KiB，或任意注入实现都具有相同保障。

`maxFragments`、`maxBufferedChunks` 经[客户端 setSocket](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/websocket.js#L1043-L1049)及 [Receiver 构造](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/websocket.js#L226-L235)透传。Receiver 用 `|0` 转为有符号32位整数，1024有效；配置应保持在正整数 `1..2147483647`，避免0禁用或越界转换。

- buffered-chunk 限制检查尚未消费的 buffer 数：已有1024项时，下一次加入前拒绝，状态1008；它不限制每个下层 chunk 已分配的尺寸。
- fragment 限制对每个非控制数据帧计数，包括空数据帧；第1025个拒绝，完成消息后重置。该检查位于本帧 consume **之后**，不能写成 fragment 分配前限制。[计数](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/receiver.js#L499-L529)、[重置](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/receiver.js#L583-L590)

## 事件、自动 Pong 与包装层责任

`ws` 使用 EventEmitter 接口，消息回调是 `message(data, isBinary)`。当前固定源码的文本路径交付 Buffer 和 `false`，所以不能仅凭 Buffer 类型认定是二进制。[消息接口](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/doc/ws.md#L419-L425)、[文本交付源码](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/receiver.js#L617-L638)

[`receiverOnPing`](https://github.com/websockets/ws/blob/297202cdae9b0590629821373b3b679c407f3431/lib/websocket.js#L1262-L1266)在 `autoPong` 开启时先发送标准 Pong，再通知 ping 监听者；包装层无需重复 Pong，也不发送应用消息。压缩关闭后，本核对不把解压路径当作可用能力。

包装层还需自行核对字节量、文本类型/UTF-8、取消、迟到事件、固定错误以及未完成回调数量。EventEmitter 不会替应用等待异步回调；不能让等待订阅的 welcome 回调串行阻塞后续 keepalive。原始错误与 close reason 不得进入公共结果。冻结、限回调与假工厂检查属于本项目行为，不能替代实际库的协议/网络实测。

## 原生实现与仍待验证的事项

[Node.js v24.17.0 的官方 WebSocket 说明](https://nodejs.org/download/release/v24.17.0/docs/api/globals.html#class-websocket)将其描述为浏览器兼容实现，没有给出这里所需 `maxPayload` 配置证据。本轮没有证明原生实现具有等效可配置的消息分配边界，因此保留缺口，不把它作为默认替代。

后续仍需在适用授权下选定实际库版本、组合宿主并验证真实协议行为。当前源码核对、包装层假工厂检查和真实 Twitch 连通性是三种不同证据；前两项不能升级为第三项。OAuth、可信计票入口、平滑重连和真实频道验收没有因本核对而启用。

本地原始文件 SHA-256（用于复核下载内容，不代表执行验证）：

```text
doc-ws.md          b9394355f4cb5f2cac4b792f012c94cafd824b5b723e08d2ee585f64fa8236dd
lib-receiver.js    a6ada33c9a2d54eaf595824b821ea89ca2c6395f89aa06755c52142148274884
lib-websocket.js   7ccf305925f0cdb74e06b75b4c84de134b1bd771a220ef409b24520def08128f
lib-buffer-util.js 8b0a45739132f82e25ea13163780abf547ccfe989267f3eb7abb475beec92da3
package.json      c1ef91ca04eb4754c011c5f0e7638b5078ff71104fada400c44ac761cf93e0b1
```
