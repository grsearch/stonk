# Stonk 专用：原策略 + 主模拟 + Shadow（实盘关闭）

此版保留原程序的 Engine、主模拟仓位、Shadow 工作线程、特征统计、买入前过滤、双评分模型、入场对照、退出对照、断流恢复、状态报价恢复、训练工具、完整 Dashboard 和 COS 归档流程。仅将行情适配为 Stonk 毕业后的 CPMM 池，并保留毕业后 30 分钟的监控限制。

实盘在入口配置和执行器两层封锁。即使 `.env` 写入 `DRY_RUN=false`、`LIVE_CALIBRATION=true` 或钱包私钥，也不会启用实盘；当前运行路径不创建原来的钱包执行器。Shadow 强制启用。

## 保留的原策略

默认参数与原 dump-v5-publish 配置一致：砸单至少 8 SOL、跌幅 10%–30%、报价储备至少 30 SOL、每笔模拟 1 SOL、最多 20 仓、止盈 20%、止损 25%、上涨 10% 后回撤 3% 退出、最长持有 30 分钟。原买入过滤、冷却、候选限速与延迟规则仍生效。

主模拟使用原 `paper_spot_v1` 的池价记账；Shadow 使用原费用、滑点、入场／退出延迟和对照实验，并添加 Token-2022 转账费。两种统计不混为实盘收益。

默认加载 `observation-models/20260908` 的冻结反弹与大跌模型，策略标识仍是 `4aa9d98cc8a3e538`。模型只作原模型在新市场上的参考评分，不能视为经过 Stonk 验证；改变策略参数后，原来的模型兼容性检查仍会拒绝不匹配的模型。

## 毕业后 30 分钟

- 必须匹配 Stonk 的平台配置、LaunchLab 迁移指令、成功日志和新注资的 CPMM 金库。
- AGE 从迁移交易的链上 blockTime 开始，范围固定为 `0 <= AGE < 30 分钟`。重启和重复发现不重新计时。
- 启动、重连及每分钟检查近期迁移；只订阅 Stonk 发现账户与活动池。
- 满 30 分钟退订，不再开模拟仓位；未完成的主模拟与 Shadow 对照标记为“观察到期／结果未知”。不使用过期价格伪造平仓，也不将缺失结果记为亏损或盈利。
- 曲线内交易、其他平台以及没有毕业迁移的历史 CLMM 池不进入策略。

## 非 SOL 报价资产

自动通过 Helius 查询 Raydium 的 CPMM／CLMM 池，寻找报价资产与 WSOL 的直接估值，或经过 USDC 的估值。候选估值池需达到程序的深度门槛；价格来自已验证账户状态，缓存 5 秒、超时拒绝，不使用 DAS 的长缓存价格。

把报价金额、储备和池价统一估算为 SOL 后，交给原来的金额门槛和策略。记录仍保留原始报价 mint、精度、整数余额、估值来源及转账费用。

**这仍是研究用代理估值，不是可执行的兑换路由。** 本版没有新增实盘兑换。状态报价会扣除 CPMM 已累计的协议、基金和创建者费用；成交观察用近期费用快照，因此仍是近似值。Shadow 沿用原来的整体费用／滑点假设，另计两边代币的转账费，不声称包含真实兑换路径的全部成本。

如果报价资产没有可用的上述估值池、状态读取失败或扩展不受支持，该池仍有原始交易日志，但对应观测不参与 SOL 阈值判断或生成模拟利润，记录 `stonk_unvalued_observation`。该池的 Shadow 覆盖会中断，不影响其他池。实际报价资产覆盖率需联网验证。

## 启动与观察

需要 Node.js 22.16 或更新版本及 npm。

1. 在项目根目录运行 `npm run setup` 安装锁定版本依赖。
2. 将 `helius/.env.example` 复制为 `helius/.env`，填写 Helius 密钥或 RPC/WSS 地址。
3. 运行 `npm start`，启动 Stonk 行情、原主模拟与 Shadow。
4. 另一个终端运行 `npm run dashboard`，打开 http://127.0.0.1:8788 。

看板恢复为原完整面板：模拟持仓、盈亏、Shadow 状态、模型状态、对照观察及归档状态。`shadow_health.status=running` 才表示工作线程已运行。`samples` 与 `outcomes` 表示实际收到候选和后续观察；没有候选不等于线程没运行。

仅本项目 `helius/.env` 被主程序读取，进程环境优先。COS 密钥仍由独立归档任务读取。

## 数据与部署

默认数据独立位于 `helius/data/stonk`：`paper.json` 与 `.jsonl` 是原模拟账本，`shadow/` 是原 Shadow 样本和 AGE 缓存，`state.json` 与每日 JSONL 是 Stonk 发现和原始监控记录，`exports/` 是归档。

原 `MAX_STREAM_MB_PER_DAY` 流量设置保留，0 表示不设流量上限；如明确设置 `STONK_MAX_STREAM_BYTES_PER_DAY` 则覆盖它。新增发现／估值 HTTP 请求有默认每日 20,000 次预算，可用 `STONK_MAX_RPC_PER_DAY` 调整；它不是 Helius credits 账单。达到限制后相关观察可能无法估值，日志会显示原因。

发现扫描默认每个平台最多 10 页、每页 100 个签名。到达页数上限标记 `discovery_incomplete`，不推进不完整扫描的游标。离线交易不回填为实时信号。当前交易解析范围为 legacy/v0。

Linux 使用 `sudo bash deploy/install.sh`，默认安装到 `/opt/stonk-monitor`。脚本安装原模块、依赖、模型、看板和归档服务；不覆盖原 PumpSwap 服务，不自动启动。

```sh
sudo systemctl enable --now stonk-monitor
sudo systemctl enable --now stonk-dashboard
journalctl -u stonk-monitor -f
# 填好 helius/.cos.env 后再启动原有每日归档流程：
sudo systemctl enable --now stonk-upload.timer
```

COS 归档沿用原北京时间 07:00 和恢复检查，默认前缀改为 `stonk/daily`。原离线训练、模型安装和研究脚本仍在 `helius/scripts`。

## 验证

`npm test` 运行原有回归测试与 Stonk 测试。受限 Windows 环境可在 Node 24 使用 `node --test --test-isolation=none helius/test/*.test.js`。

已通过原测试和新增测试，包括真实 Shadow 工作线程启动、原过滤响应、主模拟买入／止盈、30 分钟删失、CPMM 与非 SOL 精度、转账税、状态验证和实盘封锁。尚未配置真实 Helius 密钥，没有完成线上样本与报价覆盖率验收。

协议依据：
- LaunchLab IDL：https://github.com/raydium-io/raydium-docs/blob/master/public/launchpad_creator_fee_upgrade/raydium_launchpad.json
- CPMM 状态：https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/states/pool.rs
- CLMM 布局：https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/clmm/layout.ts
- Stonk 平台地址：https://docs.bitquery.io/docs/blockchain/Solana/stonkfun-api/

部署请使用 `dist/stonk-paper-shadow-first30m.zip`。上一版 `stonk-monitor-first30m.zip` 同步更新为相同内容。`helius-pumpswap-v5.zip` 是历史包，不用于本版。另一份 `dump-sniper-clean-main` 未修改。
