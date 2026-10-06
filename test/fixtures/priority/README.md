# Priority P0 去敏样本

`samples.json` 来自 2026-10-06 的已授权只读审核快照，包含 17 份最新报告和 1 份用节点、时间、内容指纹核对过的严格更早报告。

- 节点、报告及目标使用稳定测试别名；运营商后缀、测试族、区域、指标单位、数值、解析状态和时间关系保留。
- 不包含来源 URL、原始 HTML/CSV、账号、密码、Cookie、API Key、机器身份、域名或生产 ID。
- 路由仅保留明确失败状态；成功路由统一为 `measured`，不影响本功能输入。
- 旧分数及回程重度统计来自快照，不是新版预期值。统计范围为 ipv4/ipv6/large4/cernet 的有效百分比，每条记录取最大值，≥20% 算重度。
- 原始映射、快照指纹及基线在被忽略的 `.workbuddy/design/priority-evaluation/manifest.json`，不追踪原始快照。
- 另一份快照已知历史只有元数据，没有明细；其余无前份的样本不伪造历史。
- 这是算法回归输入，不是新的网络测试，也不是生产整库。

离线演算：

```sh
node scripts/evaluate-priority.mjs --input test/fixtures/priority --output .workbuddy/design/priority-evaluation/candidate-2
```

国内 IPv6 测速的预期范围依据见 `template-evidence.md`；缺失与明确失败仍严格区分。国内测速参数为 `usage.domesticSpeed`，国际方向测速属于 `usage.intl`，预设名称为「国内带宽优先」。旧 `usage.speed` 在尚未上线的候选接口中不再接受。

输出包含 4 个预设、原有 9 组组合敏感性和 35 组单项权重扫描。单项扫描每次只改一个权重，其余为 1，记录分数、名次、相对默认差值和贡献变化；名次不变不等于没有影响。

候选参数和未决决策见原设计稿的 P0 实施记录；G0 确认之前不得用于看板。等级继续待确认，不根据实时样本分位自动划档。
