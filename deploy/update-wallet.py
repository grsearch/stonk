#!/usr/bin/env python3
"""Update the server's Solana key without shell history or terminal echo."""
import getpass
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path('/opt/stonk-monitor/helius')
ENV = ROOT / '.env'
VALIDATE = """
const fs = require('fs');
try {
  const text = fs.readFileSync(0, 'utf8').trim();
  const bytes = require('bs58').default.decode(text);
  if (bytes.length !== 64) throw Error();
  const key = require('@solana/web3.js').Keypair.fromSecretKey(bytes);
  process.stdout.write(key.publicKey.toBase58());
} catch (_) { process.exit(2); }
"""

def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo python3 /opt/stonk-monitor/deploy/update-wallet.py')
    if not ENV.is_file() or ENV.is_symlink():
        raise SystemExit('Expected a regular server .env file.')
    if '--check' in sys.argv:
        subprocess.run(['node', '-e', "require('bs58'); require('@solana/web3.js')"], cwd=ROOT, check=True)
        print('Wallet updater ready. No key read or changed.')
        return
    if not sys.stdin.isatty():
        raise SystemExit('Use an interactive SSH terminal; do not pipe a key.')
    secret = getpass.getpass('Solana Base58 private key (hidden): ').strip()
    result = subprocess.run(['node', '-e', VALIDATE], cwd=ROOT, input=secret,
                            text=True, capture_output=True, timeout=15)
    if result.returncode or not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', result.stdout):
        raise SystemExit('Invalid 64-byte Solana Base58 key. Nothing changed.')
    content = ENV.read_text()
    line = 'WALLET_PRIVATE_KEY_BS58=' + secret
    pattern = r'^WALLET_PRIVATE_KEY_BS58=.*$'
    content = re.sub(pattern, lambda _: line, content, flags=re.M) if re.search(pattern, content, re.M) else content + '\n' + line + '\n'
    stat = ENV.stat()
    fd, temporary = tempfile.mkstemp(prefix='.wallet-', dir=ROOT)
    try:
        os.fchown(fd, stat.st_uid, stat.st_gid)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, ENV)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('Wallet address: ' + result.stdout)
    print('Key saved. Trading was NOT enabled and services were NOT restarted.')

if __name__ == '__main__':
    main()
