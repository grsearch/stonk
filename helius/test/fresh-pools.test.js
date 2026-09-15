'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { FreshPools, WINDOW } = require('../src/fresh-pools');
const { PoolSubscriptions } = require('../src/pool-subscriptions');
const { WSOL, PUMP } = require('../src/config');
const now = 10000000;
const event = { pool: 'pool', mint: 'mint', migrationAt: now, createdAt: now, observedAt: now, source: 'pump_migrate_processed', slot: 1, quoteVault: 'vault' };
function setup() { const store={data:{positions:{},pending:{}},save(){},log(){}};return {store, f:new FreshPools(store)}; }
test('missing initial reserve stays subscribed but cannot buy, valid balance unlocks',()=>{
  const {f}=setup();f.created(event,now);
  assert.deepEqual(f.addresses(now),['pool']);assert.equal(f.reason(event,now),'fresh_pool_reserve_unknown');
  f.reserve('pool',null,2,now);f.reserve('pool',NaN,2,now);assert.equal(f.reason(event,now),'fresh_pool_reserve_unknown');
  f.reserve('pool',50,2,now);assert.equal(f.reason(event,now),null);
});
test('strict below50 closes permanently including after restart and rediscovery',()=>{
  const {store,f}=setup();f.created({...event,reserveSol:100},now);f.reserve('pool',49.999,2,now);
  assert.deepEqual(f.addresses(now),[]);const restored=new FreshPools(store);
  restored.created({...event,reserveSol:200},now);restored.reserve('pool',200,3,now);
  assert.equal(restored.reason(event,now),'reserve_below_50');assert.deepEqual(restored.addresses(now),[]);
});
test('30 minute boundary and positions/pending retain exit-only subscription',()=>{
  const {store,f}=setup();f.created({...event,reserveSol:100},now);
  assert.equal(f.reason(event,now+WINDOW-1),null);assert.equal(f.reason(event,now+WINDOW),'graduation_age_30_minutes');
  store.data.positions.mint={pool:'pool'};store.data.pending.sig={swap:{pool:'pendingPool'}};
  assert.deepEqual(f.addresses(now+WINDOW),['pendingPool','pool']);
  delete store.data.positions.mint;delete store.data.pending.sig;assert.deepEqual(f.addresses(now+WINDOW),[]);
  f.created({...event,reserveSol:100},now+WINDOW);assert.deepEqual(f.addresses(now+WINDOW),[]);
});
test('only exact WSOL vault balances resolve unknown; missing and wrong mint do not',()=>{
  const {f}=setup();f.created(event,now);
  const tx={keys:['vault'],slot:2,meta:{postTokenBalances:[{accountIndex:0,mint:'other',uiTokenAmount:{decimals:9,amount:'0'}}]}};
  f.transaction(tx);assert.equal(f.reason(event,now),'fresh_pool_reserve_unknown');
  tx.meta.postTokenBalances[0].mint=WSOL;tx.meta.postTokenBalances[0].uiTokenAmount.amount='100000000000';f.transaction(tx);
  assert.equal(f.reason(event,now),null);f.reserve('pool',0,1,now);assert.equal(f.reason(event,now),null);
  tx.slot=3;tx.meta.postTokenBalances[0].uiTokenAmount.amount='0';f.transaction(tx);assert.equal(f.reason(event,now),'reserve_below_50');
});
test('discovery uses both programs and replacement ack precedes unsubscribe',()=>{
  const sent=[];let failures=0;const c=new PoolSubscriptions(x=>sent.push(x),()=>failures++,()=>{});
  c.start();assert.deepEqual(sent[0].params[0].accountRequired,[require('../src/migration-layout.json').address,PUMP]);
  assert.equal(sent[0].params[0].accountInclude,undefined);c.ack({id:1,result:10});c.update(['a']);
  assert.equal(sent.at(-1).method,'transactionSubscribe');c.ack({id:2,result:11});c.update(['b']);
  assert.equal(sent.at(-1).method,'transactionSubscribe');assert.equal(sent.filter(x=>x.method==='transactionUnsubscribe').length,0);
  c.ack({id:3,result:12});assert.deepEqual(sent.at(-1).params,[11]);c.ack({id:4,result:true});
  assert.equal(c.roles.has(11),false);c.update([]);assert.deepEqual(sent.at(-1).params,[12]);assert.equal(failures,0);
});
test('subscription error and deadline terminate transport rather than silently lose pools',()=>{
  const sent=[];let failures=0;const c=new PoolSubscriptions(x=>sent.push(x),()=>failures++,()=>{});
  c.start();c.pending.get(1).at=0;c.update([]);assert.equal(failures,1);
  c.ack({id:1,error:{code:-1}});assert.equal(failures,2);
});

test('Stonk observes through 30 minutes and closes exactly at two hours', () => {
 const now=Date.now(); const store={data:{},save(){},log(){}};
 const f=new FreshPools(store,{market:'stonk'});
 const e={source:'stonk_migrate_confirmed',migrationAt:now,createdAt:now,pool:'s',mint:'m',reserveSol:150,slot:1};
 f.created(e,now);
 assert.equal(f.reason(e,now+1800000),null);
 assert.equal(f.reason(e,now+7199999),null);
 assert.equal(f.reason(e,now+7200000),'graduation_age_2_hours');
 assert.deepEqual(f.addresses(now+7200000),[]);
});
