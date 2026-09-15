# Stonk 专用：Raydium 实盘 / 主模拟 + Shadow

此版保留原程序的 Engine、主模拟仓位、Shadow 工作线程、特征统计、买入前过滤、双评分模型、入场对照、退出对照、断流恢复、状态报价恢复、训练工具、完整 Dashboard 和 COS 归档流程。仅将行情适配为 Stonk 毕业后的 CPMM 池，并保留毕业后 30 分钟的监控限制。

2026-09-14 已对齐指定参考目录 `E:\dump-sniper-clean-main\dump-v5-publish` 的 `404d67d` 版本。包含新增的 3 秒反弹失败退出对照、归档训练与检查工具、低储备关闭新候选和持仓行情修正。运行入口仍为 Stonk，保留原模拟策略；参考程序专供实盘的止盈 10%、最长持有 20 秒、取消固定止损和行情超时退出不会套用到本版模拟／Shadow。

默认仍是模拟。实盘必须显式设置 `STONK_LIVE_ENABLED=true` 并配置钱包；单独设置 `DRY_RUN=false` 不会启用。实盘使用独立 Raydium 执行器，账本为 `data/stonk/live.json`，Shadow 为 `data/stonk/shadow-live`，不继承模拟持仓。Shadow 始终启用。

## 保留的原策略

当前 Stonk 参数：砸单至少 7 SOL、跌幅 10%–30%、报价储备至少 30 SOL、服务器当前每笔模拟 0.1 SOL（安装示例同步为 0.1）、最多 20 仓、止盈 20%、止损 25%、上涨 10% 后回撤 3% 退出、最长持有 20 秒（每秒巡检触发超时退出）。同币主模拟亏损后冷却 60 秒，Shadow 冷却对照同为 60 秒；普通入场冷却仍为 30 秒。实盘使用 0.1 SOL 默认金额、7 SOL 门槛、60 秒确认净亏损冷却和 20 秒持仓上限；沿用参考实盘的 >100 SOL 入场储备、10% 止盈、8% 上涨后回撤 3% 退出、无固定止损及报价超时退出。20 秒为退出触发时间，不保证链上成交时间。

另外沿用参考版本的新池储备规则：储备未知时不能开仓，SOL 等值储备一旦低于 50 SOL，该池永久停止接收新候选；重启或储备回升不重新开放。因此新候选实际还需通过这层 50 SOL 限制。无持仓的关闭池会退订，有模拟仓位则保留退出行情，直到平仓或毕业满 30 分钟。股票代币储备先通过 Stonk 适配层换算为 SOL，不直接比较代币数量。

主模拟使用原 `paper_spot_v1` 的池价记账；Shadow 使用原费用、滑点、入场／退出延迟和对照实验，并添加 Token-2022 转账费。两种统计不混为实盘收益。

冻结模型 `observation-models/20260908` 采用旧参数；本次 20 秒持仓策略已改变策略标识，兼容性检查会拒绝旧模型评分。Shadow 继续采样和对照，不伪造新参数模型分数。

## 毕业后 30 分钟

- 必须匹配 Stonk 的平台配置、LaunchLab 迁移指令、成功日志和新注资的 CPMM 金库。
- AGE 从迁移交易的链上 blockTime 开始，范围固定为 `0 <= AGE < 30 分钟`。重启和重复发现不重新计时。
- 启动、重连及每分钟检查近期迁移；只订阅 Stonk 发现账户与活动池。
- 满 30 分钟退订，不再开模拟仓位；未完成的主模拟与 Shadow 对照标记为“观察到期／结果未知”。不使用过期价格伪造平仓，也不将缺失结果记为亏损或盈利。
- 曲线内交易、其他平台以及没有毕业迁移的历史 CLMM 池不进入策略。

## 非 SOL 报价资产

自动通过 Helius 查询 Raydium 的 CPMM／CLMM 池，寻找报价资产与 WSOL 的直接估值，或经过 USDC 的估值。候选估值池需达到程序的深度门槛；价格来自已验证账户状态，缓存 5 秒、超时拒绝，不使用 DAS 的长缓存价格。交易与估值均不接入 Meteora。

股票报价 mint 支持已核验的 Token-2022 发行者控制、未启用的转账钩子、未暂停状态及 Scaled UI Amount 等扩展。内部全程使用原始整数余额和 decimals，UI 倍率不重复计入估值；仍计入公开转账费。已启用的转账钩子、暂停、未知或损坏扩展仍拒绝。估值支持不代表资产必然可以兑换；实盘另行验证 Raydium 路由与链上模拟，本币的扩展限制仍保留。

毕业历史默认使用 Helius `getTransactionsForAddress` 批量读取成功交易，保存翻页进度和时间范围，避免平台交易过多时反复从第一页开始。实时发现要求交易同时涉及 Stonk 平台、LaunchLab 和 CPMM。历史交易仅用于发现毕业池，不回放成新的模拟成交。`STONK_BATCH_HISTORY=false` 可回退旧发现方式，但繁忙平台可能长期扫描不完整。

把报价金额、储备和池价统一估算为 SOL 后，交给原来的金额门槛和策略。记录仍保留原始报价 mint、精度、整数余额、估值来源及转账费用。

**这仍是研究用代理估值，不是可执行的兑换路由。** 本版没有新增实盘兑换。状态报价会扣除 CPMM 已累计的协议、基金和创建者费用；成交观察用近期费用快照，因此仍是近似值。Shadow 沿用原来的整体费用／滑点假设，另计两边代币的转账费，不声称包含真实兑换路径的全部成本。

如果报价资产没有可用的上述估值池、状态读取失败或扩展不受支持，该池仍有原始交易日志，但对应观测不参与 SOL 阈值判断或生成模拟利润，记录 `stonk_unvalued_observation`。该池的 Shadow 覆盖会中断，不影响其他池。实际报价资产覆盖率需联网验证。

日志会区分扩展拒绝、RPC 错误、过期与估值失败，并附带安全的错误码；`health.stonk` 提供本次运行的已估值／未估值数量及发现完整性。看板对“所有观测未通过估值”及历史扫描未完成显示警告，连接正常不等于策略已得到有效行情。

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

Raydium CLMM 估值深度同时受虚拟储备和链上金库余额（扣除协议及基金费用）限制；这只是保守的现货估值代理，不代表跨 tick 可执行报价。低于原有 100 SOL 等值深度的估值路径继续拒绝。最新区块时间暂不可用时，只允许使用同一笔已确认交易的链上时间。

## SSH 更新钱包

在服务器交互终端执行 `sudo python3 /opt/stonk-monitor/deploy/update-wallet.py`，按提示输入 Base58 格式的 Solana 钱包私钥。输入隐藏，只输出校验后的钱包地址。工具仅更新 `.env` 并限制权限为 600，不重启、不启用交易。钱包更新工具不会启用实盘。更换正在使用的钱包前必须先处理当前真实持仓与待确认交易；独立账本会拒绝钱包身份不匹配。

## Raydium 实盘执行

仅使用 Raydium 官方 Trade API 报价和构建原子交易，链上查询、模拟和发送通过 Helius。逐池验证 CPMM/CLMM owner、mint、Stonk 目标池，拒绝 Meteora、未知可执行程序、多笔拆分、金额及收款账户不一致的指令。签名前重新设置本地费用上限和有效 blockhash，先检查反向报价并模拟。确认失败则拒绝发送；发送后以已签名交易的签名核对结果，不重新买入未知交易。

真实持仓在毕业 30 分钟结束时触发退出并保留账本，失败继续处理，不能像模拟样本一样删失。净盈亏按该钱包在买卖回执中的 SOL 余额变化计算，包含交易费用和新账户租金支出；不自动清理代币账户。交易使用 confirmed 数据与外部报价，不能保证同 slot 或下一 slot 成交；buy_confirmed 记录 sourceSlot、slot 和 slotDelta。

本地每日 RPC 和流量预算默认不限额（STONK_MAX_RPC_PER_DAY=0、STONK_MAX_STREAM_BYTES_PER_DAY=0）。保留用量统计，不会因达到旧的 20,000 次而阻断处理；服务商自身额度及限速仍有效。同池同 slot 的并发账户读取合并，失败缓存 5 秒后重试。启动配置独立持久化，看板日志截断不会丢失生效参数；连接与处理受阻／覆盖未完整分开显示。
