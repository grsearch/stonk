'use strict';
const MESSAGES = new Map([
  ['Unsupported mint extension', 'unsupported_mint_extension'], ['Active quote transfer hook unsupported', 'active_quote_transfer_hook'],
  ['Quote mint paused', 'quote_mint_paused'], ['Invalid quote mint extension', 'invalid_quote_extension'],
  ['Graduation window ended', 'graduation_window_end'], ['Stale valuation', 'stale_valuation'],
  ['No fresh on-chain quote/SOL valuation', 'no_fresh_raydium_valuation'], ['CPMM identity mismatch', 'cpmm_identity_mismatch'],
  ['Invalid vault', 'invalid_vault'], ['Invalid CPMM pool', 'invalid_cpmm_pool'], ['Invalid CLMM pool', 'invalid_clmm_pool'],
  ['Missing chain block time', 'missing_chain_time'], ['History transaction temporarily unavailable', 'history_transaction_unavailable'],
  ['RPC daily budget exhausted', 'rpc_daily_budget'], ['Stale account state', 'stale_account_state'],
]);
function diagnostic(error) {
  const message = String(error?.message || '');
  const http = /^RPC HTTP (\d+)$/.exec(message), rpc = /^RPC code (-?\d+)$/.exec(message);
  return { reason: MESSAGES.get(message) || (http ? 'rpc_http_error' : rpc ? 'rpc_error' :
    ['TimeoutError', 'AbortError'].includes(error?.name) ? 'request_timeout_or_abort' : 'account_or_transport_error'),
    ...(http ? { httpStatus: Number(http[1]) } : {}), ...(rpc ? { rpcCode: Number(rpc[1]) } : {}) };
}
module.exports = { diagnostic };
