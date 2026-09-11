# 北京时间每日 07:00 自动上传分析数据

目标已配置为 `guigu-1403019446`，地域 `na-siliconvalley`。此功能由服务器上的独立 systemd 服务和定时器执行，电脑和 Codex 不需要保持在线。定时器模板已做好；尚未连接你的服务器，也未提交真实 COS 上传。

## 上传时间与目录

每天北京时间 07:00 触发，先留 5 秒给观察日志写盘，再归档上传。窗口为前一天 07:00（含）至当天 07:00（不含）；例如 9 月 8 日的归档覆盖 9 月 7 日 07:00 至 9 月 8 日 07:00。美国服务器时区和夏令时不影响这个窗口。上传完成时间取决于文件大小和网络，不能保证 07:00 整已传完。

存储桶内路径：

```text
dump-sniper/daily/siliconvalley-01/2026-09-08/<内容哈希前缀>/analysis.jsonl.gz
dump-sniper/daily/siliconvalley-01/2026-09-08/<内容哈希前缀>/summary.json
```

每个日期下载 analysis.jsonl.gz、summary.json、quality.json、execution-audit.json 四个文件即可交给我分析。quality.json 自动列出样本可用性、缺失原因、各配置训练门槛、模拟毛盈亏和队列健康统计。`analysis.jsonl.gz` 是 gzip 压缩的 JSON Lines，可用常见解压工具打开，每行独立 JSON；`summary.json` 是时间范围、来源文件大小、行数、数据质量标记和 SHA-256 校验值。没有自动创建公开下载链接，也不修改存储桶权限，请通过 COS 控制台登录下载。

## 归档内容

| 数据 | 具体内容和用途 |
|---|---|
| 逐笔模拟买卖 | 关联 ID、代币/池子、原始数量、入场成本和价格、退出价格、持有时间、退出原因及未扣完整成本的账面收益 |
| 实盘交易记录 | 提交/确认/失败、来源与买卖签名、slot、实际代币增减、报价 SOL、网络费、配置 tip、可计算的净收益估计 |
| 执行速度 | 准备、构建签名、落盘、发送响应、确认耗时和 slot 差 |
| 候选与反弹样本 | 砸单金额、跌幅、流动性、此前买卖流、特征可用性、模型预测、模拟入场和三个目标的结果 |
| 观察期间的行情路径 | 基础候选触发时及仍有活跃样本的池子后续可解析 swap：时间、价格、储备、虚拟储备、方向、金额与交易签名；同池每次 swap 只记录一份 |
| 没有买入的原因 | 冷却、满仓、钱包忙、准备额度等决策；用于避免只看已买入机会造成偏差 |
| 状态快照 | 导出时的模拟/实盘持仓、未解决交易摘要、账户回收计划、冷却与流量状态 |
| 配置和模型 | 启动时策略配置、导出时非敏感配置、观察会话假设、配置的模型与验证报告（若存在） |
| 完整性与运行状态 | 行情断开、覆盖缺口、样本丢弃、异常、健康日志、Helius 流量估计及 RPC 计数 |

“完整”指**不抽样导出程序已经保留的窗口内交易和观察记录**，不是保存整条链或所有 PumpSwap 原始交易。未知指令、复杂路由和断流等未采集的数据无法补造。历史版本未记录的字段也不能补造。本功能不新增 Helius 请求。

逐笔收益有明确口径：模拟买卖是简化账面收益；shadow 使用延迟和费用假设；实盘净收益估计仍不含所有失败交易成本及账户租金变化。关闭账户事件和回收计划会上传，但当前未逐次查询实际退租金额，不能据此计算精确退租总收入。

## 跨日与晚到记录

窗口内发生卖出时，尽量附带其之前的关联买入；窗口内产生反弹结果时，附带其原始样本。额外行标记 `context: true`，不得把这些上下文再次算作当日交易。

07:00 时尚未完成的交易或标签保留在快照/样本中，后续结果进入下一天归档。记录在前次快照之后才追加、但事件时间落在更早窗口时，下次归档也作为上下文补带。前提是来源日志没有被删除、替换或截断。

多个日报联合分析时，应按 `sourceId + line` 去重源记录，按样本 `id`、交易签名或模拟 `positionId` 关联。模拟重启重复执行等异常仍需检查，不能仅按币名关联。一行的 `dataset` 区分 `manifest`、`trading`、`shadow`、`state_snapshot`、`model_snapshot`、`summary`。

归档格式是分析容器，不可直接作为 `train-shadow.js` 的 samples 文件输入；训练前需解压、提取 `shadow` 中的 `record`，按来源与原行号去重并保持顺序。给我连续几天的原始归档即可完成这一步。

可先执行 `node helius/scripts/inspect-export.js 归档文件夹路径` 核对压缩文件校验值、内部摘要、有效样本和各配置的训练门槛。如果程序在当天 07:00 以后才启动，第一次手动导出的已结束窗口可能是空的；导出时的持仓快照不代表该窗口有交易样本。后续一天也未必覆盖完整 24 小时，应检查真实采集时间。金额改变会产生新的策略配置指纹，旧金额标签不能直接混入新金额训练。

## 新服务器启用

先按 README 安装程序和依赖。安装脚本同时安装上传服务、定时器，并创建空的 `helius/.cos.env`。在服务器填写该文件：

```dotenv
COS_SECRET_ID=在服务器填写
COS_SECRET_KEY=在服务器填写
COS_BUCKET=guigu-1403019446
COS_REGION=na-siliconvalley
COS_PREFIX=dump-sniper/daily
COS_INSTANCE_ID=siliconvalley-01
COS_EXPORT_DIRECTORY=data/exports
```

`COS_SECRET_ID` 对应腾讯云 SecretId，`COS_SECRET_KEY` 对应 SecretKey。临时凭证另填 `COS_SECURITY_TOKEN`，过期后需更新；当前不自动续期。不要将真实值发到聊天或写进源码。

如果尚未运行安装脚本，在项目根目录执行：

```bash
sudo bash deploy/install.sh /opt/dump-sniper
# 编辑 /opt/dump-sniper/helius/.cos.env 后：
sudo chmod 600 /opt/dump-sniper/helius/.cos.env
sudo systemctl start dump-sniper-upload.service
sudo journalctl -u dump-sniper-upload.service -n 30 --no-pager
sudo systemctl enable --now dump-sniper-upload.timer
systemctl list-timers --all dump-sniper-upload.timer
```

安装用户默认 `ubuntu`；其他用户用原安装方式的 `SERVICE_USER=lighthouse` 等指定。文件由安装用户所有，服务与交易进程使用同一普通用户。交易进程只加载 `.env`，COS 凭证放在独立 `.cos.env`，只由上传进程加载；系统环境变量优先。

手动立即上传也严格使用最近一个已结束的 07:00 窗口，不把“最近 24 小时”随重试时间滚动。首次安装只处理最近一个已结束的窗口，不自动回填首次安装前的所有历史天数；第一份数据不足 24 小时会如实体现。

只生成本地文件、不调用 COS 的检查命令（在项目根目录）：

```bash
node helius/scripts/upload-daily.js --local-only
```

本地归档在 `helius/data/exports/<北京时间日期>/`，不会因预览推进已上传进度。为了重试一致性，已生成且校验通过的当日归档会复用；之后晚到的记录进入下一份归档。

## 重试、补传与性能

定时器除每日 07:00 外，在启动两分钟后和服务结束每 15 分钟检查一次。已上传时只检查本地进度，**不请求 COS**。失败窗口先保留，再重试；有历史欠传时依日期补传，每次最多 7 天，其余下轮继续。磁盘仍保留原始日志是补传前提。

使用腾讯云官方 SDK 3.0.0，HTTPS 上传；大文件自动分块，文件及分块并发均为 1，开启上传 Content-MD5 校验。上传后 HEAD 核对大小和 SHA-256 元数据，四个对象都成功才推进进度。HEAD 核对元数据不等于服务端重新计算 SHA-256；下载后可用摘要里的 SHA-256 独立校验。网络中断可能留下未完成分块，可另设 COS 生命周期清理未完成分块。

压缩使用低压缩级别并流式处理；上传在独立进程运行，配置较低 CPU/磁盘调度优先级。不会让买单等待打包或上传，但仍共享服务器资源。当前每日会扫描保留日志以寻找跨日关联，日志长期增长会增加扫描时间和磁盘占用；不要删除仍有待补传或关联结果的文件。

本地和 COS 文件当前均不自动删除，避免未经验证的数据丢失。不能用这个分析归档直接恢复交易状态，已签名待发送字节被明确排除。

## 权限和可见性

建议使用独立子账号密钥，仅授权该存储桶的日报路径。上传需要 PutObject、HeadObject 及分块上传相关权限；可参考 [腾讯云 COS API 授权说明](https://cloud.tencent.com/document/product/436/31923)。桶保持私有，不需要公开读写，也不需要删除对象权限。

官方 SDK 调用和目标地域依据：[腾讯云官方 Node SDK](https://github.com/tencentyun/cos-nodejs-sdk-v5)、[COS 地域与域名](https://cloud.tencent.com/document/product/436/6224)。硅谷同地域 CVM/COS 可以按官方说明检查是否解析到内网地址；程序使用标准 COS 域名，不承诺已经验证内网路径或零费用。

本次验证：62 项本地测试通过，覆盖北京时间边界、跨日关联、晚到补带、敏感信息排除、失败重试、补传及校验。没有真实 COS 密钥或服务器访问，因此未验证桶是否存在、账号权限、线上上传或 systemd 在目标服务器的运行结果。启用后以服务日志中的 `uploaded` 和 COS 内实际两个文件为准。

## 立即检查最近一小时

在项目根目录执行：

```bash
node helius/scripts/export-recent.js --hours 1
```

默认最近 1 小时，允许大于 0、最多 24 小时。输出路径会打印到终端，位于 helius/data/exports/manual-时间-唯一标识/，包含 analysis.jsonl.gz、summary.json、quality.json。仅读取本地日志，不请求 Helius 或 COS，不推进日报游标，不覆盖已冻结的 07:00 归档；每次独立生成。需要下载这整个目录。日常 COS 上传仍由原定时器执行，更新代码即可在下一次上传附带 quality.json，无须重启交易进程。

质量报告的 windowCandidateCohort 按窗口内候选分母统计，区分已观察、覆盖中断和导出时尚无结果；窗口内结果可能对应更早候选，两者数量不必相等。训练 eligible 只计窗口内触发且具备历史与成熟标签的候选，跨窗上下文保留用于关联。模拟毛盈亏不包含费用、冲击和执行延迟；proxyEntryDelayMs 是观察模型的延迟，不是实盘成交测速。健康日志是采样记录，零丢弃不能证明全程完整覆盖。

新版归档包含 execution_comparison、pump_migrated 和 sample.age，quality.json 增加候选规则对照及迁移 AGE分组；详见 [观察与年龄说明](OBSERVATION.md)。

每次新版导出同时生成 execution-audit.json，用于逐笔核对 paper/proxy 差额，旧数据缺少中间值会明确标记，不能补造。AGE 采集状态见 quality.json.audit.migrationPipeline。
# 大归档检查上限修复（2026-09-10）

本地质检解压检查上限由1 GiB提高到4 GiB，超过上限会明确报告`INSPECTION_SIZE_LIMIT`对应的容量错误；未知SDK异常仍不打印可能包含密钥的原文。压缩包大小与解压大小不同。检查器流式读取，但样本、结果和审计索引仍占内存，原样本数量保护继续保留。

若当天已生成analysis.jsonl.gz但在检查阶段失败，更新安装脚本文件后重新启动原上传服务即可复用待上传归档。不要删除upload-state.json、修改游标或重新覆盖已有归档；成功校验并上传四个文件后，程序才推进窗口。定时重试策略不变。部署后核对uploaded.json及服务成功日志，不能以服务正在运行作为上传完成依据。
