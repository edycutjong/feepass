// Protocol-level wallet-compatibility check over the REAL WizardConnect relay: a headless wallet (@wizardconnect/wallet) connects to a
// dapp (@wizardconnect/dapp), shares its path xpubs, receives the shape-(a) sponsored-send request (covenant input in
// sourceOutputs, user input in inputPaths), signs input 0 with sighash 0x61, and the dapp verifies the result.
// The coins are mock (MockNetworkProvider evaluates the signed tx in the VM); the relay hop is real.
// Proves the request survives WizardConnect serialization and a conforming wallet can sign it.
// It does NOT prove Selene or Paytaca sign it — that is the human wallet check.
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { WalletConnectionManager, DerivationPath, type WalletAdapter } from '@wizardconnect/wallet';
import {
  deriveHdPath, deriveHdPrivateNodeChild, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey,
  sha256, utf8ToBin, type HdPrivateNodeValid,
} from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { writeFileSync } from 'node:fs';
import { deriveAddresses } from '../src/core/hdAddresses';
import { poolContract } from '../src/core/pool';
import { buildSponsoredSend } from '../src/core/sponsoredSend';
import { signWcTransaction } from '../src/core/headlessSigner';
import { toWizardRequest, verifySignedTx } from '../src/core/wizard';
import { lockingBytecodeOf } from '../src/core/dust';
import { DEFAULT_PARAMS, PUSD_CATEGORY_DISPLAY as CAT } from '../src/core/params';
import gate from '../src/config/gate.json';

const seed = sha256.hash(utf8ToBin('feepass relay roundtrip test seed (no funds)'));
const master = deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }) as HdPrivateNodeValid;
const account = deriveHdPath(master, "m/44'/145'/0'") as HdPrivateNodeValid;
const branch = (p: DerivationPath) => deriveHdPrivateNodeChild(account, p) as HdPrivateNodeValid;
const branchByName: Record<string, number> = { receive: 0, change: 1, defi: 7 };
let signRequests = 0;

const adapter: WalletAdapter = {
  walletName: 'FeePass headless test wallet',
  walletIcon: '',
  getRelayPrivateKey: (uri) => sha256.hash(utf8ToBin(`relay:${uri}`)),
  getPublicKey: (p, i) => deriveHdPublicNode(deriveHdPrivateNodeChild(branch(p), Number(i)) as HdPrivateNodeValid).publicKey,
  getXpub: (p) => encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(branch(p)) }).hdPublicKey,
  async signTransaction(req) {
    signRequests++;
    const keys = new Map(req.inputPaths.map(([input, path, idx]) => [
      input, (deriveHdPrivateNodeChild(deriveHdPrivateNodeChild(account, branchByName[path]!) as HdPrivateNodeValid, idx) as HdPrivateNodeValid).privateKey,
    ]));
    return { signedTransaction: signWcTransaction(req.transaction, keys) };
  },
};

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);

async function main() {
  const t0 = Date.now();
  const dapp = new DappConnectionManager('FeePass relay test', undefined, { session: false });
  const relay = initiateDappRelay((s) => dapp.updateConnection(s.client, s.status));
  dapp.attachRelay(relay);
  const ready = new Promise<void>((res) => dapp.on('walletready', () => res()));

  const wallet = new WalletConnectionManager(adapter);
  wallet.on('pendingSignRequest', async ({ connectionId, request }) => {
    const r = await adapter.signTransaction(request);
    await wallet.sendSignResponse(connectionId, request.sequence, r.signedTransaction);
  });
  wallet.connect(relay.uri);
  await timeout(ready, 30_000, 'wallet_ready');
  const tReady = Date.now();

  const paths = dapp.getSessionPaths();
  const addrs = deriveAddresses(paths, 2, 'bchtest'); // mock network = bchtest prefix (CashScript refuses cross-network outputs)
  const me = addrs.find((a) => a.pathName === 'receive' && a.addressIndex === 1)!;

  const provider = new MockNetworkProvider();
  const pool = poolContract({ ...DEFAULT_PARAMS, ownerPk: gate.ownerPk, categoryDisplay: CAT }, provider);
  const coin = provider.addUtxo(me.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: CAT, amount: 200n } }));
  const lane = provider.addUtxo(pool.tokenAddress, randomUtxo({ satoshis: 100_000n, token: { category: CAT, amount: 1n } }));
  const send = buildSponsoredSend({ pool, params: DEFAULT_PARAMS, categoryDisplay: CAT, userUtxo: coin, userAddress: me.tokenAddress, lane, recipient: me.tokenAddress, amount: 10n });
  const req = toWizardRequest(send, { pathName: me.pathName, addressIndex: me.addressIndex }, 'relay test');

  const res = await timeout(dapp.signTransaction({ transaction: req.wire as never, inputPaths: req.inputPaths }), 30_000, 'sign response');
  if (res.error) throw new Error(`wallet error: ${res.error}`);
  const v = verifySignedTx(res.signedTransaction, req.proposed, lockingBytecodeOf(me.tokenAddress));
  const accepted = await provider.sendRawTransaction(res.signedTransaction);

  const out = {
    ranAt: new Date().toISOString(),
    packages: { '@wizardconnect/core': '0.2.10', '@wizardconnect/dapp': '0.2.7', '@wizardconnect/wallet': '0.2.4' },
    relayUri: relay.uri.replace(/s=[^&]+/, 's=<redacted>'),
    sharedPaths: paths.map((p) => p.name),
    inputPaths: req.inputPaths,
    signRequestsSeenByWallet: signRequests,
    verified: { sighash: '0x' + v.sighashType.toString(16), sizeBytes: v.sizeBytes, feeSats: Number(v.feeSats), txid: v.txid },
    vmAccepted: accepted === v.txid,
    msToWalletReady: tReady - t0,
    msTotal: Date.now() - t0,
    scope: 'protocol-level: real relay, mock coins, headless conforming wallet; not a Selene/Paytaca result',
  };
  writeFileSync(new URL('../evidence/relay-roundtrip.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  await dapp.sendDisconnect().catch(() => {});
  await dapp.destroy();
  relay.cleanup();
  wallet.disconnectAll();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
