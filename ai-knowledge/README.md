# 揭棋 AI 本地知识体系

为大模型 AI 对弈提供可扩展的本地知识库。知识以 Markdown 保存，`index.json` 维护索引，
由 `aiKnowledge.js` 读取，并按当前棋局特征动态加载相关 Skill，最终组合进 System Prompt。

## 目录结构

```
ai-knowledge/
  README.md            本说明
  index.json           知识模块索引（id / name / file / description / trigger）
  core/                每次调用都加载的基础知识
    role.md            AI 角色与任务
    rules.md           项目实际揭棋规则
    decision-principles.md  决策原则、合法走法约束、信息使用限制、返回格式
  skills/              按棋局特征动态加载的技能
    opening.md         开局策略
    attack.md          进攻策略
    defense.md         防守策略
    hidden-pieces.md   暗子与不确定性策略
    piece-value.md     棋子价值与交换策略
    positional-play.md 局面控制与棋子协同
    endgame.md         残局策略
  strategies/          可选棋风（只调整决策偏好，不违反规则）
    aggressive.md      激进
    defensive.md       防守
    balanced.md        均衡（默认）
```

## 加载规则

- **Core**：每次模型调用都加载（`trigger: { always: true }`）。
- **Skills**：根据当前棋局特征动态匹配 `trigger`，命中才加载。
- **Strategy**：默认 `balanced`，可通过请求体 `strategy` 字段或环境变量 `AI_STRATEGY` 指定。

## 触发条件（trigger）

触发条件基于现有棋局数据，可靠可计算：

| 字段 | 含义 | 来源 |
|---|---|---|
| `always` | 始终加载 | 常量 |
| `handNoLte` / `handNoGte` | 手数 ≤ / ≥ 阈值 | 棋局 `handNo` |
| `remainingPiecesLte` | 剩余棋子数 ≤ 阈值 | 棋盘棋子计数 |
| `hasCapture` | 存在可吃子的合法走法 | 合法走法列表 |
| `inCheck` | 当前行棋方被将军 | `isKingAttacked(turn)` |
| `hasHiddenPieces` | 存在未翻开暗子 | 棋盘暗子计数 |

当前阈值（启发式，可按实际调整）：
- `opening`：`handNo ≤ 10`
- `positional-play`：`handNo ≥ 11`
- `endgame`：`remainingPieces ≤ 8`

## 组合 System Prompt

最终 System Prompt 按以下顺序拼接：

1. Core 知识（角色 → 规则 → 决策原则）
2. 棋风策略（默认 balanced）
3. 命中的 Skills（按 `index.json` 顺序）

棋盘数据、合法走法列表与用户提示内容保持原有位置，不受影响。

## 重新加载

- 知识文件在服务启动时读取并缓存，避免每次请求重复访问磁盘。
- 修改知识文件后：调用 `POST /api/ai/knowledge/reload` 热重载，或重启服务生效。
- 知识文件缺失时自动跳过（降级），不影响其余知识与原有 AI 调用。

## 约束

- 知识内容只影响提示词，**不改变**服务端合法走法校验与落子流程。
- 不允许将对手隐藏信息泄漏给 AI：知识内容不得包含暗子真实身份等不可见信息。
- 不引入外部依赖（无 LangChain / Agent / 向量数据库）。
