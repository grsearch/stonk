# 冻结双评分观察模型

经用户明确授权，本目录发布两个冻结模型，方便服务器从仓库安装。仅此目录的这两个模型作为发布例外；原始交易数据、密钥及其他私有训练产物仍不进仓库。

- rebound60.json：候选后60秒内估算净收益曾达到+5%的概率。
- drawdown60.json：同窗口估算净收益曾达到-25%的概率，区别于最终平仓亏损loss_25。
- 策略标识：4aa9d98cc8a3e538。参数仅使用9月7日数据拟合和校准，后续窗口没有用于重新训练。
- 仅供观察研究，不能视为已验证盈利策略。9月8日晚间评估显示最高反弹档高估、大跌中档低估；历史验证通过不保证新时段校准准确。

## 服务器安装

先在源码仓库目录拉取main。运行下列安装工具（源码目录若不同，修改两个模型源路径）：

```bash
node /opt/dump-sniper/helius/scripts/install-observation-models.js /home/ubuntu/dump-v5/observation-models/20260908/rebound60.json /home/ubuntu/dump-v5/observation-models/20260908/drawdown60.json /opt/dump-sniper/helius/.env
node /opt/dump-sniper/helius/scripts/install-observation-models.js --check /opt/dump-sniper/helius/.env
```

两项检查均为experimental_calibrated_model后重启：

```bash
sudo systemctl restart dump-sniper
```

重启后核对session的modelStatus、drawdownModelStatus均为experimental_calibrated_model，noStopRecoveryVersion=1。检查文件成功不等于正在运行的服务已经重新加载。

安装工具需a159f9a或之后版本，先同时验证两个模型与部署.env策略口径，再创建私有运行副本、推进观察起点、备份.env并更新两项模型路径。无需重新训练，不改交易金额、止盈止损或执行模式。不要把模型文件直接提交到data目录；该目录仍为私有运行数据。
