# FeePass and its neighbours

FeePass solves one problem: a wallet that holds PUSD but no spendable BCH cannot pay the miner fee. These are other BCH BLAZE 2026
projects in the same neighbourhood, read from their public BUIDL pages on 2026-11-20, and where FeePass stops and they start.

| Project | What it does | Boundary with FeePass |
|---|---|---|
| Kvit | PUSD payment flow on mainnet | The payer still needs BCH for the miner fee. FeePass is the layer under it: a Kvit-style app could build its send as a FeePass transaction. |
| Cobra | Invoices and WizardConnect payments in PUSD on mainnet | Same boundary: the payer needs BCH for the fee today. FeePass does not create invoices. |
| Nito Cash | A wallet for newcomers with a PUSD shielded pool | Same audience, different problem (privacy). FeePass does not hide amounts or addresses. |
| blaze | A WizardConnect transaction skeleton | Same wallet-connect plumbing. It has no sponsored fee; FeePass adds the covenant that pays it. |

FeePass is a fee layer, not a payment app. It has no invoices, no escrow and no privacy features, and it works with any wallet that can
sign the fixed transaction shape through WizardConnect (which wallets do is recorded in `evidence/` as it is tested).
