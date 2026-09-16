'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { rsi, candles, flow, exitDecision } = require('../src/stonk/rsi');
const { readConfig } = require('../src/stonk/config');
const env = { HELIUS_API_KEY: 'test', WALLET_PRIVATE_KEY_BS58: 'test-fixture-not-a-key', STONK_STRATEGY: 'rsi', STONK_LIVE_ENABLED: 'true', BIRDEYE_API_KEY: 'do-not-export',
  POSITION_SIZE_SOL: '0.1', MAX_HOLD_MS: '20000' };
const c = readConfig(env);
test('RSI configuration overrides legacy size and hold, disables Shadow, and never exports API key', () => {
  assert.equal(c.sizeSol, .02); assert.equal(c.maxHoldMs, 1800000); assert.equal(c.shadow.enabled, false);
  assert.equal(c.freshSubscriptions.maxAgeMs, 14400000); assert.equal(c.rsi.minFdvUsd, 15000);
  assert(!JSON.stringify(require('../src/reporting/archive').publicConfig(c)).includes('do-not-export'));
});
test('Wilder RSI handles seed, flat, falling, rising and smoothed changes', () => {
  assert.equal(rsi([1,2,3]), null); assert.equal(rsi(Array(9).fill(1)),50);
  assert.equal(rsi([1,2,3,4,5,6,7,8]),100); assert.equal(rsi([8,7,6,5,4,3,2,1]),0);
  assert.equal(rsi([1,2,1,2,1,2,1,2]), 100-100/(1+4/3));
  assert(rsi([1,2,1,2,1,2,1,2,1]) < rsi([1,2,1,2,1,2,1,2]));
});
test('Candles exclude pregraduation and forming bars, sort, and mark empty intervals', () => {
  const b=t=>({unix_time:t,o:1,h:1,l:1,c:1,v:1});
  const a=candles([b(45),b(0),b(60),b(15)],1000,60000);
  assert.deepEqual(a.map(x=>x.at),[15000,30000,45000]); assert.equal(a[1].v,0); assert.equal(a[1].synthetic,true);
});
test('Flow needs real volume, three buyers, recent buying and no new price low', () => {
  const now=100000;
  const a=[{side:'sell',quoteSol:.2,user:'s',receivedAt:now-12000,vaultRatioAfter:1},
    ...[0,1,2].map(i=>({side:'buy',quoteSol:1,user:'b'+i,receivedAt:now-4000+i*1000,vaultRatioAfter:1.1}))];
  assert.equal(flow(a,now,150,c.rsi).pass,true);
  assert.equal(flow(a.map(x=>({...x,quoteSol:.001})),now,150,c.rsi).pass,false);
  assert.equal(flow(a.map(x=>({...x,user:'one'})),now,150,c.rsi).pass,false);
  assert.equal(flow([...a,{side:'sell',quoteSol:2,user:'s',receivedAt:now-1,vaultRatioAfter:.9}],now,150,c.rsi).pass,false);
});
test('RSI exit wins simultaneous activation, strict RSI boundary and stale RSI ignored', () => {
  const p={openedAt:0,entrySol:.02};
  assert.equal(exitDecision(p,{now:1000,rsiValue:80,rsiAt:1000,netSol:.027},c.rsi),null);
  assert.equal(exitDecision(p,{now:1000,rsiValue:81,rsiAt:1000,netSol:.03},c.rsi),'rsi_over_80');
  assert.equal(p.rsiExitOwner,'rsi');
  assert.equal(exitDecision({openedAt:0,entrySol:.02},{now:40000,rsiValue:99,rsiAt:0},c.rsi),null);
});
test('Trailing owner persists, ignores later RSI, exits at ten percent of peak net value', () => {
  const p={openedAt:0,entrySol:.02};
  assert.equal(exitDecision(p,{now:1000,netSol:.028},c.rsi),null); assert.equal(p.rsiExitOwner,'trailing');
  const restored=JSON.parse(JSON.stringify(p));
  assert.equal(exitDecision(restored,{now:2000,netSol:.04,rsiValue:99,rsiAt:2000},c.rsi),null);
  assert.equal(exitDecision(restored,{now:3000,netSol:.0359},c.rsi),'rsi_trailing_10');
});
test('Thirty minute deadline overrides owner even without prices', () => {
  assert.equal(exitDecision({openedAt:0,entrySol:.02,rsiExitOwner:'trailing'},{now:1800000},c.rsi),'rsi_max_hold');
});
test('FDV below threshold closes entry immediately, threshold equality stays eligible', () => {
  const { RsiRuntime }=require('../src/stonk/rsi-runtime');const closed=[];
  const rt={sol:{value:100,at:Date.now()},c, fresh:{pools:{p:{}}},stopObserving:(...args)=>closed.push(args)};
  const state={}; assert.equal(RsiRuntime.prototype.fdv.call(rt,{price:1.5,supplyRaw:'100',pool:'p'},state),true);
  assert.equal(RsiRuntime.prototype.fdv.call(rt,{price:1.49,supplyRaw:'100',pool:'p'},state),false);assert.equal(closed.length,1);
  rt.sol.at=0; assert.equal(RsiRuntime.prototype.fdv.call(rt,{price:0,supplyRaw:'100',pool:'p'},state),false);assert.equal(closed.length,1);
});
test('Expired pools retained for a position, dropped after it closes', () => {
  const { Monitor }=require('../src/stonk/monitor');let held=true;
  const m=new Monitor({}, {now:()=>20000000,retainPool:()=>held});m.log=()=>{};
  m.pools.set('p',{graduatedAt:0});m.expire();assert.equal(m.pools.size,1);
  held=false;m.expire();assert.equal(m.pools.size,0);
});
test('RSI entry ignores original dump/impact thresholds but needs its fresh certified signal', () => {
  const {isSignal}=require('../src/strategy');const now=Date.now();
  const s={market:'stonk',strategy:'rsi',graduatedAt:now-1000,receivedAt:now,eventTime:now,side:'buy',sellSol:0,impact:0,
    rsiSignal:{value:29,expiresAt:now+1000,fdvUsd:15000,flow:{pass:true}}};
  assert.equal(isSignal(s,c),true);assert.equal(isSignal({...s,rsiSignal:{...s.rsiSignal,value:30}},c),false);
  assert.equal(isSignal({...s,graduatedAt:now-14400001},c),false);
});
test('Birdeye rejects wrong pool responses and hides upstream secrets', async () => {
  const {Birdeye}=require('../src/stonk/birdeye');
  const client=new Birdeye('secret',async()=>({ok:true,json:async()=>({success:true,data:{items:[{address:'bad'}]}})}));
  await assert.rejects(client.bars('p',false,0,15000),/pool mismatch/);
  const broken=new Birdeye('secret',async()=>{throw Error('https://secret.invalid/key')});
  await assert.rejects(broken.solPrice(),e=>e.message==='Birdeye request failed');
});
test('RSI live engine journals and submits without old dump filter or Shadow', async () => {
  const {RsiEngine}=require('../src/stonk/rsi-engine'); const now=Date.now(),events=[];
  const store={data:{positions:{},pending:{},cleanup:{},cooldown:{},seen:{},streamDays:{}},save(){},log:(type,fields)=>events.push({type,...fields})};
  let submitted=0;const executor={stonkLive:true,buildSwap:async()=>({signature:'signed-fixture',wire:'fixture',inputAmount:'20000000'}),
    submit:async p=>{assert.equal(store.data.pending[p.signature],p);submitted++}};
  const stream={connected:true,budgetExceeded:()=>false,fresh:{reason:()=>null}};
  const engine=new RsiEngine(c,store,executor,stream);
  const s={market:'stonk',strategy:'rsi',mint:'mint',pool:'pool',signature:'source',graduatedAt:now-1000,receivedAt:now,eventTime:now,
    liquidity:150,side:'buy',sellSol:0,impact:0,rsiSignal:{value:20,expiresAt:now+1000,fdvUsd:20000,flow:{pass:true}}};
  await engine.buy(s);assert.equal(submitted,1);assert(events.some(e=>e.type==='rsi_signal'));
  assert(!events.some(e=>e.type==='live_prebuy_filter'));assert.equal(engine.shadow,null);
});
test('RSI owner and max hold never use old take-profit policy through inherited exitDue', () => {
  const {RsiEngine}=require('../src/stonk/rsi-engine');
  const p={entryPrice:1,lastPrice:2,high:2,openedAt:Date.now(),entrySol:.02};
  const store={data:{positions:{m:p}},save(){},log(){}};
  const e=new RsiEngine(c,store,{},{});assert.equal(e.exitDue(),false);
  p.openedAt-=1800001;assert.equal(e.exitDue(),true);
});
