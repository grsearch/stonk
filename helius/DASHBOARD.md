# Dashboard 运行面板

独立只读网页面板，默认端口 **8787**，只监听服务器 `127.0.0.1`。每 5 秒读取状态文件和最近日志，不请求 Helius、不加载 COS 密钥，也不提供下单或修改参数接口。

显示模拟/实盘模式、行情健康度、单笔买入金额、持仓及池价变化、近期交易、执行延迟、反弹样本、缺失结果、账户回收计划和最近成功上传窗口。超过 2 分钟没有健康日志会标为过期。交易表显示最近 24 小时的全部保留事件，默认每页 20 条，可选 10/20/50 条，支持上一页和下一页。健康图仍最多 120 条，只读取最近 2 MB 日志；盈亏和分页使用独立的完整日志索引。持仓和交易表中的合约地址可点击，在新标签页打开对应 GMGN 页面。

金额卡片优先显示交易进程启动日志中的参数，另显示面板读取的文件参数。两者不一致时，修改配置后可能还没有重启交易服务。状态文件通常每分钟更新，已有持仓的数据可能延迟；池价涨幅也不等于扣费后实际收益。没有配置变更、买卖或账户关闭按钮。

## 更新已有服务器

新增最近 24 小时已平仓盈亏：按卖出日志时间统计滚动 24 小时，不按 UTC 自然日或 COS 的 07:00 窗口。模拟模式汇总 `paper_sell.grossPnlSol`，实盘汇总 `sell_confirmed.netPnlSol`；不统计已提交未确认、未平仓浮盈亏、退租及其他失败交易成本。显示平仓数、已知金额胜率、盈利/亏损/持平及金额缺失数量。旧日志没有金额时不从当前 1 SOL 配置倒推成本，也不把缺失当零。

启动面板时流式扫描当前状态文件对应的完整 `.jsonl` 日志，此后仅增量读取追加内容并剔除过期交易。首次日志很大时统计可能稍后可用；所有工作在 dashboard 进程完成，不新增 Helius 请求。文件缺失或读取失败显示不可用，日志不足 24 小时或损坏会提示。只统计仍保留在该日志里的数据，不自动扫描手动轮转或删掉的旧日志。自动刷新保持当前页码，但新增事件和过期事件可能改变该页内容。

在保存仓库的目录拉取新版，再按原有安装用户运行安装脚本：

```bash
git pull --ff-only origin main
sudo bash deploy/install.sh /opt/dump-sniper
```

如果原来使用 `lighthouse`，仍使用 `sudo SERVICE_USER=lighthouse bash deploy/install.sh /opt/dump-sniper`，不要换运行用户。安装脚本保留已有 `.env`、`.cos.env` 和数据，不覆盖服务器参数。

本次代码默认买入金额已变为 1 SOL。**已有 `.env` 中的显式值仍然优先**；请在 `/opt/dump-sniper/helius/.env` 核对：

```dotenv
POSITION_SIZE_SOL=1
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8787
```

随后：

```bash
sudo systemctl restart dump-sniper
sudo systemctl enable --now dump-sniper-dashboard
sudo systemctl restart dump-sniper-dashboard
sudo journalctl -u dump-sniper-dashboard -n 20 --no-pager
```

已有旧金额持仓保留原来的成本与数量，1 SOL 只用于之后新买单。观察模块也使用新金额生成新的策略配置指纹；0.1 SOL 的旧标签不能直接当成 1 SOL 的同配置训练数据。仍保持原先模拟/实盘模式，更新不会切换模式。

## 在自己的电脑打开

推荐在电脑终端建立 SSH 隧道（替换用户名与服务器 IP）：

```bash
ssh -N -L 8787:127.0.0.1:8787 用户名@服务器IP
```

保持这个终端连接，然后浏览器打开 **http://127.0.0.1:8787**。这里通过隧道显示服务器数据，默认不需要开放腾讯云入站 8787 端口。

如需域名访问，可用 HTTPS 反向代理转到服务器 127.0.0.1:8787，并在 `.env` 设置长度至少 24 字符的随机 `DASHBOARD_TOKEN` 及 `DASHBOARD_PUBLIC_ORIGIN=https://你的面板域名`。面板会要求输入令牌。非回环绑定（如 `DASHBOARD_HOST=0.0.0.0`）强制要求此令牌；公网访问应使用 HTTPS，令牌不要放进 URL。面板未配置 CORS，反向代理须正确保留 Host。

不要把钱包私钥或 Helius key 当作 dashboard 令牌。浏览器只在当前页面内存保存令牌，刷新页面需重新输入。服务会隐藏签名交易字节和配置秘密。

## 手动运行

在项目根目录执行 `npm run dashboard`，或进入 `helius/` 执行相同命令。与 systemd 二选一，避免占用同一端口。面板使用 `helius/.env` 中当前模式的状态文件；COS 进度目录默认 `data/exports`，如自定义目录，应在 `.env` 同步设置 `COS_EXPORT_DIRECTORY`。

本地已验证 HTTP 鉴权、只读限制、隐私字段过滤、健康过期和页面显示；尚未访问你的服务器安装或启用服务。
