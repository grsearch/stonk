# Stonk 恢复原程序验收

- 模式：Stonk 专用，原主模拟 + 原 Shadow，实盘代码封锁。
- 策略默认值与原 dump-v5-publish 一致，冻结模型策略标识 4aa9d98cc8a3e538。
- 237 项测试全部通过：原有回归测试，以及 Stonk 程序识别、非 SOL 精度、费用、估值、真实 Shadow 工作线程、原过滤响应、模拟买卖、状态报价与到期删失。
- 执行命令：node --test --test-isolation=none helius/test/*.test.js（Node 24.19.0；此环境不允许测试子进程，故使用同进程测试模式）。
- 原完整 Dashboard 页面与 /api/status 返回 HTTP 200。
- npm 按锁文件安装，禁用依赖安装脚本；可选 bigint 本地扩展未加载，测试使用纯 JavaScript 实现。
- 未配置真实 Helius 密钥。当前证明本地功能与离线集成，不证明在线迁移、行情完整性或报价资产覆盖率。
- Linux 安装与 COS 实际上传未在此 Windows 环境执行。
