# ADR 0003: 决策归 SystemOne，生成归主模型

- 状态：接受（2026-11-03）
- 背景：需要稳定、可校准、低成本的 typed 决策；SystemOne 不生成文本。
- 决定：`/v1/systemone` 回答 `noul/choice/score`；turn plan、记忆保存/重排、arbiter 选择用它；自由文本由主模型/fork 生成。
- 理由：概率可校准；输出结构稳定；避免让决策模型写 JSON 文本。
- 代价：服务侧需要真正实现 Jev wire format；当前服务只有 OpenAI 兼容预设。
- 缓解：服务不可用时启发式降级；阈值按模型校准；trace 记录模式与延迟。
