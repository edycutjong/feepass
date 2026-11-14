// FeePass's one serverless function: the starter-PUSD faucet claim and a health read. Everything else is static.
// Bundled to api/feepass.mjs by `npm run build:api` (Vercel's Node ESM cannot resolve extensionless imports); that bundle is
// committed and is what runs. The faucet key comes from the FAUCET_WIF environment variable, never from the repo.
import { binToHex, decodePrivateKeyWif, encodeCashAddress, hash160, hexToBin, secp256k1, sha256 } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import { handle, IpLimiter, type ApiDeps } from './feepassApi';
import { STARTER_DEFAULTS, type FaucetChain } from '../core/starter';
import { buildBoard } from '../core/lanes';
import { lockingBytecodeOf } from '../core/dust';
import { appPool, config as cfg } from '../core/config';

class ServerChain extends ElectrumNetworkProvider implements FaucetChain {
  constructor() { super('mainnet'); }
  async history(address: string) {
    const scripthash = binToHex(sha256.hash(lockingBytecodeOf(address)).reverse());
    const r = await this.performRequest('blockchain.scripthash.get_history', scripthash);
    if (r instanceof Error) throw r;
    return (r as { tx_hash: string; height: number }[]).map((e) => ({ txid: e.tx_hash, height: e.height }));
  }
  async tipHeight() { return this.getBlockHeight(); }
  async blockTime(height: number) {
    const r = await this.performRequest('blockchain.block.header', height);
    if (r instanceof Error) throw r;
    const h = hexToBin(String(r));
    return new DataView(h.buffer, h.byteOffset).getUint32(68, true);
  }
}

const limiter = new IpLimiter();

function deps(): ApiDeps {
  const wif = process.env.FAUCET_WIF;
  if (!wif) throw new Error('FAUCET_WIF is not set');
  const d = decodePrivateKeyWif(wif);
  if (typeof d === 'string') throw new Error('FAUCET_WIF is not a valid WIF');
  const pub = secp256k1.derivePublicKeyCompressed(d.privateKey) as Uint8Array;
  const pkh = hash160(pub);
  const chain = new ServerChain();
  return {
    chain,
    starter: {
      category: cfg.categoryDisplay,
      faucetPriv: d.privateKey,
      faucetPub: pub,
      faucetAddress: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address,
      faucetTokenAddress: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: pkh }).address,
      ...STARTER_DEFAULTS,
    },
    board: async () => {
      const pool = appPool(cfg, chain);
      return buildBoard(await chain.getUtxos(pool.tokenAddress), { categoryDisplay: cfg.categoryDisplay, laneLock: lockingBytecodeOf(pool.tokenAddress), params: cfg.params, n: cfg.lanes });
    },
  };
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export default {
  async fetch(request: Request): Promise<Response> {
    let d: ApiDeps;
    try {
      d = deps();
    } catch {
      // missing or invalid FAUCET_WIF: never echo the reason (it could name the env var's contents)
      return new Response(JSON.stringify({ error: 'The faucet is not configured.', code: 'UNCONFIGURED' }), { status: 503, headers: JSON_HEADERS });
    }
    try {
      return await handle(request, d, limiter);
    } catch {
      return new Response(JSON.stringify({ error: 'Unexpected error. Try again.', code: 'INTERNAL' }), { status: 500, headers: JSON_HEADERS });
    }
  },
};
