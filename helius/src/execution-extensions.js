'use strict';
const { unpackMint } = require('@solana/spl-token');
const { inspectExtensions } = require('./shadow/account-extensions');
// Execution v1 intentionally accepts only metadata on mints and ImmutableOwner on accounts.
// The shared parser validates TLV layout; this wrapper is the explicit execution policy.
function executionAccount(info, role, kind, address, program, emit = () => {}) {
  const d = inspectExtensions(info, role, kind, address, program);
  emit({ version: 1, ...d });
  if (d.status !== 'supported') throw new Error(`Execution token account rejected: ${role}: ${d.reason}`);
  if (kind === 'mint') {
    const mint = unpackMint(address, info, program);
    if (!mint.isInitialized || mint.freezeAuthority) throw new Error('Mint uninitialized or has freeze authority');
    return mint;
  }
}
module.exports = { executionAccount };
