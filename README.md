# About

The **graphinator** is a lightweight alternative to the [superfluid-sentinel](https://github.com/superfluid-finance/superfluid-sentinel).
It looks for [critical or insolvent accounts](https://docs.superfluid.finance/docs/protocol/advanced-topics/solvency/liquidations-and-toga) and liquidates their outgoing flows (CFA and GDA).
Unlike the sentinel, it is stateless and relies on the [Superfluid Subgraph](https://console.superfluid.finance/subgraph) as data source.

By default, the graphinator operates in a _one-shot_ mode, meaning: it checks and liquidates once, then exits.
For continued operation, it's recommended to set up a cronjob.

Once graphinator instance operates for a to-be-specified chain.
By default, it operates on all [listed Super Token](https://console.superfluid.finance/supertokens), but also allows to operate only on a single Super Token.

## Prerequisites

Install Bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

Set up the repo and install dependencies:
```bash
git clone https://github.com/superfluid-finance/graphinator
cd graphinator
bun install
```

## Run

```
PRIVATE_KEY=... ./grt.ts -n <network>
```

_network_ needs to be the canonical name of a chain where Superfluid is deployed. See [metadata/networks.json](https://github.com/superfluid-finance/protocol-monorepo/blob/dev/packages/metadata/networks.json) (field _name_). For example `base-mainnet`.

You can also provide `PRIVATE_KEY` via an `.env` file.

Make sure `grt.ts` is executable.

See `./grt.ts --help` for more config options.

## Gas price strategy

Graphinator can be configured to make sound decisions despite gas price swings, with the following priorities:
- don't let high-value flows slip through
- don't let gas price spikes drain the sender account
- don't let dust flows open forever

This is achieved by using 3 configuration parameters:
- _reference gas price limit_: this is the limit which should be applied to a reference flow with a flowrate worth 1$ per day. For all flows with known value (meaning, the token price is known to the application) the limit is set proportionally to this reference value.
E.g. if this limit were set to 1 gwei and a flow worth 1000 $/day were critical, graphinator would bid up to 1000 gwei in order to liquidate it.
This proportionality makes sure that an attacker couldn't take advantage of gas price spikes with a times insolvency.
- _fallback gas price limit_: if the token price and thus the value of the flow isn't known, this limit is applied. It will usually be set higher than the reference limit, but still low enough to not risk the account being drained for likely not very urgent liquidations (assuming it's mostly less important tokens we don't know the price for).
- _minimum gas price limit_: since most tokens don't have a minimum deposit set, there can be a lot of "dust streams" out there which are never really worth liquidating.
In case we won't those liquidated anyway, setting this value to a value which is at least occasionally above the chain's gas price makes sure those flows don't linger on insolvent forever.

Limitation: the current implementation does not take into account the min deposit setting of a token.

Token prices are taken from `data/token_prices.json` which can be updated running `bun utils/update-token-prices.js` (you need to provide an env var `COINGECKO_API_KEY`). This prices don't need to be very accurate thus don't need frequent updating.

## License

[MIT](https://choosealicense.com/licenses/mit/)