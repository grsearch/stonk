'use strict';
const { readConfig } = require('./config');
const { Runtime } = require('./runtime');
async function main() {
  const runtime = new Runtime(readConfig());
  try { runtime.start(); } catch (e) {
    runtime.engine.stopped = true; await runtime.shadow.close(); runtime.store.close(); throw e;
  }
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; runtime.stop().catch(() => { process.exitCode = 1; }); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return runtime;
}
if (require.main === module) main().catch(() => { console.error('Stonk startup failed. Check Helius configuration, state locks and dependencies; credentials omitted.'); process.exitCode = 1; });
module.exports = { main };
