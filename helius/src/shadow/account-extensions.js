'use strict';
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType: E } = require('@solana/spl-token');
// Allowlist for raw-reserve research only, not permission to execute transfers.
const MINT_ALLOWED = new Set([E.MetadataPointer, E.TokenMetadata]);
const ACCOUNT_ALLOWED = new Set([E.ImmutableOwner]);
function validMetadata(data, mint) {
  if (data.length < 80 || !data.subarray(32, 64).equals(mint.toBuffer())) return false;
  let at = 64;
  const string = () => {
    if (at + 4 > data.length) return false;
    const n = data.readUInt32LE(at); at += 4;
    if (n > data.length - at) return false; at += n; return true;
  };
  if (!string() || !string() || !string() || at + 4 > data.length) return false;
  const count = data.readUInt32LE(at); at += 4;
  if (count > (data.length - at) / 8) return false;
  for (let i = 0; i < count; i++) if (!string() || !string()) return false;
  return at === data.length;
}
function inspectExtensions(info, role, kind, address, program) {
  const d = { role, address: address.toBase58(), owner: info.owner.toBase58(), dataLength: info.data.length,
    extensions: [], blockedExtensions: [], status: 'supported' };
  const reject = reason => { d.status = 'rejected'; d.reason = reason; return d; };
  const data = info.data, size = kind === 'mint' ? 82 : 165;
  if (!info.owner.equals(program)) return reject('invalid_token_program');
  if (data.length < size || data.length > 65536 || data.length === 355) return reject('invalid_extension_layout');
  if (data.length === size) return d;
  if (program.equals(TOKEN_PROGRAM_ID)) return reject('legacy_account_size_mismatch');
  if (!program.equals(TOKEN_2022_PROGRAM_ID)) return reject('invalid_token_program');
  if (data.length < 166 || data[165] !== (kind === 'mint' ? 1 : 2)) return reject('invalid_extension_layout');
  if (kind === 'mint' && data.subarray(82, 165).some(x => x !== 0)) return reject('invalid_extension_layout');
  const allowed = kind === 'mint' ? MINT_ALLOWED : ACCOUNT_ALLOWED, seen = new Set();
  let at = 166;
  while (at < data.length) {
    if (data.length - at < 4) {
      if (data.subarray(at).every(x => x === 0)) break;
      return reject('invalid_extension_layout');
    }
    const type = data.readUInt16LE(at), length = data.readUInt16LE(at + 2); at += 4;
    if (type === 0) {
      if (length === 0 && data.subarray(at).every(x => x === 0)) break;
      return reject('invalid_extension_layout');
    }
    const extension = { type, name: E[type] || 'Unknown', length };
    d.extensions.push(extension);
    if (seen.has(type) || seen.size >= 128 || length > data.length - at) return reject('invalid_extension_layout');
    seen.add(type);
    if (!allowed.has(type)) d.blockedExtensions.push(extension);
    else if ((type === E.ImmutableOwner && length !== 0) || (type === E.MetadataPointer && length !== 64)
      || (type === E.TokenMetadata && !validMetadata(data.subarray(at, at + length), address))) return reject('invalid_extension_layout');
    at += length;
  }
  if (d.blockedExtensions.length) return reject('unsupported_extensions');
  return d;
}
module.exports = { inspectExtensions };
