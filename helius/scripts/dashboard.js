'use strict';
const path = require('node:path');
const { readConfig } = require('../src/stonk/config');
const { options, createServer } = require('../src/dashboard/server');
try {
  const c = readConfig(), opts = options();
  const server = createServer(c, opts, path.resolve(__dirname, '..', process.env.COS_EXPORT_DIRECTORY || 'data/exports'));
  server.on('error', () => { console.error('Dashboard could not listen; check host and port.'); process.exitCode = 1; });
  server.listen(opts.port, opts.host, () => console.log(`Read-only dashboard listening on ${opts.host}:${opts.port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
} catch (_) { console.error('Dashboard configuration invalid; check .env and token for non-loopback access.'); process.exitCode = 1; }
