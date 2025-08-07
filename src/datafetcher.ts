import axios, {type AxiosResponse } from 'axios';
import {Contract, type AddressLike, JsonRpcProvider, ethers} from "ethers";
import type { CriticalAccount, Flow } from "./types/types.ts";
import { AgreementType } from "./types/types.ts";
const ISuperTokenAbi = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/interfaces/superfluid/ISuperToken.sol/ISuperToken.json").abi;

const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);
const MAX_ITEMS = 1000;
const ZERO = BigInt(0);

// Fetches data using subgraph and rpc
class DataFetcher {

    private subgraphUrl: string;
    private provider: JsonRpcProvider;

    /**
     * Creates an instance of DataFetcher.
     * @param subgraphUrl - The URL of the subgraph endpoint.
     * @param provider - The JSON RPC provider.
     */
    constructor(subgraphUrl: string, provider: JsonRpcProvider) {
        if(!subgraphUrl) {
            throw new Error("subgraph URL not set");
        }
        this.subgraphUrl = subgraphUrl;
        this.provider = provider;
    }

    /**
     * Fetches flows to liquidate based on the given token, GDA forwarder contract, and deposit consumed percentage threshold.
     * @param token - The address of the token.
     * @param gdaForwarder - The GDA forwarder contract.
     * @param depositConsumedPctThreshold - The deposit consumed percentage threshold.
     * @returns A promise that resolves to an array of Flow objects.
     */
    async getFlowsToLiquidate(token: AddressLike, gdaForwarder: Contract, depositConsumedPctThreshold: number): Promise<Flow[]> {

        const returnData: Flow[] = [];
        const criticalAccounts = await this.getCriticalAccountsByTokenNow(token, process.env.LIQUIDATE_ALL ? false : true);
        const targetToken = new Contract(token.toString(), ISuperTokenAbi, this.provider);

        if (criticalAccounts.length > 0) {
            console.log(`Found ${criticalAccounts.length} maybe-critical accounts`);
            for (const account of criticalAccounts) {
                // ONLY_ACCOUNT is just for testing
                if (process.env.ONLY_ACCOUNT && account.account.id !== process.env.ONLY_ACCOUNT) {
                    continue;
                }
                // TODO: totalNetFlowrate seems to only be CFA.
                log(`? Probing ${account.account.id} token ${account.token.id} net fr ${account.totalNetFlowRate} cfa net fr ${account.totalCFANetFlowRate} gda net fr ${await gdaForwarder.getNetFlow(account.token.id, account.account.id)}`);
                const rtb = await targetToken.realtimeBalanceOfNow(account.account.id);
                const { availableBalance, deposit } = rtb;
                if (availableBalance < 0) { // critical or insolvent
                    // no deposit means there's no outflow, thus nothing to be liquidated
                    const consumedDepositPercentage = deposit === 0n ? undefined : -Number(availableBalance * 100n / deposit);
                    if (!consumedDepositPercentage || consumedDepositPercentage < depositConsumedPctThreshold) {
                        continue;
                    }

                    const cfaNetFlowRate = BigInt(account.totalCFANetFlowRate);
                    const gdaNetFlowRate = await gdaForwarder.getNetFlow(account.token.id, account.account.id);
                    let netFlowRate = cfaNetFlowRate + gdaNetFlowRate;
                    if (!process.env.LIQUIDATE_ALL && netFlowRate >= ZERO) {
                        continue;
                    }
                    log(`! Critical ${account.account.id} token ${account.token.id} net fr ${netFlowRate} (cfa ${cfaNetFlowRate} gda ${gdaNetFlowRate})`);

                    const cfaFlows = await this.getOutgoingFlowsFromAccountByToken(account.token.id, account.account.id);
                    let processedCFAFlows = 0;
                    for (const flow of cfaFlows) {
                        const data = flow.id.split("-");
                        returnData.push({
                            agreementType: AgreementType.CFA,
                            sender: data[0],
                            receiver: data[1],
                            token: data[2],
                            flowrate: BigInt(flow.currentFlowRate)
                        });
                        netFlowRate += BigInt(flow.currentFlowRate);
                        processedCFAFlows++;
                        if (!process.env.LIQUIDATE_ALL && netFlowRate >= ZERO) {
                            break;
                        }
                    }

                    const gdaFlows = await this.getAllFlowDistributions(account.token.id, account.account.id);
                    let processedGDAFlows = 0;
                    for (const flow of gdaFlows) {
                        const data = flow.id.split("-");
                        const pool = data[1];
                        returnData.push({
                            agreementType: AgreementType.GDA,
                            sender: account.account.id,
                            receiver: pool,
                            token: account.token.id,
                            flowrate: BigInt(flow.pool.flowRate)
                        });
                        netFlowRate += BigInt(flow.pool.flowRate);
                        processedGDAFlows++;
                        if (!process.env.LIQUIDATE_ALL && netFlowRate >= BigInt(0)) {
                            break;
                        }
                    }

                    log(`available balance ${availableBalance}, deposit ${deposit}, consumed deposit ${consumedDepositPercentage}%, flows to-be-liquidated/total: ${processedCFAFlows}/${cfaFlows.length} cfa | ${processedGDAFlows}/${gdaFlows.length} gda`);
                    if (processedCFAFlows > 0 || processedGDAFlows > 0) {
                        continue;
                    } else {
                        log("!!!  no cfa|gda outflows to liquidate");
                    }
                }
            }
        }
        return returnData.sort((a, b) => Number(b.flowrate - a.flowrate));
    }

    /**
     * Fetches outgoing flows from an account by token.
     * @param token - The address of the token.
     * @param account - The address of the account.
     * @returns A promise that resolves to an array of outgoing flows.
     */
    async getOutgoingFlowsFromAccountByToken(token: AddressLike, account: AddressLike): Promise<any[]> {
        const _accountLowerCase = account.toString().toLowerCase();
        const _tokenLowerCase = token.toString().toLowerCase();
        return this._queryAllPages(
            (lastId: string) => `{
                account(id: "${_accountLowerCase}") {
                    outflows(
                        orderBy: currentFlowRate,
                        orderDirection: desc,
                        where: {
                            token: "${_tokenLowerCase}",
                            id_gt: "${lastId}",
                            currentFlowRate_not: "0",
                    }) {
                        id
                        currentFlowRate
                    }
                }
            }`,
            res => res.data.data.account.outflows,
            i => i
        );
    }

    /**
     * Fetches all flow distributions for a given token and account.
     * @param token - The address of the token.
     * @param account - The address of the account.
     * @returns A promise that resolves to an array of flow distributions.
     */
    async getAllFlowDistributions(token: AddressLike, account: AddressLike): Promise<any[]> {
        const _accountLowerCase = account.toString().toLowerCase();
        const _tokenLowerCase = token.toString().toLowerCase();
        return this._queryAllPages(
            (lastId: string) => `{
                poolDistributors(where: {account: "${_accountLowerCase}", id_gt: "${lastId}", pool_: {token: "${_tokenLowerCase}"}, flowRate_gt: "0"}) {
                    id
                    pool {
                        id
                        flowRate
                    }
                }
            }`,
            res => res.data.data.poolDistributors,
            i => i
        );
    }

    /**
     * Fetches critical accounts by token at the current time.
     * @param token - The address of the token.
     * @returns A promise that resolves to an array of critical accounts.
     */
    async getCriticalAccountsByTokenNow(token: AddressLike, onlyNegativeNetFlowrate: boolean = true): Promise<CriticalAccount[]> {
        console.log(`Getting critical accounts for token ${token} with onlyNegativeNetFlowrate ${onlyNegativeNetFlowrate}`);
        const _tokenLowerCase = token.toString().toLowerCase();
        const timestamp = Math.floor(Date.now() / 1000);
        return this._queryAllPages(
            (lastId: string) => `{
                accountTokenSnapshots (first: ${MAX_ITEMS},
                    where: {
                        and: [
                            {id_gt: "${lastId}"},
                            ${onlyNegativeNetFlowrate ? '{totalNetFlowRate_lt: 0,},' : ''}
                            {token: "${_tokenLowerCase}"},
                            {or: [
                                {maybeCriticalAtTimestamp_lt: "${timestamp}"},
                                {and: [
                                    {balanceUntilUpdatedAt_lte: "0"},
                                    {activeOutgoingStreamCount_gt: 0}
                                ]}
                            ]}
                        ]
                    }
                ) {
                    id
                    totalNetFlowRate
                    totalCFANetFlowRate
                    token {
                        id
                        symbol
                    }
                    account {
                        id
                    }
                }
            }`,
            res => res.data.data.accountTokenSnapshots,
            i => i
        );
    }

    /**
     * Fetches all super tokens.
     * @param isListed - Whether to process listed or unlisted tokens.
     * @returns A promise that resolves to an array of super tokens.
     */
    async getSuperTokens(isListed: boolean = true): Promise<any[]> {
        return this._queryAllPages(
            (lastId: string) => `{
                tokens(first: ${MAX_ITEMS}, where: {id_gt: "${lastId}" isListed: ${isListed}}) {
                    isListed
                    isNativeAssetSuperToken
                    isSuperToken
                    name
                    symbol
                    id
                }
            }`,
            res => res.data.data.tokens,
            i => i
        );
    }

    /**
     * Executes a GraphQL query.
     * @param query - The GraphQL query string.
     * @returns A promise that resolves to the Axios response.
     */
    private async _graphql(query: string): Promise<AxiosResponse<any>> {

        if (!this.subgraphUrl) {
            throw new Error("DataFetcher URL not set");
        }

        const headers = {
            //"Authorization": `bearer ${process.env.GITHUB_TOKEN}`,
            //"Accept": accept ? accept : "application/vnd.github.v3+json",
        };

        return await axios.post(this.subgraphUrl, {query}, {headers});
    }

    /**
     * Queries all pages of a paginated GraphQL response.
     * @param queryFn - A function that generates the GraphQL query string.
     * @param toItems - A function that extracts items from the Axios response.
     * @param itemFn - A function that processes each item.
     * @returns A promise that resolves to an array of all items.
     */
    private async _queryAllPages(queryFn: (lastId: string) => string, toItems: (res: AxiosResponse<any>) => any[], itemFn: (item: any) => any): Promise<any[]> {
        let lastId = "";
        const items: any[] = [];

        while (true) {
            const res = await this._graphql(queryFn(lastId));

            if (res.status !== 200 || res.data.errors) {
                console.error(`bad response ${res.status}`);
                //process.exit(2);
            } else if (res.data === "") {
                console.error("empty response data");
            } else {
                const newItems = toItems(res);
                items.push(...newItems.map(itemFn));

                if (newItems.length < MAX_ITEMS) {
                    break;
                } else {
                    lastId = newItems[newItems.length - 1].id;
                }
            }
        }

        return items;
    }
}

export default DataFetcher;
