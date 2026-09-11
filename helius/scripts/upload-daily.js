'use strict';
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
// Dedicated credentials are deliberately not loaded by the trading process.
require('dotenv').config({ path: path.join(__dirname, '../.cos.env') });
const { readConfig } = require('../src/stonk/config');
const { DAY, latestEnd, dayName, buildArchive, atomicJSON, digest } = require('../src/reporting/archive');
const { makeClient, uploadVerified } = require('../src/reporting/upload');

function reportConfig(env = process.env) {
  const bucket = env.COS_BUCKET || 'guigu-1403019446', region = env.COS_REGION || 'na-siliconvalley';
  const prefix = env.COS_PREFIX || 'stonk/daily', instance = env.COS_INSTANCE_ID || 'siliconvalley-01';
  if (!/^[a-z0-9][a-z0-9-]*-\d+$/.test(bucket) || !/^[a-z0-9-]+$/.test(region)
    || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix) || !/^[a-zA-Z0-9_-]+$/.test(instance)) throw new Error('Invalid COS destination');
  return { bucket, region, prefix, instance, outputDir: path.resolve(__dirname, '..', env.COS_EXPORT_DIRECTORY || 'data/stonk/exports') };
}
async function run({ env = process.env, now = Date.now(), localOnly = false, client, endOverride } = {}) {
  const rc = reportConfig(env), c = readConfig({ ...env, HELIUS_API_KEY: env.HELIUS_API_KEY || 'offline-report' });
  fs.mkdirSync(rc.outputDir, { recursive: true, mode: 0o700 });
  const lock = path.join(rc.outputDir, '.upload.lock'); let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid report lock');
    try { process.kill(pid, 0); return { status: 'already_running' }; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock); lockFd = fs.openSync(lock, 'wx', 0o600);
  }
  fs.writeFileSync(lockFd, String(process.pid));
  try {
    const latest = latestEnd(now), cursorFile = path.join(rc.outputDir, 'upload-state.json');
    const identity = `${rc.bucket}/${rc.region}/${rc.prefix}/${rc.instance}`;
    let state = fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, 'utf8')) : { identity, nextEnd: latest };
    if (state.identity !== identity || !Number.isSafeInteger(state.nextEnd) || latestEnd(state.nextEnd) !== state.nextEnd) throw new Error('Report cursor does not match destination or window');
    if (!localOnly && endOverride !== undefined) throw new Error('Explicit date allowed only for local export');
    let end = endOverride ?? (localOnly ? latest : state.nextEnd);
    if ((endOverride !== undefined && end > latest) || latestEnd(end) !== end) throw new Error('Invalid report window');
    if (!localOnly && !fs.existsSync(cursorFile)) await atomicJSON(cursorFile, state); // Persist first failed window too.
    if (!localOnly && end <= latest) client ||= makeClient(env);
    const uploaded = [];
    for (let count = 0; end <= latest && count < (localOnly ? 1 : 7); count++, end += DAY) {
      const folder = path.join(rc.outputDir, dayName(end)), summaryFile = path.join(folder, 'summary.json'), file = path.join(folder, 'analysis.jsonl.gz');
      let bundle;
      if (fs.existsSync(summaryFile) && fs.existsSync(file)) {
        const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        if (summary.window.endExclusive !== new Date(end).toISOString() || summary.sha256 !== await digest(file)) throw new Error('Local archive integrity mismatch');
        bundle = { folder, file, summary };
      } else {
        const secrets = Object.entries(env).filter(([k]) => /SECRET|PRIVATE|API_KEY|SECURITY_TOKEN|PASSWORD/.test(k)).map(([, v]) => v).filter(v => typeof v === 'string');
        bundle = await buildArchive({ c, outputDir: rc.outputDir, end, secrets, now, previousSources: state.sources });
      }
      const qualityFile = path.join(folder, 'quality.json');
      await atomicJSON(qualityFile, await require('./inspect-export').inspect(folder));
      const executionFile = path.join(folder, 'execution-audit.json');
      await atomicJSON(executionFile, await require('../src/reporting/execution-audit').executionAudit(folder));
      if (localOnly) return { status: 'local_export_only', file, qualityFile, stats: bundle.summary.stats };
      const key = `${rc.prefix}/${rc.instance}/${dayName(end)}/${bundle.summary.sha256.slice(0, 16)}`;
      const dataObject = await uploadVerified(client, rc, file, `${key}/analysis.jsonl.gz`);
      const summaryObject = await uploadVerified(client, rc, summaryFile, `${key}/summary.json`);
      const qualityObject = await uploadVerified(client, rc, qualityFile, `${key}/quality.json`);
      const executionObject = await uploadVerified(client, rc, executionFile, `${key}/execution-audit.json`);
      await atomicJSON(path.join(folder, 'uploaded.json'), { identity, at: new Date().toISOString(), dataObject, summaryObject, qualityObject, executionObject });
      state = { identity, nextEnd: end + DAY, lastSuccessEnd: end, sources: bundle.summary.sources }; await atomicJSON(cursorFile, state);
      uploaded.push({ day: dayName(end), key, dataQuality: bundle.summary.dataQuality });
    }
    return { status: uploaded.length ? 'uploaded' : 'up_to_date', uploaded };
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}
function failureMessage(error) {
  if (error?.code === 'INSPECTION_SIZE_LIMIT') return 'Daily COS export failed before upload: uncompressed archive exceeds 4 GiB inspection limit. Pending window retained for retry.';
  return 'Daily COS export failed. Check credentials, permissions, network, disk and local archive integrity. Pending window retained for retry; secret details omitted.';
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--local-only')) { console.error('Usage: node scripts/upload-daily.js [--local-only]'); process.exitCode = 1; }
  else run({ localOnly: args.includes('--local-only') }).then(r => console.log(JSON.stringify(r))).catch(error => {
    // SDK errors may contain credentials, signed URLs or headers. Never print them.
    console.error(failureMessage(error)); process.exitCode = 1;
  });
}
module.exports = { run, reportConfig, failureMessage };
