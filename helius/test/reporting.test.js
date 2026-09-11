'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readConfig } = require('../src/config');
const { latestEnd, DAY, dayName, scrub, publicState, buildArchive } = require('../src/reporting/archive');
const { uploadVerified, makeClient } = require('../src/reporting/upload');
const { run, reportConfig } = require('../scripts/upload-daily');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { HELIUS_API_KEY: 'helius-test-secret', STATE_FILE: path.join(dir, 'paper.json'), SHADOW_DIRECTORY: path.join(dir, 'shadow'), COS_EXPORT_DIRECTORY: path.join(dir, 'exports') };
  fs.mkdirSync(env.SHADOW_DIRECTORY);
  return { dir, env, c: readConfig(env), end: Date.parse('2026-09-07T23:00:00Z') };
}
function write(file, rows) { fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
function unpack(file) { return zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map(JSON.parse); }
function fakeCOS() {
  const objects = new Map(), calls = [];
  return { calls, objects,
    uploadFile(p, cb) { calls.push(p.Key); objects.set(p.Key, { bytes: fs.statSync(p.FilePath).size, hash: p.Headers['x-cos-meta-sha256'] }); cb(null, {}); },
    headObject(p, cb) { const o = objects.get(p.Key); cb(null, { headers: { 'content-length': String(o.bytes), 'x-cos-meta-sha256': o.hash, etag: 'fake' } }); } };
}

test('entry research survives archive and inspection without turning unknown into zero-return trade', async t => {
  const f = fixture(t), at = f.end - 5000;
  write(path.join(f.env.SHADOW_DIRECTORY, 'samples-entry.jsonl'), [
    { type: 'entry_comparison', entryResearchVersion: 1, id: 's', variant: 'immediate', policyId: 'p', at, phase: 'entered', status: 'holding', entryAt: at },
    { type: 'entry_comparison', entryResearchVersion: 1, id: 's', variant: 'immediate', policyId: 'p', at: at + 500, phase: 'finished', status: 'observed_proxy', entryAt: at, netPnlSol: -.1 },
    { type: 'entry_comparison', entryResearchVersion: 1, id: 's', variant: 'confirm_two_buyers', policyId: 'p', at: at + 500, phase: 'finished', status: 'censored', reason: 'buyer_identity_unavailable', netPnlSol: null }
  ]);
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  const q = await require('../scripts/inspect-export').inspect(path.dirname(a.file));
  const groups = q.audit.entryComparisons.groups;
  assert.equal(groups.find(g => g.variant === 'immediate').candidates, 1);
  assert.equal(groups.find(g => g.variant === 'immediate').netPnlSol, -.1);
  assert.equal(groups.find(g => g.variant === 'confirm_two_buyers').unknown, 1);
  assert.equal(groups.find(g => g.variant === 'confirm_two_buyers').observed, 0);
});

test('archive replay validates source hash, admits only prebuy known pass, and never invents buyer identities', async t => {
  const f = fixture(t), at = f.end - 10000, p = { ...f.c.shadow, sizeSol: 1, networkFeeSol: 0, feeBps: 0, slippageBps: 0,
    takeProfit: 20, stopLoss: 25, trailArm: 10, trailDrop: 3, maxHoldMs: 30000 };
  const swap = (offset, quote, side = 'buy') => ({ type: 'pool_observation', runId: 'r', key: `k${offset}`, at: at + offset,
    pool: 'pool', mint: 'mint', price: quote / 1e11, postBase: '100000000000', postQuote: String(quote * 1e9), virtual: '0', side });
  write(path.join(f.env.SHADOW_DIRECTORY, 'samples-entry-replay.jsonl'), [swap(0, 100, 'sell'),
    { type: 'sample', runId: 'r', id: 's', key: 'k0', at, policy: p, policyId: 'policy', source: { pool: 'pool', mint: 'mint' }, decisionFresh: true,
      age: { definition: 'since_pump_graduation_migration', source: 'pump_migrate_processed', status: 'observed_processed_not_finalized', migrationAgeMs: 1000 },
      features: { ready: true, values: { buyFraction15: .5, buySol15: 1, sellSol15: 1, trades60: 10, return60Pct: 0, sellSol: 8, buyFraction5: .5, consecutiveSells: 0, buySol5: 1, sellSol5: 1 } } },
    swap(100, 100), swap(500, 103), swap(1000, 104), swap(1500, 140), swap(2000, 135), swap(3500, 135)]);
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  const { replay } = require('../scripts/replay-entry-research');
  const q = await replay(path.dirname(a.file), path.join(f.dir, 'replayed.json'));
  assert.equal(q.samples, 1); assert.equal(q.buyerIdentityObservations, 0);
  assert.equal(q.audit.groups.find(g => g.variant === 'confirm_buy_flow').observed, 1);
  assert.equal(q.audit.groups.find(g => g.variant === 'confirm_two_buyers').unknown, 1);
  fs.appendFileSync(a.file, 'x');
  await assert.rejects(replay(path.dirname(a.file), path.join(f.dir, 'bad.json')), /checksum\/size/);
});
test('daily boundary is exactly Beijing 07:00 regardless of host timezone or US DST', () => {
  for (const date of ['2026-03-08', '2026-09-07', '2026-11-01']) {
    const end = Date.parse(`${date}T23:00:00Z`);
    assert.equal(latestEnd(end), end); assert.equal(latestEnd(end - 1), end - DAY);
    assert.equal(latestEnd(end + 86400000 - 1), end);
  }
  assert.equal(dayName(Date.parse('2026-09-07T23:00:00Z')), '2026-09-08');
});
test('archive includes all window records, linked pre-window samples, and reports partial data', async t => {
  const f = fixture(t), start = f.end - DAY;
  write(`${f.c.stateFile}.jsonl`, [
    { time: new Date(start - 5).toISOString(), type: 'paper_buy', positionId: 'trade1' },
    { time: new Date(start).toISOString(), type: 'paper_sell', positionId: 'trade1' },
    { time: new Date(f.end).toISOString(), type: 'outside' }]);
  const shadow = path.join(f.env.SHADOW_DIRECTORY, 'samples-test.jsonl');
  write(shadow, [{ type: 'session', at: start - 5000 }, { type: 'sample', id: 's1', at: start - 1 },
    { type: 'outcome', id: 's1', at: start + 5000, target: 'rebound_60s', label: 1 }]);
  fs.appendFileSync(shadow, '{broken}\n{"partial":');
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  const rows = unpack(a.file);
  assert.equal(a.summary.stats.windowRecords, 2); assert.equal(a.summary.stats.invalidLines, 1); assert.equal(a.summary.stats.partialLines, 1);
  assert.equal(a.summary.dataQuality, 'needs_review');
  assert.ok(rows.some(r => r.context && r.record.type === 'sample'));
  assert.ok(rows.some(r => r.context && r.record.type === 'paper_buy'));
  assert.ok(!rows.some(r => r.record.type === 'outside'));
});
test('credentials, endpoints and pending signed bytes never enter archive', async t => {
  const f = fixture(t);
  write(`${f.c.stateFile}.jsonl`, [{ time: new Date(f.end - 1).toISOString(), type: 'error', error: 'oops TOPSECRET https://host/?api-key=abc', SecretId: 'id' }]);
  fs.writeFileSync(f.c.stateFile, JSON.stringify({ mode: 'paper', pending: { sig: { signature: 'sig', serialized: 'REPLAYABLE', swap: { secret: 'x' } } } }));
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end, secrets: ['TOPSECRET', f.env.HELIUS_API_KEY] });
  const text = zlib.gunzipSync(fs.readFileSync(a.file)).toString();
  for (const secret of ['TOPSECRET', 'REPLAYABLE', 'https://host', f.env.HELIUS_API_KEY]) assert.ok(!text.includes(secret));
  assert.deepEqual(publicState({ pending: { sig: { signature: 'sig', serialized: 'bad' } } }).pending.sig, { signature: 'sig' });
  assert.equal(scrub({ privateKey: 'a' }).privateKey, '[redacted]');
});
test('late-written records from the prior day are carried into the next archive', async t => {
  const f = fixture(t), file = `${f.c.stateFile}.jsonl`;
  write(file, [{ time: new Date(f.end - 10000).toISOString(), type: 'original' }]);
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  fs.appendFileSync(file, JSON.stringify({ time: new Date(f.end - 1000).toISOString(), type: 'late_flush' }) + '\n');
  const b = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end + DAY, previousSources: a.summary.sources });
  const rows = unpack(b.file);
  assert.ok(rows.some(r => r.record.type === 'late_flush' && r.context));
  assert.ok(!rows.some(r => r.record.type === 'original'));
  fs.truncateSync(file, 0);
  const truncated = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end + 2 * DAY, previousSources: b.summary.sources });
  assert.equal(truncated.summary.sourceChanges.length, 1);
  assert.equal(truncated.summary.dataQuality, 'needs_review');
});
test('upload verifies size and digest metadata and refuses mismatched remote object', async t => {
  const f = fixture(t), file = path.join(f.dir, 'test.json'); fs.writeFileSync(file, '{}');
  const client = fakeCOS(); const result = await uploadVerified(client, reportConfig(f.env), file, 'test/key');
  assert.equal(result.bytes, 2); assert.equal(result.sha256.length, 64);
  client.headObject = (_, cb) => cb(null, { headers: { 'content-length': '0' } });
  await assert.rejects(uploadVerified(client, reportConfig(f.env), file, 'test/key'), /verification/);
});
test('failed upload retains window and retries identical artifact before advancing; same day is no-op', async t => {
  const f = fixture(t), client = fakeCOS();
  const bad = { uploadFile: (_, cb) => cb(new Error('network')) };
  await assert.rejects(run({ env: f.env, now: f.end + 5000, client: bad }), /network/);
  const cursor = path.join(f.env.COS_EXPORT_DIRECTORY, 'upload-state.json');
  assert.equal(JSON.parse(fs.readFileSync(cursor)).nextEnd, f.end);
  const result = await run({ env: f.env, now: f.end + 10000, client });
  assert.equal(result.status, 'uploaded'); assert.equal(client.calls.length, 4);
  const again = await run({ env: f.env, now: f.end + 20000, client });
  assert.equal(again.status, 'up_to_date'); assert.equal(client.calls.length, 4);
  const recovered = await run({ env: f.env, now: f.end + 3 * DAY + 5000, client });
  assert.equal(recovered.uploaded.length, 3);
});
test('local-only export needs no COS credentials and never advances upload state', async t => {
  const f = fixture(t); const result = await run({ env: f.env, now: f.end + 1000, localOnly: true });
  assert.equal(result.status, 'local_export_only');
  assert.ok(!fs.existsSync(path.join(f.env.COS_EXPORT_DIRECTORY, 'upload-state.json')));
  assert.throws(() => makeClient({}), /credentials/);
  const sdk = makeClient({ COS_SECRET_ID: 'fake', COS_SECRET_KEY: 'fake' });
  assert.equal(sdk.options.Protocol, 'https:'); assert.equal(sdk.options.UploadCheckContentMd5, true);
});
test('destination changes and corrupt frozen archives cannot silently advance the cursor', async t => {
  const f = fixture(t), client = fakeCOS();
  await run({ env: f.env, now: f.end + 1000, localOnly: true });
  fs.appendFileSync(path.join(f.env.COS_EXPORT_DIRECTORY, dayName(f.end), 'analysis.jsonl.gz'), 'bad');
  await assert.rejects(run({ env: f.env, now: f.end + 1000, client }), /integrity/);
  await assert.rejects(run({ env: { ...f.env, COS_INSTANCE_ID: 'different' }, now: f.end + 1000, client }), /cursor/);
});

test('recent export uses rolling hour, preserves earlier buy context, and never alters daily cursor', async t => {
  const f = fixture(t), now = f.end + 12345;
  write(`${f.c.stateFile}.jsonl`, [
    { time: new Date(now - 3600001).toISOString(), type: 'paper_buy', positionId: 'old' },
    { time: new Date(now - 1).toISOString(), type: 'paper_sell', positionId: 'old', grossPnlSol: -0.2 },
    { time: new Date(now).toISOString(), type: 'outside' }]);
  const recent = require('../scripts/export-recent');
  const result = await recent.run({ env: f.env, now });
  const rows = unpack(path.join(result.folder, 'analysis.jsonl.gz'));
  assert.equal(Date.parse(result.window.start), now - 3600000);
  assert.equal(result.quality.audit.paper.grossPnlSol, -0.2);
  assert.equal(result.quality.audit.windowCounts['trading:paper_sell'], 1);
  assert.ok(rows.some(x => x.context && x.record.positionId === 'old'));
  assert.ok(!rows.some(x => x.record.type === 'outside'));
  assert.ok(!fs.existsSync(path.join(f.env.COS_EXPORT_DIRECTORY, 'upload-state.json')));
  const second = await recent.run({ env: f.env, now });
  assert.notEqual(result.folder, second.folder);
  await assert.rejects(recent.run({ env: f.env, hours: 0 }), /Hours/);
});

test('quality separates censored and pending labels from negative outcomes and checks gross paper PnL', async t => {
  const f = fixture(t), at = f.end - 100000;
  write(path.join(f.env.SHADOW_DIRECTORY, 'samples-quality.jsonl'), [
    { type: 'sample', id: 'one', at, features: { ready: false, reason: 'insufficient_prior_history' } },
    { type: 'sample', id: 'two', at },
    { type: 'outcome', id: 'one', at: at + 2000, target: 'rebound_60s', status: 'censored', label: null, reason: 'pool_observation_gap' },
    { type: 'coverage_gap', at, reason: 'stream_disconnected' }]);
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  const q = await require('../scripts/inspect-export').inspect(a.folder);
  assert.deepEqual(q.targets.rebound_60s.windowCandidateCohort, { samples: 2, observed: 0, positive: 0, negative: 0, censored: 1, missingAtExport: 1, censorReasons: { pool_observation_gap: 1 } });
  assert.equal(q.audit.featureReasons.insufficient_prior_history, 1);
  assert.equal(q.audit.coverageGapReasons.stream_disconnected, 1);
});

test('quality groups provisional pool ages and comparison exclusions without calling crashes rugs', async t => {
  const f = fixture(t), at=f.end-100000;
  write(path.join(f.env.SHADOW_DIRECTORY,'samples-age.jsonl'),[
    {type:'sample',id:'one',at,policyId:'p',age:{migrationAgeMs:1000}},
    {type:'outcome',id:'one',at:at+60000,target:'rebound_60s',status:'observed_proxy',label:0,minNetPct:-70},
    {type:'execution_comparison',id:'one',key:'key',at:at+60000,policyId:'p',status:'observed_proxy',label:0,netPnlSol:-.7,experiments:{experimentId:'e',baseline:true,belowMaxSell:false,avoidPriorSellPressure:null,lossCooldown:true,combined:false}}
  ]);
  const a=await buildArchive({c:f.c,outputDir:f.env.COS_EXPORT_DIRECTORY,end:f.end});
  const q=await require('../scripts/inspect-export').inspect(a.folder);
  assert.equal(q.audit.migrationAge['p:0-5m'].severeProxyDrawdown60s,1);
  assert.equal(q.audit.executionComparisons['p:e:baseline'].netPnlSol,-.7);
  assert.equal(q.audit.executionComparisons['p:e:belowMaxSell'].reject,1);
  assert.equal(q.audit.executionComparisons['p:e:avoidPriorSellPressure'].unknownRule,1);
});

test('execution accounting bridge reconciles costs without changing quotes and detects corruption', () => {
  const {buyQuote,liquidation,liquidationDetails}=require('../src/shadow/tracker');
  const {decompose}=require('../src/reporting/execution-audit');
  const c={sizeSol:1,feeBps:100,slippageBps:100,networkFeeSol:.000305};
  const a={postBase:'100000000000',postQuote:'100000000000',virtual:'10000000000'};
  const b={...a,postQuote:'120000000000'};
  const entry=buyQuote(a,c),exit=liquidationDetails(b,entry.amount,c);
  assert.equal(exit.net,liquidation(b,entry.amount,c));
  const comparison={netPnlSol:exit.net-entry.cost,executionBreakdown:{entry:entry.breakdown,exit}};
  const d=decompose(.2,comparison);assert.equal(d.status,'reconciled');assert.ok(Math.abs(d.residualSol)<1e-10);
  assert.ok(d.components.entryCurveImpact<0);assert.ok(d.components.exitFee<0);
  assert.equal(decompose(.2,{...comparison,netPnlSol:1}).status,'mismatch');
  assert.equal(decompose(.2,{}).status,'legacy_missing_breakdown');
});

test('exit archive comparison pairs the same policy and preserves unknown outcomes', async t => {
  const f = fixture(t), at = f.end - 1000;
  write(path.join(f.env.SHADOW_DIRECTORY, 'samples-exits.jsonl'), [
    { type: 'outcome', id: 'a', target: 'strategy_proxy', at, policyId: 'p', status: 'observed_proxy', netPnlSol: -.2 },
    { type: 'exit_comparison', id: 'a', variant: 'exit_250ms', comparisonVersion: 1, at, policyId: 'p', status: 'observed_proxy', netPnlSol: .1 },
    { type: 'exit_comparison', id: 'b', variant: 'exit_250ms', comparisonVersion: 1, at, policyId: 'p', status: 'censored', netPnlSol: null },
  ]);
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  const q = await require('../scripts/inspect-export').inspect(a.folder), b = q.audit.exitComparisons['p:1:exit_250ms'];
  assert.equal(b.paired, 1); assert.equal(b.unknown, 1); assert.ok(Math.abs(b.differenceSol - .3) < 1e-9);
});

test('execution audit retains unavailable comparisons and never invents legacy costs', async t => {
  const f=fixture(t),at=f.end-1000;
  write(`${f.c.stateFile}.jsonl`,[
    {type:'paper_sell',time:new Date(at).toISOString(),positionId:'s',pool:'p',grossPnlSol:.1},
    {type:'paper_sell',time:new Date(at).toISOString(),positionId:'missing',pool:'p',grossPnlSol:.2}]);
  write(path.join(f.env.SHADOW_DIRECTORY,'samples-pairs.jsonl'),[{type:'execution_comparison',id:'id',key:'s:p',at,status:'observed_proxy',netPnlSol:-.2}]);
  const a=await buildArchive({c:f.c,outputDir:f.env.COS_EXPORT_DIRECTORY,end:f.end});
  const audit=await require('../src/reporting/execution-audit').executionAudit(a.folder);
  assert.equal(audit.totals.legacyMissingBreakdown,1);assert.equal(audit.totals.noComparison,1);
  assert.equal(audit.totals.proxyPnlSol,-.2);assert.equal(audit.rows[0].decomposition.components,undefined);
});

test('recovery archive is separate from complete exit results and reports missing models', async t => {
  const f = fixture(t), at = f.end - 1000;
  write(path.join(f.env.SHADOW_DIRECTORY, 'samples-test.jsonl'), [
    { type: 'sample', schema: 1, id: 'r', key: 'k', runId: 'run', at: at - 60000, policyId: 'p', features: { ready: false }, prediction: { status: 'no_model' }, objectivePredictions: { drawdown60: { status: 'no_model' } } },
    { type: 'no_stop_recovery', id: 'r', runId: 'run', policyId: 'p', at, phase: 'finished', coverage: 'discontinuous', status: 'discontinuous_proxy', netPnlSol: .1 },
  ]);
  const archive = await buildArchive({ c: f.c, outputDir: path.join(f.dir, 'exports'), end: f.end });
  const q = await require('../scripts/inspect-export').inspect(archive.folder);
  assert.equal(q.audit.noStopRecovery.groups[0].all.quoted, 1);
  assert.equal(q.audit.noStopRecovery.groups[0].all.quotedNetSol, .1);
  assert.ok(q.audit.warnings.some(x => x.includes('models are not loaded')));
});

test('archive includes both frozen observation model snapshots', async t => {
  const f = fixture(t), b = path.join(f.dir, 'rebound.json'), d = path.join(f.dir, 'drawdown.json');
  fs.writeFileSync(b, JSON.stringify({ target: 'rebound_60s' })); fs.writeFileSync(d, JSON.stringify({ target: 'drawdown_60s_25' }));
  f.c.shadow.modelFile = b; f.c.shadow.drawdownModelFile = d;
  const a = await buildArchive({ c: f.c, outputDir: path.join(f.dir, 'exports'), end: f.end });
  assert.deepEqual(unpack(a.file).filter(r => r.dataset === 'model_snapshot').map(r => r.record.target).sort(), ['drawdown_60s_25', 'rebound_60s']);
});

test('archive keeps account-state results, stream recoveries, pending and unknown separate by variant', async t => {
  const f = fixture(t), at = f.end - 1000;
  const recovery = { id: 'r', runId: 'run', policyId: 'p', at, variant: 'take30', recoveryVersion: 1,
    phase: 'finished', coverage: 'discontinuous', netPnlSol: .2 };
  write(path.join(f.env.SHADOW_DIRECTORY, 'samples-states.jsonl'), [
    { type: 'outcome', id: 'r', policyId: 'p', target: 'strategy_proxy', status: 'observed_proxy', netPnlSol: -.1, at },
    { ...recovery, type: 'exit_recovery', status: 'discontinuous_proxy' },
    { ...recovery, type: 'state_exit_recovery', status: 'account_state_proxy', netPnlSol: -.5 },
    { ...recovery, type: 'state_exit_recovery', variant: 'baseline', status: 'account_state_proxy', netPnlSol: -.8 },
    { ...recovery, type: 'state_exit_recovery', variant: 'take50', status: 'unknown', netPnlSol: null, reason: 'no_exit_quote_by_deadline' },
    { ...recovery, type: 'state_exit_recovery', variant: 'take50_no_stop', phase: 'started', status: 'pending', netPnlSol: null },
    { type: 'state_quote', at, status: 'unavailable', reason: 'missing_account', discardReason: 'unavailable' },
    { type: 'state_quote', at, status: 'unavailable', reason: 'unsupported_extensions', accountDiagnostics: [
      { role: 'baseMint', status: 'rejected', blockedExtensions: [{ type: 14, name: 'TransferHook', length: 64 }] }] },
  ]);
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  const q = await require('../scripts/inspect-export').inspect(a.folder), groups = q.audit.researchRecovery.groups;
  assert.equal(groups.length, 5);
  assert.equal(groups.find(g => g.type === 'exit_recovery').all.estimatedNetSol, .2);
  assert.equal(groups.find(g => g.type === 'state_exit_recovery' && g.variant === 'take30').all.estimatedNetSol, -.5);
  const paired = groups.find(g => g.type === 'state_exit_recovery' && g.variant === 'take30').all;
  assert.equal(paired.pairedWithSourceBaseline, 1); assert.ok(Math.abs(paired.sourceDifferenceSol - .3) < 1e-12);
  assert.equal(groups.find(g => g.variant === 'take50').all.unknown, 1);
  assert.equal(groups.find(g => g.variant === 'take50_no_stop').all.pending, 1);
  assert.deepEqual(q.audit.exitComparisons, {}); assert.equal(q.audit.noStopRecovery.groups.length, 0);
  assert.equal(q.audit.stateQuotes.reasons.missing_account, 1);
  assert.equal(q.audit.stateQuotes.extensionRejections['baseMint:14:TransferHook'], 1);
});

test('daily archive includes calibration ledger and live versus same-size shadow audit', async t => {
  const f = fixture(t), at = f.end - 1000;
  write(path.join(f.dir, 'calibration.json.jsonl'), [{ time: new Date(at).toISOString(), type: 'calibration_receipt',
    batchId: 'batch', side: 'sell', status: 'confirmed', signature: 'sell', sourceSignature: 'signal', pool: 'p', netPnlSol: -.01 }]);
  write(path.join(f.env.SHADOW_DIRECTORY, 'samples-calibration.jsonl'), [{ type: 'execution_comparison', at,
    key: 'signal:p', calibrationRole: 'same_size', status: 'observed_proxy', netPnlSol: -.02, executionPolicy: { sizeSol: .05 } }]);
  const archive = await buildArchive({ c: f.c, outputDir: path.join(f.dir, 'calibration-export'), end: f.end });
  const report = await require('../src/reporting/execution-audit').executionAudit(archive.folder);
  assert.equal(report.calibration.paired, 1);
  assert.equal(report.calibration.rows[0].differenceSol, .01);
});
