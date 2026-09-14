'use strict';
const path = require('node:path');
const envFile = path.join(__dirname, '../.env');
if (require('node:fs').existsSync(envFile)) process.loadEnvFile(envFile);

function readConfig(env = process.env) {
  function num(name, fallback, min, max, integer = false) {
    const n = Number(env[name] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      throw new Error(`Invalid ${name}: expected ${integer ? 'integer' : 'number'} in [${min}, ${max}]`);
    }
    return n;
  }
  function bool(name, fallback) {
    const value = String(env[name] ?? fallback).toLowerCase();
    if (!['true', 'false'].includes(value)) throw new Error(`Invalid ${name}`);
    return value === 'true';
  }
  function endpoint(value, protocols) {
    const u = new URL(value);
    if (!protocols.includes(u.protocol) || !(u.hostname.endsWith('.helius-rpc.com') || u.hostname.endsWith('.helius.xyz')) || u.username || u.password) {
      throw new Error('Only Helius endpoints are allowed');
    }
    return u.toString();
  }
  const apiKey = env.HELIUS_API_KEY || '';
  const dryRun = bool('DRY_RUN', true);
  const calibration = bool('LIVE_CALIBRATION', false);
  const senderUrl = endpoint(env.HELIUS_SENDER_URL || 'http://slc-sender.helius-rpc.com/fast', ['http:', 'https:']);
  const swqos = new URL(senderUrl).searchParams.get('swqos_only') === 'true';
  const c = {
    dryRun, apiKey, liveFixedStopLoss: false,
    // Separate live settings so retained .env research thresholds cannot override deployment.
    liveExitPolicy: dryRun ? null : { version: 1, takeProfit: 10, trailArm: 8, trailDrop: 3, maxHoldMs: 20000 },
    freshSubscriptions: { version: 1, maxAgeMs: 1800000, exitReserveBelowSol: 50 },
    liveEntryPolicy: { version: 1, reserveExclusiveSol: 100, lossCooldownMs: 600000, waitMs: 500, maxWaiters: 16 },
    calibration: { enabled: calibration, maxBuys: null, lossLimitSol: null, referenceSizeSol: 1 },
    paperPrebuyFilter: bool('PAPER_PREBUY_FILTER', true),
    rpcUrl: endpoint(env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, ['https:']),
    wsUrl: endpoint(env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, ['wss:']),
    senderUrl,
    privateKey: env.WALLET_PRIVATE_KEY_BS58 || '',
    stateFile: path.resolve(__dirname, '..', env.STATE_FILE || (calibration ? 'data/calibration.json' : `data/${dryRun ? 'paper' : 'live'}.json`)),
    minSellSol: num('MIN_SELL_SOL', 8, 0.001, 1e9),
    minImpact: num('MIN_PRICE_IMPACT_PCT', 10, 0, 99),
    maxImpact: num('MAX_PRICE_IMPACT_PCT', 30, 0, 99),
    minLiquidity: num('MIN_POOL_QUOTE_SOL', 30, 0, 1e9),
    sizeSol: calibration ? num('CALIBRATION_SIZE_SOL', 0.05, 0.001, 0.05) : num('POSITION_SIZE_SOL', 1, 0.000001, 1000),
    maxPositions: calibration ? num('CALIBRATION_MAX_POSITIONS', 20, 1, 20, true) : num('MAX_CONCURRENT_POSITIONS', 20, 1, 30, true),
    cooldownMs: num('COOLDOWN_MS', 30000, 0, 86400000, true),
    maxSignalAgeMs: num('MAX_SIGNAL_AGE_MS', 2500, 250, 10000, true),
    takeProfit: num('TAKE_PROFIT_PCT', 20, 0.1, 10000),
    stopLoss: num('STOP_LOSS_PCT', 25, 0.1, 99),
    trailArm: num('TRAILING_ACTIVATE_PCT', 10, 0, 1000),
    trailDrop: num('TRAILING_DRAWDOWN_PCT', 3, 0.1, 99),
    maxHoldMs: num('MAX_HOLD_MS', 1800000, 1000, 604800000, true),
    buySlippageBps: num('BUY_SLIPPAGE_BPS', 1000, 1, 3000, true),
    sellSlippageBps: num('SELL_SLIPPAGE_BPS', 1500, 1, 5000, true),
    closeAfterMs: num('CLOSE_ACCOUNT_AFTER_MS', 7200000, 1000, 2592000000, true),
    cleanupIntervalMs: num('CLEANUP_INTERVAL_MS', 60000, 1000, 3600000, true),
    blockhashMs: num('BLOCKHASH_REFRESH_MS', 15000, 1000, 25000, true),
    positionPollMs: num('POSITION_POLL_MS', 15000, 2000, 300000, true),
    quoteTimeoutMs: num('QUOTE_TIMEOUT_MS', 10000, 1000, 300000, true),
    computeUnits: num('COMPUTE_UNIT_LIMIT', 300000, 100000, 1400000, true),
    priorityLamports: num('PRIORITY_FEE_LAMPORTS', 100000, 1, 100000000, true),
    tipLamports: num('SENDER_TIP_LAMPORTS', swqos ? 5000 : 200000, swqos ? 5000 : 200000, 100000000, true),
    maxBytesPerDay: num('MAX_STREAM_MB_PER_DAY', 0, 0, 1e7) * 1e6,
    maxCandidatesPerMinute: num('MAX_CANDIDATES_PER_MINUTE', 6, 1, 1000, true),
    shadow: {
      enabled: bool('SHADOW_ENABLED', true),
      directory: path.resolve(__dirname, '..', env.SHADOW_DIRECTORY || 'data/shadow'),
      modelFile: env.SHADOW_MODEL_FILE ? path.resolve(__dirname, '..', env.SHADOW_MODEL_FILE) : null,
      riskModelFile: env.SHADOW_RISK_MODEL_FILE ? path.resolve(__dirname, '..', env.SHADOW_RISK_MODEL_FILE) : null,
      drawdownModelFile: env.SHADOW_DRAWDOWN_MODEL_FILE ? path.resolve(__dirname, '..', env.SHADOW_DRAWDOWN_MODEL_FILE) : null,
      returnModelFile: env.SHADOW_RETURN_MODEL_FILE ? path.resolve(__dirname, '..', env.SHADOW_RETURN_MODEL_FILE) : null,
      exitComparisons: bool('SHADOW_EXIT_COMPARISONS', true),
      stateQuotes: bool('SHADOW_STATE_QUOTES', true),
      stateQuoteRequestsPerMinute: num('SHADOW_STATE_QUOTE_REQUESTS_PER_MINUTE', 10, 1, 60, true),
      stateQuoteIntervalMs: num('SHADOW_STATE_QUOTE_INTERVAL_MS', 15000, 5000, 300000, true),
      maxActive: num('SHADOW_MAX_ACTIVE', 1000, 1, 10000, true),
      maxActivePerPool: num('SHADOW_MAX_ACTIVE_PER_POOL', 100, 1, 1000, true),
      maxPools: num('SHADOW_MAX_POOLS', 5000, 10, 20000, true),
      maxHistoryEvents: num('SHADOW_MAX_HISTORY_EVENTS', 100000, 100, 500000, true),
      maxEventsPerPool: num('SHADOW_MAX_EVENTS_PER_POOL', 2000, 10, 10000, true),
      minHistorySwaps: num('SHADOW_MIN_HISTORY_SWAPS', 10, 2, 1000, true),
      entryDelayMs: num('SHADOW_ENTRY_DELAY_MS', 500, 1, 10000, true),
      entryComparisons: bool('SHADOW_ENTRY_COMPARISONS', true),
      entryDeadlineMs: num('SHADOW_ENTRY_DEADLINE_MS', 2500, 1, 30000, true),
      exitDelayMs: num('SHADOW_EXIT_DELAY_MS', 500, 1, 10000, true),
      maxGapMs: num('SHADOW_MAX_OBSERVATION_GAP_MS', 10000, 1000, 30000, true),
      feeBps: num('SHADOW_SWAP_FEE_BPS', 100, 0, 3000, true),
      slippageBps: num('SHADOW_SLIPPAGE_BPS', 100, 0, 3000, true),
      reboundPct: num('SHADOW_REBOUND_PCT', 5, 0.1, 100),
      experimentMaxSellSol: num('SHADOW_EXPERIMENT_MAX_SELL_SOL', 40, 8, 100000),
      experimentLossCooldownMs: num('SHADOW_EXPERIMENT_LOSS_COOLDOWN_MS', 600000, 30000, 86400000, true),
    },
  };
  if (calibration && (dryRun || !c.shadow.enabled)) throw new Error('LIVE_CALIBRATION requires live mode and SHADOW_ENABLED');
  if (c.shadow.entryDelayMs > c.shadow.entryDeadlineMs) throw new Error('SHADOW_ENTRY_DELAY_MS exceeds entry deadline');
  if (c.minImpact > c.maxImpact) throw new Error('MIN_PRICE_IMPACT_PCT exceeds maximum');
  if (!apiKey && !env.HELIUS_RPC_URL) throw new Error('HELIUS_API_KEY is required');
  if (!dryRun && !c.privateKey) throw new Error('WALLET_PRIVATE_KEY_BS58 is required in live mode');
  return c;
}
const PUMP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';
module.exports = { readConfig, PUMP, WSOL };
