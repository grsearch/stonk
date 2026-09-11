# Stonk 原策略模拟与 Shadow

当前 `src/index.js` 启动 Stonk Runtime，接回原 Engine、主模拟、Shadow、对照实验、状态报价和模型。代码强制实盘关闭，毕业满 30 分钟停止观察，未完成结果记为未知。

完整部署与估值限制见上一级 README.md。

运行 `node src/index.js` 启动；运行 `node src/stonk/dashboard.js` 查看原完整看板；原训练与归档工具保留在 scripts/。
