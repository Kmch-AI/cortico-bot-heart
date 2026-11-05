# 状态模型

## 心情

字段（`state/mood.ts`）：`valence` -1..1；`arousal` 0..1；`energy`；`tension`；`openness`；`patience`；`playfulness`；`focus`；`label`；`causes`；`updatedAt`。

更新：

```
mood' = clamp(baseline + inertia * (mood - baseline) + impulse)
```

- 默认 `inertia=0.85`；半衰期 60 分钟，只负责向 baseline 回落。
- `appraise` 由 SystemOne 的 score 或启发式给出，维度：愉悦、激活、能量、紧张、关系变化；重要度由关系变化幅度推导。
- 只在有意义的事件后更新；不按 token 或每句话更新。
- 极端值有 clamp；一次互动不会永久改人。
- `label` 是确定性映射，不是模型生成。

## 关系

按 `person:<id>` / `group:<id>` 存：`familiarity`、`trust`、`intimacy`、`status`、`playfulnessTolerance`、`tension`、`summary`、`updatedAt`。

- 关系变化只由有证据的互动或巩固更新；不从单句推测敏感属性。
- `status` 由数值派生：strained（tension 高）、close（intimacy/trust 高）、friendly、acquaintance、neutral。
- 重要关系进 hot 状态卡；其余按需检索。

## 注意力

字段：`topics`、`threads`（open/waiting/closed）、`pending`、`energy`、`lastSpeakers`、`updatedAt`。

- 从事件文本提取话题；问句形成未完成线程；defer 写入 pending。
- 45 分钟半衰期回落社交能量。
- 用于判断“这句话是不是对我说的”“值不值得接”“接哪条线”。

## 状态卡

`state/stateCard.ts` 每回合生成：

```
[identity] ...
[state] 心情/关系/注意力
[this turn] turn plan
[delivery] 来源路由
记忆卡片
边界说明
```

- 不写入持久历史；`sessionHead` 每次现取。
- 超出 token 预算时先裁记忆，再截断；identity/plan/delivery 优先保留。

## 人类化行为映射

`TurnPlan` 输出：`action`、`intent`、`stance`、`cognitiveDepth` L0–L4、`length`、`directness`、`playfulness`、`voice`、`needsArbiter`。

- 先问“我想说什么”，再问“怎么说”。
- 自主只管立场/语气/是否接话；事实与安全边界不被覆盖。
- 允许短、碎、省略、模糊、自我修正；但不能机械加语气词。
- 情绪 ≠ 交际意图；关系与场景决定表达。
- 沉默是合法行为。
