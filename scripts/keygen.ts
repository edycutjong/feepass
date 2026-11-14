// Generates an operator key into a file OUTSIDE the repo (default ~/.config/feepass/<name>.env, chmod 600).
// Prints only the public key and addresses; never the private key. Refuses to overwrite an existing file.
import { encodeCashAddress, encodePrivateKeyWif, generatePrivateKey, hash160, secp256k1, binToHex } from '@bitauth/libauth';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const name = process.argv[2];
if (!name || !/^[a-z-]+$/.test(name)) throw new Error('usage: tsx scripts/keygen.ts <name>');
const dir = join(homedir(), '.config', 'feepass');
const file = join(dir, `${name}.env`);
if (existsSync(file)) throw new Error(`${file} exists; refusing to overwrite`);

const priv = generatePrivateKey();
const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
const pkh = hash160(pub);
const addr = (prefix: 'bitcoincash' | 'bchtest', tokens: boolean) =>
  encodeCashAddress({ prefix, type: tokens ? 'p2pkhWithTokens' : 'p2pkh', payload: pkh }).address;
const out = {
  PUBKEY: binToHex(pub),
  MAINNET_ADDRESS: addr('bitcoincash', false),
  MAINNET_TOKEN_ADDRESS: addr('bitcoincash', true),
  CHIPNET_ADDRESS: addr('bchtest', false),
  CHIPNET_TOKEN_ADDRESS: addr('bchtest', true),
};
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(
  file,
  `# FeePass ${name} key, generated ${new Date().toISOString()}. Never commit. Never paste.\n` +
    `WIF_MAINNET=${encodePrivateKeyWif(priv, 'mainnet')}\nWIF_TESTNET=${encodePrivateKeyWif(priv, 'testnet')}\n` +
    Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  { mode: 0o600 },
);
console.log(JSON.stringify({ file, ...out }, null, 2));
