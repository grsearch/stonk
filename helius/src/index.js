'use strict';
require('./stonk').main().catch(() => {
  console.error('Stonk startup failed. Check Helius configuration, data directory and monitor.lock. Credentials omitted.');
  process.exitCode = 1;
});
