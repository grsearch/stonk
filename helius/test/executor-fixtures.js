'use strict';
const { PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const BN = require('bn.js');
const bs58 = require('bs58').default;
const Executor = require('../src/executor');
const { readConfig, WSOL, PUMP } = require('../src/config');
const { key } = require('./fixtures');

function executor() {
  const wallet = Keypair.generate();
  const c = readConfig({ HELIUS_API_KEY: 'test', DRY_RUN: 'false', WALLET_PRIVATE_KEY_BS58: bs58.encode(wallet.secretKey) });
  const e = new Executor(c, { log() {} });
  e.blockhash = { blockhash: key(20), lastValidBlockHeight: 2000, at: Date.now() };
  return e;
}
function accountInfo(mint, owner, amount = 0n, program = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { data, owner: program, executable: false, lamports: 2039280, rentEpoch: 0 };
}
function state(e, cashback = false) {
  const pub = n => new PublicKey(key(n)), user = e.wallet.publicKey, baseMint = pub(4), quoteMint = new PublicKey(WSOL);
  const poolKey = pub(1);
  const fees = { lpFeeBps: new BN(20), protocolFeeBps: new BN(5), creatorFeeBps: new BN(5) };
  return {
    poolKey, user, poolAccountInfo: { data: Buffer.alloc(300) },
    pool: { baseMint, quoteMint, poolBaseTokenAccount: pub(7), poolQuoteTokenAccount: pub(8), coinCreator: pub(11), creator: pub(12),
      isCashbackCoin: cashback, isMayhemMode: false, virtualQuoteReserves: new BN(0) },
    globalConfig: { protocolFeeRecipients: [pub(9)], buybackFeeRecipients: [pub(10)], buybackBasisPoints: new BN(0) },
    feeConfig: { flatFees: fees, feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees }] },
    baseMint, baseMintAccount: { supply: 1000000000000000n, decimals: 6 },
    poolBaseAmount: new BN('1000000000000'), poolQuoteAmount: new BN('200000000000'),
    baseTokenProgram: TOKEN_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID,
    userBaseTokenAccount: getAssociatedTokenAddressSync(baseMint, user), userQuoteTokenAccount: getAssociatedTokenAddressSync(quoteMint, user),
    userBaseAccountInfo: null, userQuoteAccountInfo: null,
  };
}

module.exports = { executor, state, accountInfo };
