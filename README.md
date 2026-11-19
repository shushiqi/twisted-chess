# 揭棋（TwistedChess）

一款可直接在浏览器里玩的**揭棋**（象棋暗棋变体）：支持本地双人、人机对战、双人在线联机与观战。
零前端框架、零构建步骤，前端是单个 HTML 文件，服务端是一个 Node 进程。

## 玩法要点

- 帅/将正面朝上置于九宫原位；其余 30 子背面朝上、全局随机打乱布子（红黑混排，暗子外观完全一致）。
- **暗子归属按所在半场判定**：落在本半场的暗子归本方使用。
- **暗子按所在棋位类型行走**：车位按车、马位按马、炮位按炮、相位按相、士位按士；兵位只能向前一步；未翻开的暗士只能在本方九宫内走。
- 暗子一经移动立即翻开：翻出己方子留在己方；**翻出对方子则当场易主**，此后由对方按真实身份行棋。
- 取消楚河汉界，除帅/将外全盘开放（揭开的士、象可全盘攻杀）；己方明子可以吃己方暗子。
- 走子后不得让己方帅/将处于被将军状态（含将帅照面），被将军必须解将；双方帅/将同列且中间无子时可直接隔空吃将（飞将）。
- 吃掉对方帅/将即胜；一方无任何合法走法判负。对局结束后全部棋子自动揭晓，便于复盘。

## 功能

| 模式 | 说明 |
|---|---|
| 本地双人 | 同一台设备轮流走棋，无需服务端 |
| 人机对战 | 内置 AI，四档难度（初级 / 普通 / 困难 / 大师） |
| 大模型 AI | 由服务端调用 OpenAI 兼容接口选步，可选棋风；未配置时自动提示 |
| 联机对战 | 房间号加入，服务端权威判定走子，支持断线重连 |
| 观战 | 每个房间可设 3～5 个观战位，观战者与玩家看到的棋盘信息同等脱敏 |

其它：房间内席位互转（观战 ↔ 玩家）、房主转让、对局记录、走子动画、手机/桌面自适应布局。

## 技术栈

- **前端**：原生 HTML/CSS/JS 单文件（`jieqi.html`），规则引擎与 AI 搜索都在页面内，Web Worker 跑搜索。
- **服务端**：Node.js（>= 18）+ [`ws`](https://github.com/websockets/ws)，原生 HTTP + WebSocket，无框架。
- **持久化（可选）**：腾讯云 CloudBase 文档数据库（`roomRepository.js`），未配置时纯内存运行。
- **大模型 AI（可选）**：`aiKnowledge.js` + `ai-knowledge/` 把棋理知识组合进 System Prompt，调用任意 OpenAI 兼容接口。
- **部署**：`render.yaml` 为 Render 的 Blueprint 示例；任意能跑 Node 的平台均可。

## 快速开始

```bash
npm install
npm start
# 打开 http://localhost:3000
```

只玩单机（双人 / 人机）时不需要服务端，直接用浏览器打开 `jieqi.html` 也可以。

局域网联机：用 `http://<本机IP>:3000` 打开页面，双方输入同一房间号即可。

## 目录结构

```
jieqi.html                 单文件前端：界面 + 规则引擎 + AI 搜索
server.js                  HTTP + WebSocket 服务端（房间、席位、权威走子校验、大模型 AI 接口）
roomRepository.js          CloudBase 持久化仓库（可选组件，未配置时只存内存）
aiKnowledge.js             知识库读取与 System Prompt 组装
ai-knowledge/              棋理知识（core 基础 / skills 按局面命中 / strategies 棋风）
package.json / package-lock.json
render.yaml                Render 部署示例
tests/                     引擎、协议、持久化、大模型与浏览器端到端测试
```

## 大模型 AI（可选）

`server.js` 启动时会读取同目录下的 `.env`（不存在则静默跳过；该文件已在 `.gitignore` 中）。把服务端的模型配置写进 `.env` 即可：

| 环境变量 | 是否必需 | 说明 |
|---|---|---|
| `AI_API_TOKEN` | 是 | 模型服务的 API Key，只在服务端使用，不会下发给浏览器 |
| `AI_MODEL` | 是 | 模型名，如 `gpt-4o-mini`、`deepseek-chat` 等 |
| `AI_API_BASE` | 否 | OpenAI 兼容接口地址，默认 `https://api.openai.com/v1` |
| `AI_TIMEOUT_MS` | 否 | 单次请求超时，默认 30000 |
| `AI_MAX_ATTEMPTS` | 否 | 走法非法时的重试次数，默认 3 |
| `AI_STRATEGY` | 否 | 棋风：`aggressive` / `balanced`（默认）/ `defensive` |

配置后页面「模式」里选**大模型 AI** 即可；`GET /api/ai/status` 只返回是否已配置与模型名，不会返回 Token。

发出去的棋盘是**脱敏视图**：未翻开的暗子只带棋位类型，不带真实颜色与兵种；模型返回的走法会逐条对照本地合法走法，非法则重试，多次失败则放弃该步。修改 `ai-knowledge/` 下的 Markdown 后可 `POST /api/ai/knowledge/reload` 热重载，无需重启。

## 测试

```bash
npm test                   # 引擎 / 协议 / 持久化 / 房间回收 / 大模型（Node 内置 test runner）
npm run test:ai            # 仅规则引擎 AI 单测
npm run test:llm           # 大模型 AI（内置 mock 模型服务，无需真实 Key）
npm run test:persist       # 仅持久化
npm run test:smoke:llm     # 手动冒烟：用 .env 里的真实模型跑一步（会产生真实调用）

# 浏览器端到端（需要本机有可用的 Chrome / Chromium）
npm run test:e2e           # 联机：建房、加入、走子、断线、观战
npm run test:room          # 房间管理：观战位容量、席位互转、房主裁定
npm run test:peek          # 房主视角
npm run test:ui            # 模式切换等界面交互
npm run test:flip          # 暗子翻面与走法
npm run test:deploy        # 部署后健康检查与重启恢复
```

CloudBase 集成脚本默认干跑（不需要真实凭据）：

```bash
npm run test:cloudbase:dry
```

## 部署（可选）

1. 用 Render 的 Blueprint 指向本仓库（`render.yaml` 已给出 `npm ci` / `npm start` / `/healthz`），或手动建一个 Web Service。
2. 需要房间跨重启保留时，配置 CloudBase：

| 环境变量 | 是否必需 | 说明 |
|---|---|---|
| `CLOUDBASE_ENV_ID` | 启用持久化时必需 | CloudBase 环境 ID，未配置则房间仅存内存 |
| `CLOUDBASE_APIKEY` | 二选一 | CloudBase API Key（推荐，权限范围小） |
| `TENCENTCLOUD_SECRETID` + `TENCENTCLOUD_SECRETKEY` | 二选一 | 腾讯云密钥对 |

数据库集合（默认 `game_rooms`）务必设为**服务端私有**：文档里含房间席位令牌与未翻开棋子的真实身份，不能对客户端开放读权限。

其它可调环境变量：`PORT`、`MAX_ROOMS`（同时存在的房间上限）、`ROOM_DOC_TTL_MS`（房间文档过期时间）。

## 联机协议摘要

客户端只发送意图，一切判定在服务端：

| 方向 | 消息 |
|---|---|
| 客户端 → 服务端 | `join`（房间号 + 可选 token）、`move`（from/to）、`restart`、`seat`、`spectate`、`specCap`、`declineRestart`、`peek`、`leave` |
| 服务端 → 客户端 | `joined`、`state`、`peer`、`room`、`seatChanged`、`restartRequest`、`restartResolved`、`peek`、`error` |

未翻开的暗子在下发时会被剔除颜色与兵种，只保留归属方，因此联机模式下无法从报文里获知暗子身份。

## 备注

- 房间与棋局默认只存在进程内存，服务重启即丢失；需要保留请启用上面的 CloudBase 持久化。
- 仓库目前未附带开源许可证文件，使用前请与作者确认授权方式。
