# 观察模型、执行对照与迁移 AGE分析

## 小额实盘校准（默认关闭）

### 紧急修复：失败回执阻塞退出

旧校准路径使用默认拒绝失败交易的行情normalize解析器处理失败回执，可能持续报Calibration receipt unavailable，无法释放pending，阻塞其他持仓止损、超时卖出和补价。现仅在校准回执账务入口显式允许解析失败交易，记录真实余额/手续费后沿原失败流程清除pending；失败交易仍不作为行情信号，无法获取回执时仍保留pending，不凭超时或截图删除。

部署保留calibration.json和全部待确认记录，让新进程重新核对原签名。检查calibration_receipt(status=failed)、transaction_failed以及待确认是否清除，再核对其他仓位sell_submitted/sell_confirmed。无需重置账本或额度，不修改STOP_LOSS_PCT=25、MAX_HOLD_MS=1800000。本地回归验证了失败买/卖/关户及解除阻塞后的止损和超时退出；服务器具体pending根因和真实成交仍需现场回执确认。

### 批量账户读取失败排查

`failed to get info for accounts` 来自 web3.js 的 `getMultipleAccountsInfoAndContext`。该前缀不代表具体根因，后面长账户列表可能遮住真正错误。查看 `execution_account_read_failed` 的 code、requestedSlot、contextSlot、retry，以及同次 `operation_error` 完整原因；不要仅凭前缀认定为节点落后。

仅 code=-32016（节点未达到 minContextSlot）最多增加两次读取，间隔100/200ms。始终保留原minContextSlot，不用旧池状态凑报价；超过700ms重试调度窗口或买入信号期限不再重试。700ms不是网络请求超时，单次请求仍受原10秒超时约束，构建后的信号新鲜度检查仍有效。卖出不套用旧入场信号期限。限流、权限、参数、网络错误不自动重试；最多增加两次Helius账户请求，无新数据源。

更新后用新日志确认服务器具体错误：出现 `execution_account_read_recovered` 表示短暂slot落后已恢复；持续-32016需检查Helius RPC与交易流节点进度，其余错误按完整原因排查。本地测试不能代替服务器成功构建或真实成交验证。Token扩展处理见下文executionExtensionsVersion=1，仅放行明确支持的扩展。

此模式用于测量实际执行与shadow偏差，不是证明策略已盈利。仅部署代码不会发送实盘订单，默认DRY_RUN=true、LIVE_CALIBRATION=false保持纸面。

启用配置（在实际运行的helius/.env中设置；本次代码更新不会代填钱包或切换模式）：

```dotenv
DRY_RUN=false
LIVE_CALIBRATION=true
CALIBRATION_SIZE_SOL=0.05
CALIBRATION_MAX_POSITIONS=20
STATE_FILE=data/calibration.json
SHADOW_ENABLED=true
```

另需配置专用钱包WALLET_PRIVATE_KEY_BS58及现有Helius凭据，密钥不入仓库。不要与其他交易程序共享钱包。已有持仓/待确认交易应使用原模式原账本先完成处理，不能换账本丢掉它们。校准买入拒绝已有WSOL账户，避免外部余额干扰；实盘执行路径仅允许通过校验的元数据Mint扩展及ImmutableOwner账户扩展，准备失败必须单独统计，不代表所有候选都能执行。

校准持仓上限由CALIBRATION_MAX_POSITIONS配置（整数1–20，默认20），买币付款上限使用CALIBRATION_SIZE_SOL（上限0.05，交易费/tip及开户押金另计）；SDK滑点余量包含在该上限内，因此实际买入本金可能更小，忽略原POSITION_SIZE_SOL=1及MAX_CONCURRENT_POSITIONS=20。买入尝试继续统计（包括已发送失败与过期未落链），不再限制总次数；同一未知签名重试不重复记次数。不确定交易先核对，不能重新构建第二笔买单。

累计亏损lossSol继续统计逐笔已实现经济亏损及失败/关闭账户费用，盈利不抵扣已发生亏损；累计亏损不再触发自动停买。总买入尝试也不再触发自动停买。旧CALIBRATION_MAX_BUYS、CALIBRATION_LOSS_LIMIT_SOL环境变量即使保留也不再生效。

批次ID、次数、亏损、已处理签名与买入成本保存在独立calibration.json，重启不清零。旧version=1账本首次启动自动迁移为version=2，保留持仓、待确认交易和所有统计；仅清除原次数/亏损停买原因，账务异常停买原因保留。limits.maxBuys和limits.lossLimitSol为null，表示无限额，不是零额度。不要删除账本或换账本丢掉未完成交易。

六项过滤强制作用于校准买入，包括迁移AGE；交易历史unknown改为拒绝新买入，只有迁移AGE单独unknown仍允许，worker不可用/超时或明确风险拒绝则不买。过滤、持仓与账务状态检查都在发送前；账户、余额、链上成交无法核对时阻止新买入。现有20%止盈、25%止损和移动止盈保持原配置。

### 对照与账务

同一Helius流同时生成same_size（0.05 SOL）和reference_1_sol（1 SOL）两份shadow，使用不同runId/policyId，不能合并收益。只让同金额shadow发原预算内补报价请求；1 SOL参考保留基准代理观察，不另发RPC、不复制全部退出研究。原冻结模型与1 SOL策略匹配，保留在参考组；同金额模型policy不匹配会明确标记，不强行复用概率。六项过滤不依赖这些评分。

链上calibration_receipt记录签名、来源信号、到账代币原始数量变化、提交/收到回执时间、落链slot、钱包SOL变化、托管ATA/WSOL账户lamport变化、meta.fee、已签交易tip和计算单元消耗。meta.fee已经包含优先费，不再次相加；不把配置值伪装成额外实测手续费。链上blockTime只有秒级，不宣称它是精确毫秒落链时间。交易以confirmed回执处理，关闭账户等待finalized；不能把confirmed当作最终不可回滚。

成交净收益由买卖两笔钱包现金变化加托管账户lamport变化核对，排除这些账户租金存入/退回的影响。失败交易费和close费用另外计入累计亏损；不要再从净收益重复扣meta.fee或tip。其他协议账户初始化支出可能仍在现金成本内，不伪装成可退租金；极端或缺失账务标记停止新买入。使用专用钱包，避免外部入金/转账或额外持仓干扰解释。

每日COS归档自动包含calibration.json快照及calibration.json.jsonl；execution-audit.json新增calibration对象，含真实回执和同信号的同金额shadow对照，另列1 SOL参考。配对失败/行情缺口保持unknown，不补零。该报告只配连续shadow结果，后续补报价记录仍在原归档中。面板原纸面盈利统计不代表本校准实盘盈亏，以calibration报告为准。

### 启动后核对

starting.strategyConfig.calibration.enabled=true、sizeSol=0.05、maxPositions=20（或配置的上限）；health.calibration包含batchId/attempts/lossSol/stoppedReason。shadow两份session分别有calibrationRole=same_size/reference_1_sol，sizeSol分别0.05/1。首笔先核对calibration_prebuy_filter、签名、calibration_receipt和实际代币数量，首次导出检查execution-audit.json.calibration。没有真实回执时不能宣布实盘校准完成。


## 最新：迁移后30–120分钟过滤（selectionVersion=7）

默认纸面过滤新增：已验证的Pump毕业迁移AGE在[30分钟,120分钟)时跳过买入，恰好30分钟拦截，恰好120分钟不拦截。AGE只接受since_pump_graduation_migration定义、pump_migrate_processed来源且状态为observed_processed_not_finalized的有效非负migrationAgeMs；不使用代币创建时间。原Age模块仍校验池/币匹配、证据冲突及证据是否在候选前已知。

AGE未知不算危险命中，沿用纸面允许unknown的处理；其他已知风险仍可拒绝。此条件是多个历史时段的减亏尝试，匹配样本小且有方向翻转，不代表迁移AGE具有已证明的因果风险。被过滤候选继续原后台观察，不增加RPC或等待。

核对session.selectionVersion=7、sample.observationVersion=selection-v7，拒绝check=migrationAge、reason=migration_age_30_to_120_minutes。prebuyBeforeAge保留上一版五项规则，avoidMigrationAge单独观察AGE，prebuyCombined改为六项规则；质量与恢复报告保留新旧组。原1 SOL、20%止盈、25%止损、模型及COS定时器保持不变。

独立入场确认研究及离线回放要求当前六项明确通过；AGE未知因此会跳过该研究，但不因此拒绝纸面买入。旧归档缺少可验证迁移证据时记未知，不用创建时间补齐。按规则版本和进程分开分析。


## 历史更新：前5秒买入占比过滤（selectionVersion=6）

默认纸面买前过滤新增：触发砸单之前5秒，买入SOL金额 /（买入SOL金额＋卖出SOL金额）≥80%就跳过。恰好80%也拦截；不包含触发砸单本身，不按笔数或地址数计算。需要完整历史、有效字段及正成交总额，缺失/零成交按unknown沿用原处理，不伪造危险命中。

这是基于多个已检查历史时段的减亏尝试；同币匹配差异不完全一致，未知结果仍存在，不保证未来盈利。被过滤信号继续原后台观察，无新RPC或等待窗口，不消耗纸面持仓、准备名额、冷却。只影响PAPER_PREBUY_FILTER=true且DRY_RUN=true的纸面买入；其他下单路径及退出规则保持原状。

核对session.selectionVersion=6、sample.observationVersion=selection-v6；拒绝原因priorBuyBurst / prior_buy_fraction_5s_at_least_80pct。新增avoidBuyBurst单项分组和prebuyBeforeBuy80（上一版四项规则）分组；prebuyCombined改为五项规则，prebuyLegacy仍保留最初三项。质量报告与恢复报告分别保留新旧组，缺失结果不填零。无需新配置、重装模型或修改每日COS任务。

离线入场回放随当前selection使用五项规则，旧归档缺失买入占比字段时按未知跳过。部署边界前后的结果按selectionId和进程分组，不直接混合。


## 历史更新：连续卖出压力过滤（selectionVersion=5）

默认 PAPER_PREBUY_FILTER=true 且 DRY_RUN=true 时，新增直接跳过条件：触发砸单之前的成交序列已连续至少3笔卖出，且前5秒卖出SOL金额严格大于买入SOL金额。两项必须同时成立；触发砸单本身不计入，连续3笔不要求同一卖家，也不限定都在5秒内。金额相等或只有2笔连续卖出不触发。

历史完整且字段有效才判断该条件；历史未知沿用原处理，不伪造危险命中。命中在持仓、准备名额和冷却消耗前拦截，原因记录为 consecutivePressure / consecutive_sells_3_and_net_sell_5s。沿用内存历史计算，不新增RPC、等待窗口或数据源。

后台仍保留所有可观察候选的原策略代理结果；prebuyLegacy保留原三项组合，avoidConsecutivePressure单独观察新条件，prebuyCombined及未知处理分组应用四项规则。观察仍受既有容量、行情连续性和期限限制，缺失结果保持未知。这是历史减亏证据支持的纸面防守尝试，不是已验证的盈利策略，不接入实盘下单路径。

部署后核对：session.selectionVersion=5，sample.observationVersion=selection-v5，selection.arms含prebuyLegacy及avoidConsecutivePressure；命中时paper_prebuy_filter应为reject并含consecutivePressure。quality.json的selectionValidation及researchRecovery会保留新旧分组；不修改COS定时器、模型、1 SOL配置或退出参数。没有自然命中不算部署失败。

离线入场回放现在统一使用当前四项过滤；旧归档缺少新特征时按未知跳过，因此不能把新版回放计数直接与旧版报告比较。旧归档原始标签不重写。


## 入场时机研究 v1

`SHADOW_ENTRY_COMPARISONS=true` 默认启用，运行于原观察工作线程。只接收现有 Helius 交易流，不新增订阅或 RPC；不改变纸面/实盘入场、1 SOL金额、20%止盈、25%止损或模型。关闭此配置只关闭本研究。

同一候选建立三个独立研究持仓：

| variant | 入场条件 |
|---|---|
| immediate | 原研究规则，信号后等 SHADOW_ENTRY_DELAY_MS，再取首次合格报价 |
| confirm_buy_flow | 信号后至少500ms、至多3000ms；从当时已观察的最低价回升≥2%，且触发砸单后已有至少两笔买单 |
| confirm_two_buyers | 同上，但要求至少两个不同买家地址；不等于两位独立自然人 |

三个组都要求当前六项买前风险条件已知且通过：此前15秒买入金额占比≥20%、此前60秒收益≥−20%、砸单<40 SOL，且未命中连续卖出压力或前5秒买入占比≥80%过滤、已知迁移AGE不在[30,120)分钟，并要求候选新鲜、流连续。排除/历史未知记 skipped，不改变当前纸面引擎对历史未知的处理。不能直接把本研究的入场数与整个纸面引擎成交数相比。

低点只使用当前已经看到的价格，初值为触发砸单后的价格，不看未来最低点；买单和买家从触发后的下一条去重行情开始计数。两笔买单可以来自同一地址，两个买家组单独验证身份。零碎小买单也会计数，本版未声称能排除刷量或关联钱包。

确认组确认后还要等待原500ms执行延迟（取运行配置），之后按当时储备重新估算1 SOL买到的数量，不能在确认价即时成交。入场报价截止为确认时刻+原 entryDeadlineMs，默认2500ms；因此3000ms是确认截止而非成交截止。持仓计时、最高价、止盈/止损/移动止盈从各自实际研究入场重新计算，卖出仍等待原退出延迟。费用与滑点保持原研究假设。

窗口内没有确认记 not_entered；身份缺失无法确认、入场超时、断流、过期行情、池观察缺口、容量不足和退出无法估价记 censored。已入场后未知不记0、不记亏损，也不丢掉。新研究暂不使用账户状态恢复报价，避免将间断估值混入连续结果；重启会结束现有研究，不跨重启恢复。

每组发出 `entry_comparison`，阶段为 started / confirmed / entered / finished；每条包含原候选id、candidateAt、variant、版本和原policyId。entered/finished保留真实观察的入场时间、报价拆分；完成退出包含入场和退出成本拆分。研究仍是候选级估计，未模拟组合资金/20仓位约束和真实成交失败率。

容量独立受 SHADOW_MAX_ACTIVE（最多1000候选）和 SHADOW_MAX_ACTIVE_PER_POOL（最多100候选）约束，不占用原样本的容量计数。持仓期间可能延长该池的本地观察日志；不增加 Helius 数据请求。买家公钥只在需要身份确认的3秒窗口内随买单的 pool_observation 记录，包含 buyerIdentityVersion=1；计数集合最多保存两个地址。

### 更新后核对

1. session 中 `entryResearchVersion=1`，entryVariants 包含上述三组，entryRules为500ms/3000ms/2%/两笔。
2. shadow_health.entryComparisons.version=1；candidates、entered等计数随符合条件行情增长。未命中不应伪造成交。
3. 运行至少15分钟后手动导出：quality.json 的 `audit.entryComparisons.groups` 分别显示入场、已知收益、未入场、排除、未知和待完成，paired只配对同候选同版本同policy且都有已知结果的两组。
4. 明早COS自动归档包含新记录，无需修改上传计时器。对照收益必须同时报告未知和未入场比例，不能只比较已知收益合计。
5. 双模型状态应仍正常；原outcome、execution_comparison和退出研究版本不变。上线依据是更新后的新窗口，不用看过的历史数据重新挑选参数。

### 旧归档回放

```bash
node helius/scripts/replay-entry-research.js /绝对路径/导出目录 /绝对路径/entry-replay.json
# 可选：追加两个ISO时间，只分析归档内的指定候选窗口
node helius/scripts/replay-entry-research.js /绝对路径/导出目录 /绝对路径/entry-replay-night.json 2026-09-09T15:05:06.035Z 2026-09-09T23:00:00Z
```

脚本检查压缩包大小和SHA256，流式读取，解压限额4GiB/最多10万个候选，拒绝覆盖已有结果文件。需要项目依赖已安装。使用原记录中的策略费用、延迟和买前特征，结果另存，不改原数据。旧pool_observation缺少买家地址，不能验证两个不同买家组；有买单但身份缺失的样本保持未知。

回放只看到选择性保存的行情，定时器节奏也只能近似，原对照结果可能与原始outcome略有差异。报告不能称为完整市场回测或真实成交模拟；不新增网络报价，也不补造缺口或身份。结果包含逐候选数据和配对汇总，便于检查总收益改善究竟来自少买、样本删失还是同笔交易的改善。

本次更新保留 paper_spot_v1 账面收益，新增 execution_comparison v1，将现有 shadow 的延迟成交、恒定乘积冲击、费用和滑点假设显式输出为入场成本、退出到账估计、净 SOL 收益，并通过 key 与实际 paper 记录配对。原始 outcome 标签定义不变，旧模型和旧训练数据仍可按原 policyId 使用；新的对照规则另有 experimentId，不混淆版本。它是可观察行情下的估计，不能替代真实成交。

默认候选对照规则：砸单小于 40 SOL；触发前至少连续三笔卖出且 15 秒卖出 SOL 大于买入 SOL 两倍时排除；记录到该币实际 paper 亏损或实盘确认亏损后 10 分钟内排除；另记录三者组合。它们仅产生日志，不改变引擎买卖。连续卖压只使用触发前历史，不能看到未来同 slot 砸单后追溯拒绝原买入。重启/断流后亏损历史不完整，冷却实验先记未知，完整等待冷却窗口后才允许记通过；旧记录不回填新规则。

这些是候选筛选对照，未独立重演各策略钱包容量、资金占用和冷却状态；累计 proxy 收益不能当作各策略真实账户收益。quality.json.executionComparisons 会区分规则通过、排除、未知及观察删失；paperProxyPairs 只比较可关联且有结果的子集，两个口径的入场/退出时间可能不同。

## AGE：毕业迁移后的时间

AGE 唯一定义是自 Pump 毕业迁移到 PumpSwap 起经过的时间，不是代币创建时间，也不是普通池创建时间。

程序核对 Pump 官方 CompletePumpAmmMigrationEvent 与同笔 migrate 指令中的 mint、pool、PumpSwap 程序及 WSOL 账户，记录 migrationAt 和候选时 migrationAgeMs。来源定义：[Pump 官方 IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json)。既有 Helius PumpSwap 交易流中包含目标程序的迁移交易可被识别，不增加 RPC，不新增订阅。

事件来自 processed 行情，尚未 finalized 核验，明确标记 observed_processed_not_finalized。普通 CreatePoolEvent 不计作毕业迁移。没有采到迁移事件、证据冲突或时间异常时年龄为 null；不以程序首次观察时间代替，也不自动发请求回查老币。缓存 migration-age-cache.json 最多 20,000 池，工作线程每分钟及正常退出时保存；异常退出可能丢失最近一分钟缓存。旧数据没有这些字段，不能补造。

quality.json 的 audit.migrationAge 按策略和迁移年龄分组：未知、0–5分、5–15分、15–30分、30–60分、1–4小时、4小时以上。分别统计候选、60秒可观察结果、反弹正标签与至少50% proxy 回撤；严重回撤不等于已确认 RUG。AGE 暂不加入旧模型特征向量、不拦截买单，避免破坏模型兼容性。代币创建时间明确留空。

## 模型只观察部署

先更新服务器代码。在服务器放好此前下载的 strategy_proxy.experimental-model.json，然后在项目根目录执行：

```bash
node helius/scripts/prepare-observation-model.js /绝对路径/strategy_proxy.experimental-model.json
```

脚本检查验证结果和当前策略指纹，将文件复制到 helius/data/models/ 唯一文件，并把独立观察起点设为准备时刻及已有截止时间的较晚者。输出 SHADOW_MODEL_FILE 配置；将这行写入 helius/.env，随后：

```bash
sudo systemctl restart dump-sniper
sudo journalctl -u dump-sniper -n 30 --no-pager
```

观察线程会记录模型状态与预测；失败、配置不匹配或无历史时概率为空。该脚本不替你修改 .env、不启动实盘，不删除已有模型。模型仅在进程启动时加载，因此本次引擎/线程修改需要一次重启，和此前仅更新导出脚本不同。重启后 paper 持仓按已有状态恢复，短时历史重新积累。服务器配置和模型文件尚未由本地助手部署。

## 止损诊断

paper_sell、sell_submitted、确认记录增加诊断：首次触发时间、原因与价格、上一价格时间、行情事件时间/接收时间、处理时间、slot、受钱包锁等阻塞次数，以及执行/提交耗时。stream 和确认 RPC 轮询分开标记；事件时间精度不是微秒级测量。首次触发保留到卖出用于定位等待，最终卖出原因可能不同。paper 卖出记录仍是即时账面模拟，不能当作实盘测速。

## 性能与归档

模型、基于交易流的对照与年龄缓存都在原观察线程运行，复用行情。账户状态补报价另有请求预算，见 exitResearchVersion=2 章节。买入路径不等待模型、年龄查询或实验结果。每个策略目标多一条 comparison 日志，增加本地磁盘和归档体积；年龄缓存写盘也共享机器资源。日报及小时归档自动包含这些记录，不需要改变 COS 定时器。99 项本地测试通过，包括迁移事件及指令联合认证、未知年龄、时序隔离、观察缺失、对照版本、钱包阻塞诊断及归档分组。

## 2026-09-08：迁移诊断与执行差额拆分

迁移解析同时支持 CPI 事件和带完整运行调用栈的 Program data 事件；只接受成功的 Pump 调用帧，并再次核对 migrate 指令、代币、目标池和 WSOL。嵌套其他程序伪造数据、失败/截断调用帧、仅有事件没有匹配指令都不接受。同笔 CPI 与日志重复事件去重。只修复已知的解析覆盖缺口，不声称已用服务器真实迁移证明 AGE 恢复。

quality.json 的 audit.migrationPipeline 包含最新的进程累计计数与记录时间：parser 为 Pump交易、迁移指令、CPI/日志完成事件、解码失败、账户不符和匹配成功；worker 为收到/恢复/拒绝/淘汰的迁移证据、缓存池数及候选已知/未知年龄；cacheStatus 区分缺失、载入、读写失败。不同进程计数会重置，不能直接将不同快照相加。候选 unknownReason 区分未缓存、证据冲突、币不符和证据时间晚于候选。主进程每次启动最多保留20条迁移诊断样本，包含计数、签名、日志可用性及账户不符时的逐字段比较，不保存原始交易或密钥。

短窗口检查路径：

- parser 无迁移指令：该窗口没有识别到支持的迁移指令，需要核对订阅可见性/当前指令版本，不能仅凭零值断言没有新币。
- 有指令、没有匹配完成事件：查看 CPI/日志计数、解码/账户匹配错误和诊断签名。
- parser 匹配成功，worker 未接收：检查观察线程状态、队列丢弃和缓存拒绝计数。
- worker 缓存有值，候选 AGE 仍全未知：核对池/币匹配、是否确实交易了这些新迁移池；旧币没有历史补查仍应未知。
- cacheStatus 为读写失败：检查目录权限和磁盘。年龄缓存写失败不会单独使观察线程退出。

新归档增加 execution-audit.json：按 paper 平仓关联 proxy，区分没有对照、观察删失、旧记录缺拆分、已核平和拆分不符。新数据保存入场现价数量、恒定乘积报价、扣费后数量、滑点与取整后数量，以及退出各报价阶段。差额分为入场冲击、入场费用影响、入场滑点取整、退出冲击/费用/滑点、双边网络费用和剩余的时间/退出规则项。带符号拆分须与 proxy 净收益减 paper 毛收益核对，容差1e-8 SOL；这是一条核算等式，不是严格因果归因，时间项也可能包含头寸差异，费用均为模型假设。

旧归档只能核对最终收益和可用时间，不能反推出缺少的报价过程。单独审计命令：

```bash
node helius/scripts/audit-execution.js /归档目录
```

日报和即时导出均自动生成此文件；COS上传四个文件全部校验后推进游标。旧日报已上传的游标不会因此自动回退重传。增加本地扫描和磁盘开销，但不增加 Helius 请求，交易不等待归档。

服务器更新代码后重启交易服务一次，再执行 `node helius/scripts/export-recent.js --hours 0.25` 导出最近15分钟。检查 quality.json 的 migrationPipeline 与 execution-audit.json；如果15分钟内没有可核验的新迁移，不能宣称AGE已验证，继续观察或根据诊断签名核对真实交易。固定止盈20%、止损25%、单笔1 SOL等阈值保持原配置。
# AGE 历史交易取证（2026-09-08）

AGE 仍定义为 Pump 毕业迁移完成后的时间，不是代币创建时间。解析器支持官方 `migrate` 和 `migrate_v2`，均要求迁移指令与完成事件的 mint、pool、PumpSwap 程序和 SOL 报价账户一致。非 SOL 迁移不进入 AGE 缓存。

账户校验失败的 `migration_diagnostic` 现在包含事件字段、事件长度、传输方式和逐项比较结果；保留原有每进程最多 20 条签名诊断的限制。不增加常驻 RPC 请求。

在服务器的 `helius` 目录运行（不必停止服务）：

```sh
node scripts/diagnose-migration.js
```

默认读取本机 `.env` 的 Helius RPC，逐笔查询 2026-09-08 01:03 和 01:06 两笔已知失败签名，共两次 `getTransaction`，每次最多 20 秒，不自动重试。也可在命令后提供 1–3 个签名。输出路径显示在终端，文件为 `data/migration-diagnosis-*.json`。将该文件下载用于排查；它包含公开的 Pump 指令账户与指令数据，不包含 RPC URL 或密钥。请求失败会写入状态并返回非零退出码。

该工具只取证，不写 AGE 缓存，不回填旧训练样本。历史交易的当前查询结果也不能伪装成当时已经知道的信息。单元测试验证了格式和严格匹配；两笔真实交易的具体不匹配原因仍需服务器取证文件确认。官方格式来源：https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
# 2026-09-08：风险、收益训练及退出观察对照

本次不更改买卖参数，不让模型决定订单。模型评分与基于交易流的对照在观察线程运行，复用已有行情；账户状态补报价另有请求预算。程序仍不自主训练或替换模型。

## 新训练目标

- `loss_25`：现有策略完成退出后，净损失达到入场成本的 25% 或以上的概率。不是 RUG 判定，也不是持有期间最大回撤概率。
- `net_return`：净收益 / 入场成本的回归估计。输出 `expectedNetReturn`（例如 0.02 表示 2%），不是 SOL 金额，不放入 probability 字段。
- 两者仅使用已观察的 `strategy_proxy`、有限的 `netPnlSol` 和正数 `entryCostSol`。旧记录缺金额、删失或未完成时不造标签。因此有效样本可能少于原有二分类目标。

仍按时间 60/20/20 切分、剔除跨区间标签。校准段和测试段均调用与运行时相同的 8 标准差过滤；拒绝数量写入 coverage，过滤后不足 100 条则不产出有效模型。分类还要求每类至少 20 条。测试和常数基线比较使用相同可评分子集。训练器不会按测试集收益寻找最优阈值。

净收益回归为标准化特征的正则线性回归，仅用训练段拟合、校准段校正偏差。测试 MSE 小于同子集基线仅表示实验统计门槛通过，不是盈利验证。报告同时列出固定阈值下的已知净收益与未知数量；单独反弹数据缺少金额时保留未知，不能将报告的空合计解读为保本。

在 helius 目录离线执行：

```sh
node scripts/train-shadow.js --data data/shadow --target loss_25 --out data/models/loss-25.json
node scripts/train-shadow.js --data data/shadow --target net_return --out data/models/net-return.json
```

多策略归档应显式添加 `--policy HASH`。训练输入是 `samples-*.jsonl`，不是压缩归档路径；先提取并按来源保留样本/标签、去重。训练耗 CPU，应在分析机器运行，避免挤占交易服务器资源。报告为输出模型路径加 `.report.json`；验证失败的模型会被运行时拒绝；样本不足时会清除同一输出路径上的旧模型，以免误用。

需要观察时，先用 `node scripts/prepare-observation-model.js MODEL.json` 检查配置和验证结果，并把输出的 setting 写入服务器 .env：

```dotenv
# 以下是可选模型路径；发行包不包含训练模型。
# SHADOW_RISK_MODEL_FILE=data/models/loss-25.json
# SHADOW_RETURN_MODEL_FILE=data/models/net-return.json
SHADOW_EXIT_COMPARISONS=true
```

准备工具会将观察起点设为准备时刻和模型已用标签截止时间的较晚者。模型不热更新，需正常重启服务读取配置；模型无效、目标错误、历史不足或分布外时不给评分。sample / execution_comparison 新增 `objectivePredictions.loss25`、`objectivePredictions.netReturn`；shadow_health 提供两个模型状态。未配置时如实显示 no_model。

## 原四组固定退出对照（新增30%/50%组见文末）

所有对照共享原策略的模拟入场金额、时间与成本：

1. `exit_250ms`：原退出触发逻辑，等待至少 250ms 后的第一条可见行情估算退出。
2. `exit_1000ms`：原退出触发逻辑，等待至少 1000ms。
3. `net_take5`：估计净收益达到 5% 时增加提前止盈触发，退出延迟沿用 SHADOW_EXIT_DELAY_MS；保留原止损、追踪和超时退出逻辑。
4. `no_fixed_stop`：仅禁用固定价格止损，保留原止盈、追踪和 maxHoldMs（默认30分钟），沿用原退出延迟与成本。独立于 paper/live 订单执行，原止损参数不变。

新对照对所有已模拟入场候选采集，后续按候选买前特征或事先冻结的反弹评分分组；不能按未来是否反弹挑选样本。记录 entryCostSol、minNetPct/maxNetPct（观察持有期间相对入场成本的最低/最高净收益，非峰谷最大回撤）、firstFixedStopAt（首次触及原价格止损线）。评估时按同一候选配对原策略，统计原止损后改善/恶化、最终收益、深亏、持仓时间及缺失比例；未卖出、断流、不可报价不算回本。

这条新方案可能延长观察并占用采集容量，尤其是不再止损后长期无反弹的样本。最长持仓只触发退出意图，须等待延迟后的可见报价；缺报价仍为删失，不能把最后价格当作强制成交。不会补出旧版本已经停止采集的后续走势。

触发时价格不能当成交价，没有及时可见行情则删失。对照属于 `exit_comparison` 独立记录，不改 strategy_proxy 的定义或 policyId。quality.json 的 `audit.exitComparisons` 按策略、版本、方案聚合已完成记录，并提供与同一候选原策略配对的差额；尚未完成的方案不在完成合计内。不能比较不同样本集合的总额后声称收益改善。

对照可能延长观察至原 maxHoldMs，在现有 active/每池上限内运行；增加观察线程计算、日志和归档量，可能影响观察容量。关注 active、censored、queueDepth、dropped。可设 SHADOW_EXIT_COMPARISONS=false 关闭；不会改变真实交易参数。每日 COS 归档自动包含这些记录，无需调整 7 点定时器。

## 本次验证与实际数据试训

99 项测试通过，覆盖运行时一致过滤、收益单位、缺失金额拒绝、未来时间隔离、退出延迟、缺失对照、原标签不变及归档配对。本机 6400 条合成事件主线程入队 p95 约 0.0025ms，0 丢弃；不包含网络和观察线程计算，不能作为买入延迟承诺。

9 月 8 日 7 点归档试训：两个新目标各 1273 条有效记录。loss_25 测试 Brier 0.18894 / 常数基线 0.19184；net_return 测试 MSE 0.05809 / 基线 0.05878，MAE 反而较差（0.20150 / 0.19343）。改进很小，且固定正收益预测筛选的 25 条已知结果仍为 -0.4305 SOL，不证明可盈利。私人数据、报告、模型保留本地，不进入发行包或 GitHub。
# AGE 原生 SOL 报价兼容修复

Pump 官方 COIN_CREATION.md 说明：SOL 报价的 bonding_curve.quote_mint 使用 Pubkey::default()；指令账户仍使用 WSOL。2026-09-08 08:09 更新后的真实迁移诊断中，存在币、池、AMM、WSOL 指令账户全部匹配，但事件 quote_mint 为默认公钥的记录。解析器现接受该事件表示，同时仍要求同一迁移指令的报价账户严格为 WSOL，其余匹配条件不变。USDC 等报价仍拒绝。

新增累计计数 migration_native_sol_quote_matched。更新后应检查该计数或 migration_matched 增长、worker accepted/cachedPools 增长；只有随后涉及已缓存池的候选才会出现已知 AGE。不会将老样本 unknown 改成已知，也不会用代币创建时间或首次看到时间替代毕业迁移时间。

官方依据：https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md 。默认公钥在事件中的兼容依据还包括用户提供的真实诊断；测试覆盖 migrate/migrate_v2、默认事件报价、显式 WSOL、旧事件缺字段、账户不符和非 SOL 拒绝。服务器实际恢复需更新后观察新迁移确认。
# 固定组合筛选与自动验证报告

新增 selection-v1 观察版本：每个候选产生固定的 baseline、market、risk、net、combined 五组结果。baseline 检查信号新鲜度；market 再检查现有卖单上限和持续卖压；risk 要求 loss_25 概率 <0.25；net 要求预期净收益率 >0；combined 同时满足全部条件。这些是预先固定的研究阈值，不代表已优化参数，不控制 paper 或真实订单，也不增加 RPC。

`sample.selection` 和 `execution_comparison.selection` 保存筛选版本哈希、规则、市场过滤版本、风险与收益模型 ID、逐项检查和拒绝/未知原因。模型未加载、目标不符、分布外或历史不足时不将模型项标为通过。组合已有明确失败项时为 reject，其余缺失项仍保留在 unknown 列表；没有失败项但有缺失则为 unknown。

本次不自动安装或启用训练模型。服务器仍需按上面的准备模型流程分别配置 SHADOW_RISK_MODEL_FILE / SHADOW_RETURN_MODEL_FILE 并重启。未配置时市场对照可运行，模型组合会如实记录未知。

每日 COS 和手动导出的 `quality.json` 自动新增 `audit.selectionValidation`。无需更改上传定时器或文件清单。按以下字段隔离：runId、runStartedAt、observationVersion、policyId、selectionId、marketExperimentId 和 modelIds。runStartedAt 是本次观察进程启动时刻，不等于 Git 部署版本证明。

每组提供通过、拒绝、未知决策、已知收益、删失、待完成、大亏比例、胜率、每候选净收益和北京时间分小时统计。大亏定义为已知最终净损失占入场成本至少 25%。旧记录没有 selection 时计入 legacySamples，不按新规则事后补造选择结果。候选按归档时间窗归属；更新前上下文不混入新窗口。同一进程重复 chain key 去重，冲突样本剔除。

配对字段 baselinePairedSol / filteredPairedSol 仅使用决策已知且策略收益已知的同一批候选：通过者保留原收益，拒绝者作为未下单、收益为零；pairedDifferenceSol 为两者差额。此处是固定过滤的候选级反事实对照，不模拟资金、并发持仓、后续信号变化或实际成交。必须同时看 meanSelectedNetSol、selectedMissingRate 和 severeLossRate，不能仅以少交易后的总亏损减少认定有效。完全没有已知收益时 selectedNetSol 为 null。

报告不自动批准实盘，不在线搜索阈值、不改模型。完整测试覆盖缺模型未知、严格边界、版本分组、同候选配对、缺失结果、重复冲突和旧窗口隔离。

## 双评分跨时段观察（selection-v2）

新增训练目标 drawdown_60s_25：从完整 rebound_60s 结果的 minNetPct <= -25 派生；缺失、删失、观察不足60秒不填标签。该目标与 loss_25（策略最终平仓净亏损25%）不同。

训练命令：

~~~bash
node helius/scripts/train-shadow.js --data helius/data/shadow --target rebound_60s --out helius/data/models/rebound60.json
node helius/scripts/train-shadow.js --data helius/data/shadow --target drawdown_60s_25 --out helius/data/models/drawdown60.json
node helius/scripts/prepare-observation-model.js helius/data/models/rebound60.json
node helius/scripts/prepare-observation-model.js helius/data/models/drawdown60.json
~~~

准备工具验证策略口径、模型验证结果，并把观察起点移至准备时刻之后；按输出分别设置 SHADOW_MODEL_FILE 与 SHADOW_DRAWDOWN_MODEL_FILE。模型可用后重启才加载。模型属于私有运行文件，不进入Git或公共发行包；只更新代码不能自动得到训练好的评分。旧模型不匹配、缺失或超训练范围时明确unknown，不允许按低风险放行。

固定观察组 joint：新鲜候选、rebound_60s概率>=0.60且drawdown_60s_25概率<0.25。highRebound：新鲜候选、rebound_60s概率>=0.80，用于检查高反弹组的无固定止损对照。不叠加旧combined组的金额/流量/净收益限制；各组定义独立，避免混淆实验。所有筛选仅写盘，不改变引擎下单、仓位或买卖阈值。

sample / execution_comparison 记录 objectivePredictions.drawdown60；原prediction提供反弹评分。selection.version=2、observationVersion=selection-v2，记录两模型ID和固定规则。exit_comparison带买前selection，不能用事后涨跌挑样本。shadow_health.drawdownModel与session.drawdownModelStatus可核查是否已加载。

quality.json 的 audit.selectionValidation.groups 每组新增 reboundBySelection（完整60秒的反弹/大跌/两者都发生/未知），exitsBySelection（同候选原策略与退出对照的配对收益、差额、50%深亏、未配对数）。按运行、策略、规则及模型ID分组，兼容旧v1。无完整配对时金额为null，不把缺失结果当作0收益或回本。归档出口自动包含新字段，无需调整北京时间7点的定时任务。

## 间断后的独立长期观察（recoveryVersion=1）

开启SHADOW_EXIT_COMPARISONS时，已有模拟入场且no_fixed_stop尚未完成的样本，在池行情间隔、旧行情、无法报价、断流或队列覆盖中断时，可进入独立恢复观察。原strategy_proxy、反弹标签与exit_comparison仍按原规则删失，不改成成功；恢复记录为no_stop_recovery，coverage=discontinuous，不供原训练目标使用。

记录阶段started、first_quote、finished；后续可报价退出为discontinuous_proxy，到期仍无可报价退出、容量不足或停机为unknown，净收益为空。首次恢复报价可核对距间隔多久；minObservedNetPct/maxObservedNetPct仅是恢复后可见报价极值，不代表缺口内完整轨迹。保留缺口前已触发的退出意图，否则按后续可见报价触发止盈/追踪或按原入场时间触发最长持仓退出；无法知道缺口中是否曾触发条件，因此必须独立统计。

到原maxHoldMs（默认30分钟）后，最多再等exitDelayMs+maxGapMs（默认500ms+10秒）的真实报价；到期没有报价则结束为unknown，不能用旧价强平。恢复池独立使用SHADOW_MAX_ACTIVE及SHADOW_MAX_ACTIVE_PER_POOL容量上限，不挤掉原活动样本，但最多增加同规模的研究状态，可能增加工作线程内存、CPU及行情日志；不增加Helius请求。关注shadow_health.recovery的active、capacity、expired、completed。进程重启不恢复旧研究持仓，正常关闭明确记录unknown。

quality.json新增audit.noStopRecovery，按运行、策略、筛选及模型ID分别统计all/joint/highRebound的间断报价结果、未知以及同候选原策略配对金额。该汇总按恢复结束时间窗口统计，与按候选时间统计的selectionValidation不能混加，也不能与完整退出样本混作胜率。audit.modelPredictions报告模型缺失/历史不足/异常范围的数量；缺失模型时输出明确提示。COS归档增加第二模型及其他已配置观察模型快照。

## 一次安装两个模型并检查

先将私有模型包解压到服务器的一个目录，再在实际部署目录执行（以下使用绝对路径，按模型存放处修改）：

~~~bash
node /opt/dump-sniper/helius/scripts/install-observation-models.js /path/to/rebound60.json /path/to/drawdown60.json /opt/dump-sniper/helius/.env
node /opt/dump-sniper/helius/scripts/install-observation-models.js --check /opt/dump-sniper/helius/.env
sudo systemctl restart dump-sniper
~~~

安装前同时验证两个目标、策略口径、离线验证结果；验证失败不修改.env。成功后写入私有模型副本，观察起点移到安装时刻之后，备份.env并仅更新两项模型路径，去除它们的重复配置，不改金额、密钥、止盈止损。备份包含密钥，应只保留在服务器受限目录。检查非成功状态返回非零退出码。配置检查只能证明文件可加载；重启后还需在session中核对modelStatus及drawdownModelStatus都为experimental_calibrated_model、noStopRecoveryVersion=1。

## 提高止盈与账户状态补报价（exitResearchVersion=2）

本次不修改订单引擎、固定模型、1 SOL配置或原训练标签。固定止盈按价格涨幅触发，最终收益按原曲线冲击、费率、滑点及网络费假设估算，不把30%价格涨幅当作30%净利润。

新增四个连续观察对照：take30、take50、take30_no_stop、take50_no_stop。前两组保留原固定止损，后两组取消固定止损；所有组共享原模拟入场、保留原移动止盈和最长持仓。默认仍为涨幅10%启动移动止盈、从最高价回落3%退出，因此可能在达到30%/50%之前退出。原基准与no_fixed_stop提供默认20%的两组参照，其他250ms/1000ms/net_take5研究继续保留。仅新增本地研究状态，不发订单。

未知结果不代表没有流动性或必然归零。连续研究仍在超过SHADOW_MAX_OBSERVATION_GAP_MS（默认10秒）没有有效池子事件时删失；没有及时入场的样本不补造买入。新增两个独立分支：
- exit_recovery：对其他尚未完成的退出组以及尚未完成的基准，等待恢复后的真实交易事件；no_fixed_stop原有no_stop_recovery分支继续独立。
- state_exit_recovery：对所有尚未完成退出组和基准，独立使用Helius账户状态估价。它不会与交易事件恢复分支合并，也不会覆盖原outcome/exit_comparison。两分支可能涵盖同一个样本，金额不能相加。

所有恢复分支都保留coverage=discontinuous。缺口前已触发的退出意图保留；否则只根据缺口后的可见报价判断退出。缺口内是否曾触发止盈/移动止盈仍未知。账户估价结果status=account_state_proxy，恢复成交事件结果status=discontinuous_proxy，均不是实盘成交或连续价格路径。最长持仓后仅再等该组退出延迟加maxGapMs，超过期限、容量不足或停机仍为unknown，不用旧价强平，也不无限延长亏损观察。

配置（默认开启，无需手动新增到旧.env才生效）：

~~~dotenv
SHADOW_STATE_QUOTES=true
SHADOW_STATE_QUOTE_REQUESTS_PER_MINUTE=10
SHADOW_STATE_QUOTE_INTERVAL_MS=15000
~~~

SHADOW_EXIT_COMPARISONS=false或SHADOW_ENABLED=false时不会发起这类查询。SHADOW_STATE_QUOTES=false仅关闭账户状态研究，保留基于交易流的对照。恢复状态按每个分支的SHADOW_MAX_ACTIVE/SHADOW_MAX_ACTIVE_PER_POOL约束：原no_stop_recovery每样本一项，新增两分支按每个样本的每个退出组计一项；容量不足明确记录unknown。关注capacity，不能忽略被容量筛掉的样本。

后台查询不进入买入等待链路，不对全网池子轮询。只有已模拟入场且仍有账户恢复研究的池子会请求；同池不同样本和退出组共用一次快照。每批最多20池、80个账户，读取池子、base mint、两个金库，在同一confirmed上下文核对身份、代币程序、金库归属、冻结状态和储备；读取当前virtualQuoteReserves，不沿用中断前储备。带minContextSlot拒绝旧状态。不支持的扩展、无效账户、空储备明确返回不可估价，不能当作已确认无法卖出。

请求为独立异步服务，单并发，3秒超时；普通查询每池成功后间隔15秒，失败指数退避至最多120秒。schedulingVersion=2优先处理到期退出，允许新到期退出越过一次旧轮询等待，但仍遵守滚动分钟总预算，详见末尾说明。每分钟10次意味着满负荷最多14,400次/24小时；实际请求量取决于活跃恢复池，不能保证为零，也不是credits数量。健康日志rpcRequests包括这些请求；shadow_health.stateQuotes单独显示requests/queriedPools/quotedPools/failedPools/budgetSkips。账户研究只使用现有Helius RPC，不新增Birdeye或DEX Screener依赖。

轮询的实际退出延迟可能是数秒或更久，不能当成500ms成交。快照必须在退出等待期限之后发起才能用作退出估价。超过3秒的响应/工作队列交付、比已知流事件slot更旧的结果不会使用。记录state_quote中的requestAt、at、latencyMs、slot、原始储备、失败原因与discardReason；恢复记录带variant、assumptions、quoteSource、quoteSlot、quoteRequestAt、actualExitDelayMs、gapReason。SDK费率仍使用研究配置假设，快照估价不保证交易可执行。

每日COS模板自动包含新记录，无需改7点定时器。quality.json新增：
- audit.stateQuotes：取得报价、无法报价、原因及丢弃原因。
- audit.researchRecovery：按运行/策略/模型/退出组/来源分开统计all、joint、highRebound，含已取得估价、未知原因、待完成和与完整基准的同候选配对；另外用pairedWithSourceBaseline及sourceDifferenceSol记录同来源恢复基准的配对，两个配对口径不能混加。以窗口内最新恢复活动记录为口径，非候选窗口总量。
- audit.selectionValidation.exitsBySelection：增加四个止盈对照，仍只用连续、同候选、同策略的完整配对；pending和未知不填零。

原audit.noStopRecovery与连续audit.exitComparisons保持各自口径。研究分支不进入模型训练，不自动提高止盈、不取消真实止损。

更新后按现有部署步骤重启，保留.env/data及现有模型，无需重新安装模型。先导出15分钟窗口检查：
1. session.exitResearchVersion=2，stateQuoteVersion=1，exitVariants含take30/take50及其no_stop版本；双模型仍正常加载。
2. 发生行情缺口后出现state_quote与state_exit_recovery记录。短窗口没有缺口时零请求是正常的，不应为了验证而主动全网查询。
3. 核对shadow_health.stateQuotes请求量、失败原因、各恢复capacity/expired和quality.json独立分组；原交易金额和止盈止损配置保持不变。

### Token-2022补报价兼容修复（validationVersion=2）

账户状态补报价不再以mint必须82字节、金库必须165字节一刀切拒绝。对Token-2022逐项解析TLV，当前只放行mint的MetadataPointer、TokenMetadata及金库的ImmutableOwner；它们分别用于元数据信息、固定账户所有者，不改变本研究按原始数量计算的曲线金额。依据：[Solana元数据扩展](https://solana.com/docs/tokens/extensions/metadata)、[ImmutableOwner](https://solana.com/docs/tokens/extensions/immutable-owner)。不请求元数据URI，不保存名称、描述或元数据原文。

转账税、转账钩子、永久代理、不可转账、暂停及其他未列入允许清单的扩展继续拒绝，哪怕同时带有元数据扩展。还会拒绝长度越界、重复TLV、错误账户类型、无效元数据结构及旧Token程序上伪装的扩展。原池子身份、程序所有权、金库归属、冻结、储备、新鲜度和预算检查继续保留。本修复只支持研究估价，订单执行器的扩展限制保持原样，不能据此认为实盘已支持这些币。

state_quote新增validationVersion=2和accountDiagnostics：包含baseMint/baseVault/quoteVault的地址、程序所有者、字节长度、扩展类型编号/名称/长度、拒绝类型及原因。成功和扩展拒绝都会记录诊断；RPC超时/缺账户时可能没有扩展诊断。quality.json的audit.stateQuotes.extensionRejections按账户角色和扩展类型汇总，结构错误按角色和原因汇总。数据自动进入现有COS模板，无需修改定时器。

部署后先看shadow_health.stateQuotes.validationVersion=2；再检查至少一条status=quoted、账户检查通过的state_quote及其后续state_exit_recovery。现有5次失败并不能证明服务器实际遇到的扩展都是允许类型，本地测试通过也不等于服务器真实报价已验证。请求预算不变，失败首次默认等待30秒，连续失败等待60秒、120秒后封顶（15秒是成功查询间隔，非首次失败间隔）。

### 买入后3秒内+8%快速止盈对照（exitResearchVersion=3）

新增 take8_first3s，当前共9个退出对照。以模拟实际入场proxy_entry时间开始计时，0至3000ms（包含边界）内，观察价格相对原模拟入场价上涨至少8%，触发quick_take_profit。8%沿用固定止盈的价格口径，不是保证净赚8%。触发后仍等待原退出延迟（默认500ms）及有效报价，按真实观察到的估价扣除研究成本；实际结果可能低于8%甚至亏损。

超过3秒未触发，不强平、不延长快速止盈窗口，继续原20%固定止盈、25%固定止损、10%启动/回落3%移动止盈和最长持仓规则。正常止损在前3秒也有效。这是单独的研究组，不叠加取消止损，不修改订单引擎或模型。

行情缺口不补造触发。缺口前已触发的快速退出意图会在独立恢复分支保留，之后的有效报价可以晚于3秒；缺口后的首次可见报价若已超过3秒，不能回填成快速止盈。连续标签和间断估价仍分开，费用、延迟、预算及数据源规则不变。

COS与quality.json的退出分组自动包含take8_first3s。assumptions记录quickTakePct=8、quickWindowMs=3000、quickTakeBasis=price_from_proxy_entry。部署重启后核对session.exitResearchVersion=3、exitVariants含take8_first3s；按买前评分组比较同候选配对净收益，同时检查触发数、延迟和缺失比例。

### 到期补报价与买入前过滤研究（2026-09-09）

session新增stateQuoteSchedulingVersion=2、selectionVersion=3；exitResearchVersion仍为3，退出组仍为9个。保留当前1 SOL配置、20%固定止盈、25%固定止损及模型，未把过滤条件接入订单引擎。

**补报价调度**：每个活跃恢复池携带各研究持仓的退出dueAt和expiresAt。已经到期的退出优先，其次按较久未查询顺序；同池共用快照。未来15秒内存在退出时，普通查询为它预留滚动分钟预算的最后一次请求。到期后如果此前请求早于该退出dueAt，允许一次新请求跳过旧的成功间隔或失败退避，至少与上次响应间隔1秒。到期请求失败后不会每秒重试；新到期意图可再获得一次尝试，始终受原总预算限制。预算已耗尽时仍可能无法报价，不能保证未知结果归零。

不延长持仓截止，不用提前请求的旧快照作为延迟退出成交，不合并不同报价来源，不修改原连续训练标签。独立后台请求不加入买入等待链路，原最多20池/80账户、单并发、3秒时效检查继续生效。

新增诊断：state_quote.scheduling含urgent/deadlineOverride/expiresAt，rpcDiagnostic只保存固定错误类别、数值RPC code或HTTP状态；不记录错误原文、请求地址或密钥。最小上下文slot未满足（-32016）单独标记minimum_context_slot。shadow_health.stateQuotes新增schedulingVersion、reservedBudgetSkips、backoffSkips、urgentPools、deadlineOverrides、rpcErrors。跳过计数按轮询轮次或池次，不是交易数；health的rpcErrors是请求批次，quality.json的rpcDiagnosticCategories/rpcCodes是池级结果数，不能混用分母。

**固定买前过滤组**（selection.version=3，规则ID独立于旧版）：

| 研究组 | 保留条件 |
|---|---|
| avoidWeakBuy | 砸单前15秒买入SOL金额占买卖总金额至少20% |
| avoidPriorFall | 砸单前60秒价格变化至少-20% |
| avoidLargeDump | 本次砸单严格小于40 SOL |
| prebuyCombined | 同时满足以上三项 |

使用砸单前特征，不把本次砸单加入历史买卖占比。所有组要求候选新鲜；历史不足、前15秒无买卖额、前60秒不足两次交易等相应条件记unknown，不用默认值判通过。砸单大小本身可在历史不足时单独判断。缺失记录不当失败或零收益；各过滤组重叠，不能相加收益。旧selection版本继续可分析，并按运行、规则ID、模型分组隔离。

四组自动进入quality.json的audit.selectionValidation（含退出配对、反弹/大跌标签和缺失率）以及audit.researchRecovery的独立来源分组。无需更改COS定时器或重新安装模型。

部署后保留.env/data及模型，按原安装步骤重启。15分钟后导出核对：

1. session.selectionVersion=3、stateQuoteSchedulingVersion=2；样本selection.arms含上述四组。
2. shadow_health.stateQuotes.schedulingVersion=2；请求滚动一分钟不超过配置上限。已有到期恢复时查看urgent、deadlineOverride和实际quoteRequestAt；无到期样本时计数为0是正常情况。
3. quality.json新增过滤分组与补报价诊断；如有RPC失败，检查category/code而不是把全部失败认定为超时。
4. 对比未知率时按新进程窗口、同来源和同规则统计，并同时检查成功补回的亏损。部署验证不能仅凭出现一次成功报价就认定采集完整。

### 模拟买入直接过滤（PAPER_PREBUY_FILTER=true）

在上述研究基础上，纸面订单现在默认启用三项过滤：前15秒买入金额占比<20%、前60秒价格变化<-20%、砸单≥40 SOL。任一已知条件命中就跳过，不占模拟持仓、每分钟准备名额或同币冷却。等于20%买盘、恰好下跌20%不触发；恰好40 SOL触发。

所有候选仍进入原后台观察，保留反事实结果以检查误过滤；不会为被拦截候选建立纸面仓位。历史不足或无有效历史成交时，相应特征明确记unknown，不视为危险命中；其他已知危险条件仍可拒绝。因而纸面执行是“拒绝已知危险”，比要求所有条件都已知且通过的prebuyCombined研究组更宽松，二者收益不能直接当成同一口径。

复用后台同一份砸单前快照，不增加API请求和主线程历史计算。纸面模式最多等待后台250ms；判断不可用、线程故障或超时跳过本次，记prebuy_filter_unavailable，不能伪装成特征安全。返回后重新核对信号时效和持仓/预算限制。砸单≥40 SOL可立即拦截。实盘模式不等待这个纸面过滤器，原实盘路径不变。

日志paper_prebuy_filter及shadow decision包含version=1、scope=paper_only、selectionId、status、rejected、unknown、waitMs和跳过reason；归档自动收录。纸面收益比较要注意新增后台等待和信号过期带来的样本差异，不能把所有差额归因于过滤本身。

现有.env未设置新字段时默认开启；设PAPER_PREBUY_FILTER=false可恢复原纸面入场。启用需要SHADOW_ENABLED=true和正常后台线程。重启后核对starting.strategyConfig.paperPrebuyFilter=true及DRY_RUN=true，再检查至少一条paper_prebuy_filter；已知危险候选应有prebuy_risk_filter跳过记录，后台sample仍保留。模型无需重装，退出规则与每笔1 SOL配置保持原样。

### slot追赶重试、历史未知对照和执行成本汇总

最新session标记selectionVersion=4、stateQuoteSchedulingVersion=3；退出研究仍为exitResearchVersion=3，9组退出参数不变。

仅对RPC -32016 / minimum_context_slot，前三次连续失败分别安排2、4、8秒后可重试；第四次及之后回到原普通指数退避。成功或其他错误会重置这一短重试序列。重试通过原poll调度，仍受每分钟预算、到期优先和预留限制，不是额外请求通道，不降低minContextSlot、不改变confirmed、不延长持仓截止。实际重试可能因预算耗尽延后或无法进行。

state_quote新增requestedMinContextSlot；RPC错误若含合法数值contextSlot则记录在rpcDiagnostic中，不保存data原文。scheduling新增retryKind（slot_catchup/ordinary）及nextEligibleAt。quality.json的slotCatchupScheduledPools统计安排短重试的池级结果，不能当成实际已执行重试批次。部署后比较-32016失败率、到期完成率及预算占用，不能只看请求量增加。

新增三个独立买前研究分组：

| 名称 | 规则 |
|---|---|
| prebuyAllowUnknown | 新鲜候选且无已知危险，允许历史未知 |
| prebuyRequireKnown | 三项均已知且通过；历史未知明确拒绝 |
| prebuyUnknownOnly | 只观察无已知危险但历史未知的子集 |

prebuyCombined保留原有三态语义，不修改纸面引擎的未知处理。新组是候选级对照，不模拟独立资金、持仓上限及冷却组合。未知“特征”可以按预设规则拒绝，未知“结果”仍不可填零；连续标签与账户恢复分开统计。quality.json的selectionValidation和researchRecovery自动包含新分组，旧版本可继续分析并按规则ID隔离。

execution-audit.json升级schema=2，保留原totals和rows，新增costSummary：汇总同一配对子集的paper/proxy收益、时机/退出规则差、曲线冲击、费用和滑点，分别按实际paper_prebuy_filter状态与策略ID分组。components仅包含reconciled行；与全部matched不是同一子集时分别给出数量及收益。缺少入场判断记unmatched，不推定为通过；未知对照不填零。另提供入场时差、过滤等待的p50/p95，这些不是链上成交速度或真实手续费。

无需新配置、无需重装模型或调整COS定时器。更新后先导出15分钟，核对session版本、新selection组以及execution-audit.json的costSummary；若窗口没有-32016错误，短重试计数为零是正常的。当前三项危险拦截、1 SOL金额、20%止盈和25%止损保持不变。

校准持仓配置可直接沿用旧calibration.json，修改上限不会重置batchId、attempts、lossSol或持仓。下调上限不会强卖已有仓位，只限制后续买入。20仓表示最多同时持有20个币，交易构建/发送与待确认核对仍串行；六项过滤、每分钟候选预算和冷却继续有效；总买入次数与累计亏损不再限制入场。钱包还需预留交易费、tip和开户押金，不能按余额除以0.05就认定可买满20仓。部署保留.env和账本，建议显式设置CALIBRATION_MAX_POSITIONS=20。

## executionExtensionsVersion=1：Token-2022执行兼容与统计

执行允许Mint的MetadataPointer、TokenMetadata，以及Token账户的ImmutableOwner；同时校验TLV结构、初始化状态、冻结权限和池子/钱包账户身份。买入和卖出都检查Mint、两个池子vault及已有用户账户，关闭账户只允许已管理、余额为零且扩展合规的账户。TransferFee、TransferHook、PermanentDelegate、MemoTransfer和未知扩展继续拒绝，不从拒绝错误推断代币存在恶意。不会增加RPC请求、放宽六项过滤或改变预算。

execution_token_extensions记录version=1、side、sourceSignature、pool、账户role、扩展编号/名称和拒绝原因，不保存元数据正文。execution_account_read_failed/recovered也携带来源信号，可按来源信号+池子去重；旧记录缺少标识时不能重建。execution-audit.json新增executionFunnel：窗口回执按交易签名去重，失败候选按信号去重，扩展类型分组可重叠，不能相加当作完整漏斗。batchSnapshots使用导出时账本全批次计数，不与窗口成交数混比；confirmedBuysInLedger大于attempts标记count_mismatch，需进一步查账，程序不会自动重置或修正额度。

部署保留.env、calibration.json和现有模型。先核对允许/拒绝扩展诊断，再核对真实买卖回执与账户回收；本地真实SDK构建和签名测试不等于链上成交保证。首笔测试按唯一交易签名核对，不能同时把buy_confirmed与calibration_receipt算两笔。

## liveEntryGuardVersion=1：历史不足和准备期间继续下跌

仅LIVE_CALIBRATION=true的新买入生效：priorBuy、priorReturn、consecutivePressure、priorBuyBurst任一unknown即以prebuy_history_required拒绝，不能只等全局启动N秒；每个池子都须满足原history.ready条件（至少60秒可用历史、默认至少10笔及有效特征）。AGE单独unknown仍允许；已有明确风险仍拒绝。纸面及shadow原始研究分组不变，分析实际入场须结合主引擎decision。

继续下跌保护以本次触发砸单后的池价为基准，不是买入均价或前60秒起点。等待过滤和构建期间监听同池、同币、非旧slot的后续行情；一旦下跌达到20%即锁定取消，不因随后反弹重新放行。构建返回的现有RPC账户状态也必须有有效池价，并检查同一20%阈值。发送前取消，尚未提交的签名不登记pending、不增加attempts；行情恶化发生在准备阶段时，原准备名额/冷却可能已经使用。既有已提交交易仍按原签名核对，不能撤回或重建。

不增加API请求、不额外等待；20%为本轮防守阈值，不是已证明盈利的最优值。此保护不能发现尚未到达的行情，也不保证防止发送后的暴跌。卖出、25%止损、30分钟退出及此前失败回执修复不受影响。部署保留.env和账本，无新增必填环境变量；启动核对liveEntryGuardVersion=1和liveEntryMaxFurtherDropPct=20。检查calibration_prebuy_filter.reason=prebuy_history_required及live_entry_cancelled；每日execution-audit.executionFunnel分别去重统计历史拒绝和发送前取消。
# 卖出重试与流量归因部署核对

本版新增 `exitRetryVersion=1`、`streamTrafficVersion=2`。先完成既有测试和部署步骤，保留账本、模型和配置。重启前确认待确认交易；重启后核对新 starting 标记、持仓与 pending 恢复。

卖出 `-32016` 准备失败或链上确认 `6004` 后，查看 `exit_retry_scheduled` 的 kind、delayMs 和 fast；短重试资格 250/500/1000ms，每仓/全局60秒最多3/6次，实际执行受行情或1秒维护循环、执行锁和链上确认影响。其他错误仍10秒退避，未知签名不重新广播替代交易。预算持久化。退出失败后即使回升也保留退出意图；不要把这种重试当作新策略信号。

`stream_traffic.version=2` 含 reasons，原类别计数保留；原因字节均分，原因消息数可能重叠。导出15–30分钟后用 `stream-traffic-report.js` 汇总，关注未采用交易中各原因的字节占比。无新增行情订阅或流量分析RPC；实盘短重试本身可能增加执行RPC。

## 实盘防守版本核对

本版starting.strategyConfig.liveEntryPolicy.version=1：reserveExclusiveSol=100（储备必须>100）、lossCooldownMs=600000、waitMs=500、maxWaiters=16。只作用实盘，新买过滤不阻碍已有仓位退出。更新保留calibration.json / live.json和全部模型，升级从校准回执恢复最近亏损冷却。

验证live_entry_policy的live_reserve_at_most_100_sol / live_loss_cooldown；成功亏损卖出后应有live_loss_cooldown_started，lossCooldowns保存在账本和归档快照。自然无该场景不算失败。再检查live_entry_wait与shadow_health.filterTiming，统计实际改善的成交率，不拿所有shadow反事实入场数当应买数量。

原shadow selectionVersion保持7，额外实盘门槛由liveEntryPolicy单独标记；与原shadow比较时必须按sourceSignature+pool及same_size角色配对，并根据实盘拒绝/等待日志分组，不能将新实盘过滤伪装成旧selection定义。买入100 SOL边界、10分钟冷却到期和重启恢复均有本地测试；服务器要以部署后实际日志验证。
