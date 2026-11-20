# FeePass and its neighbours

FeePass solves one problem: a wallet that holds PUSD but no spendable BCH cannot pay the miner fee. These are other BCH BLAZE 2026
projects in the same neighbourhood, read from their gallery pitches on 2026-11-20, and where FeePass stops and they start.

| Project | What it does | Boundary with FeePass |
|---|---|---|
| Kvit | Payment links on mainnet; the pitch says the client pays from any wallet | From its pitch the payer's fee is paid in BCH. FeePass is a layer a payment app could sit on; we have not tested any integration. |
| Cobra | Voice-note invoices paid in BCH or PUSD on mainnet | Same boundary: FeePass does not create invoices and has not been integrated with it. |
| Nito Cash | A wallet for newcomers with a PUSD shielded pool | Same audience, different problem (privacy). FeePass does not hide amounts or addresses. |
| blaze | A WizardConnect transaction skeleton | Same wallet-connect plumbing. We did not see a sponsored fee in its pitch; FeePass is built around one. |

FeePass is a fee layer, not a payment app. It has no invoices, no escrow and no privacy features, and it would work with a wallet that can
sign the fixed transaction shape through WizardConnect; no named wallet has been tested yet.
