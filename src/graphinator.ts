import { type AddressLike, ethers, type TransactionLike } from "ethers";
import DataFetcher from "./datafetcher.ts";
import type { Flow } from "./types/types.ts";
import sfMeta from "@superfluid-finance/metadata";
const BatchLiquidatorAbi = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/BatchLiquidator.sol/BatchLiquidator.json").abi;
const GDAv1ForwarderAbi = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/GDAv1Forwarder.sol/GDAv1Forwarder.json").abi;

const tokenPricesAllNetworks = require("../data/token_prices.json") || undefined;

const bigIntToStr = (key: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);
const log = (msg: string, lineDecorator = "") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);


/**
 * Graphinator is responsible for processing and liquidating flows.
 */
export default class Graphinator {

    private dataFetcher: DataFetcher;
    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private gdaForwarder: ethers.Contract;
    private batchLiquidator: ethers.Contract;
    private depositConsumedPctThreshold: number;
    private batchSize: number;
    private gasMultiplier: number;
    private referenceGasPriceLimit: number;
    private fallbackGasPriceLimit: number;
    private minGasPriceLimit: number;
    private isListed: boolean;
    private tokenPrices: Record<string, number>;

    /**
     * Creates an instance of Graphinator.
     * @param networkName - The name of the network.
     * @param batchSize - The size of the batch for processing flows.
     * @param gasMultiplier - The gas multiplier for estimating gas limits.
     * @param maxGasPrice - The maximum gas price allowed.
     */
    constructor(networkName: string, batchSize: number, gasMultiplier: number, referenceGasPriceLimit: number, fallbackGasPriceLimit: number, minGasPriceLimit: number, isListed: boolean) {
        this.batchSize = batchSize;
        this.gasMultiplier = gasMultiplier;
        this.referenceGasPriceLimit = referenceGasPriceLimit;
        this.fallbackGasPriceLimit = fallbackGasPriceLimit;
        this.minGasPriceLimit = minGasPriceLimit;
        this.isListed = isListed;
        log(`referenceGasPriceLimit: ${referenceGasPriceLimit} (${referenceGasPriceLimit / 1000000000} gwei)`);
        log(`fallbackGasPriceLimit: ${fallbackGasPriceLimit} (${fallbackGasPriceLimit / 1000000000} gwei)`);
        log(`minGasPriceLimit: ${minGasPriceLimit} (${minGasPriceLimit / 1000000000} gwei)`);
        if (this.minGasPriceLimit > this.fallbackGasPriceLimit || this.minGasPriceLimit > this.referenceGasPriceLimit) {
            throw new Error("minGasPriceLimit must be less than fallbackGasPriceLimit and less than referenceGasPriceLimit");
        }

        const network = sfMeta.getNetworkByName(networkName);
        if (network === undefined) {
            throw new Error(`network ${networkName} unknown - not in metadata. If the name is correct, you may need to update.`);
        }
        this.provider = new ethers.JsonRpcProvider(`https://rpc-endpoints.superfluid.dev/${networkName}?app=graphinator`);
        this.dataFetcher = new DataFetcher(`https://subgraph-endpoints.superfluid.dev/${networkName}/protocol-v1`, this.provider);

        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("No private key provided");
        }
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        if (!network.contractsV1.gdaV1Forwarder) {
            throw new Error("GDA Forwarder contract address not found in metadata");
        }
        log(`Initialized wallet: ${this.wallet.address}`);

        this.gdaForwarder = new ethers.Contract(network.contractsV1.gdaV1Forwarder!, GDAv1ForwarderAbi, this.wallet);
        if (!network.contractsV1.gdaV1Forwarder) {
            throw new Error("Batch Liquidator contract address not found in metadata");
        }
        this.batchLiquidator = new ethers.Contract(network.contractsV1.batchLiquidator!, BatchLiquidatorAbi, this.wallet);
        log(`Initialized batch contract at ${network.contractsV1.batchLiquidator}`);

        this.depositConsumedPctThreshold = import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD
            ? Number(import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD)
            : 20;
        log(`Will liquidate outflows of accounts with more than ${this.depositConsumedPctThreshold}% of the deposit consumed`);

        this.tokenPrices = tokenPricesAllNetworks[networkName] || {};
        log(`Loaded ${Object.keys(this.tokenPrices).length} token prices`);
    }

    // If no token is provided: first get a list of all tokens.
    // Then for the provided or all tokens:
    // get the outgoing flows of all critical accounts, then chunk and batch-liquidate them
    /**
     * Processes all tokens or a specific token to find and liquidate flows.
     * @param token - The address of the token to process. If not provided, all tokens will be processed.
     */
    async processAll(token?: AddressLike): Promise<void> {
        let tokenAddrs: string[];
        if (token) {
            const resolved = await ethers.resolveAddress(token, this.provider);
            tokenAddrs = [resolved.toLowerCase()];
        } else {
            tokenAddrs = await this._getSuperTokens(this.isListed);
        }
        log(`Processing ${tokenAddrs.length} tokens, isListed: ${this.isListed ? "true" : "false"}`);
        for (const tokenAddr of tokenAddrs) {
            const flowsToLiquidate = await this.dataFetcher.getFlowsToLiquidate(
                tokenAddr,
                this.gdaForwarder,
                this.depositConsumedPctThreshold,
                (flow) => this._calculateMaxGasPrice(flow)
            );
            if (flowsToLiquidate.length > 0) {
                log(`Found ${flowsToLiquidate.length} flows to liquidate`);

                // now we calculate the max gas price per flow and filter out those above the current gas price
                const currentGasPrice = Number((await this.provider.getFeeData()).gasPrice);
                if (!currentGasPrice) {
                    throw new Error("Current gas price not found");
                }
                log(`Current network gas price: ${currentGasPrice / 1e9} gwei`);

                const flowsWorthLiquidating = flowsToLiquidate.filter(flow => this._calculateMaxGasPrice(flow) >= currentGasPrice);
                log(`${flowsWorthLiquidating.length} flows with max gas price in range`);

                // now sort the flows by max gas price descending
                flowsWorthLiquidating.sort((a, b) => this._calculateMaxGasPrice(b) - this._calculateMaxGasPrice(a));
                log(`Sorted flows by max gas price descending`);

                const chunks = this._chunkArray(flowsWorthLiquidating, this.batchSize);
                for (const chunk of chunks) {
                    // leave some margin to avoid getting stuck if the gas price is ticking up
                    await this.batchLiquidateFlows(tokenAddr, chunk, Math.floor(currentGasPrice * 1.2));
                }
            } else {
                log(`No critical accounts for token: ${tokenAddr}`);
            }
        }
    }

    /*
     * Calculate the max gas price we're willed to bid for liquidating this flow,
     * taking into account the normalized (denominated in USD) flowrate, the reference gas price limit
     * (representing our limit for a normalized flowrate of 1 token per day)
     * amd the minimum gas price limit (which avoids dust flows to exist in perpetuity).
     * If the token price is not known, the fallback limit is returned.
     * 
     * The threshold increases over time since insolvency:
     * - 100% increase after 1 day, 200% after 2 days, etc.
     * - Capped at 10 days (1000% increase = 11x base threshold)
     * - Time since insolvent is calculated from consumedDepositPercentage:
     *   100% = just insolvent, 200% = 4 hours insolvent, etc.
     */
    _calculateMaxGasPrice(flow: Flow): number {
        const tokenPrice = this.tokenPrices[flow.token];
        const flowrate = Number(flow.flowrate);

        const refDailyNFR = 1e18;
        const dailyNFR = tokenPrice ? Math.round(flowrate * 86400 * tokenPrice) : undefined;
        const baseMaxGasPrice = dailyNFR ? Math.max(this.minGasPriceLimit, Math.round(dailyNFR * this.referenceGasPriceLimit / refDailyNFR)) : this.fallbackGasPriceLimit;
        
        // Calculate time-based multiplier from consumed deposit percentage
        // 100% consumed = just became insolvent (0 hours)
        // 200% consumed = 4 hours insolvent (liquidation period is 4 hours per deposit)
        // days_since_insolvent = (consumedPct - 100) * 4 / (100 * 24)
        let timeMultiplier = 1;
        if (flow.consumedDepositPercentage && flow.consumedDepositPercentage > 100) {
            const hoursSinceInsolvent = (flow.consumedDepositPercentage - 100) * 4 / 100;
            const daysSinceInsolvent = hoursSinceInsolvent /24;
            // 100% increase per day, capped at 10 days
            timeMultiplier = 1 + Math.min(daysSinceInsolvent, 10);
        }
        
        return Math.round(baseMaxGasPrice * timeMultiplier);
    }

    // Liquidate all flows in one batch transaction.
    // The caller is responsible for sizing the array such that it fits into one transaction.
    // (Note: max digestible size depends on chain and context like account status, SuperApp receiver etc.)
    /**
     * Liquidates all flows in one batch transaction.
     * @param token - The address of the token.
     * @param flows - The array of flows to liquidate.
     */
    private async batchLiquidateFlows(token: AddressLike, flows: Flow[], maxGasPrice: number): Promise<void> {
        try {
            const txData = await this._generateBatchLiquidationTxData(token, flows);
            const gasLimit = await this._estimateGasLimit(txData);

            const tx = {
                to: txData.to,
                data: txData.data,
                gasLimit,
                gasPrice: maxGasPrice,
                chainId: (await this.provider.getNetwork()).chainId,
                nonce: await this.provider.getTransactionCount(this.wallet.address),
            };

            if (process.env.DRY_RUN) {
                log(`Dry run - tx: ${JSON.stringify(tx, bigIntToStr)}`);
            } else {
                const signedTx = await this.wallet.signTransaction(tx);
                const transactionResponse = await this.provider.broadcastTransaction(signedTx);
                const receipt = await transactionResponse.wait();
                log(`Transaction successful: ${receipt?.hash}`);
            }
        } catch (error) {
            console.error(`(Graphinator) Error processing chunk: ${error}`);
        }
    }

    /**
     * Fetches all super tokens.
     * @returns A promise that resolves to an array of super token addresses.
     */
    private async _getSuperTokens(isListed: boolean): Promise<any[]> { // changed AddressLike[] to any[] or string[] because I am using string now
        return (await this.dataFetcher.getSuperTokens(isListed))
            .map(token => token.id.toLowerCase()); // Ensure lowercase
    }

    /**
     * Splits an array into chunks of a specified size.
     * @param array - The array to split.
     * @param size - The size of each chunk.
     * @returns An array of chunks.
     */
    private _chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    /**
     * Generates the transaction data for batch liquidation.
     * @param token - The address of the token.
     * @param flows - The array of flows to liquidate.
     * @returns A promise that resolves to the transaction data.
     */
    private async _generateBatchLiquidationTxData(token: AddressLike, flows: Flow[]): Promise<TransactionLike> {
        if (!flows.every(flow => flow.token === token)) {
            throw new Error("flow with wrong token");
        }
        const structParams = flows.map(flows => ({
            agreementOperation: flows.agreementType,
            sender: flows.sender,
            receiver: flows.receiver,
        }));
        const transactionData = this.batchLiquidator!.interface.encodeFunctionData('deleteFlows', [token, structParams]);
        const transactionTo = await this.batchLiquidator!.getAddress();
        return { data: transactionData, to: transactionTo };
    }

    /**
     * Estimates the gas limit for a transaction.
     * @param transaction - The transaction to estimate the gas limit for.
     * @returns A promise that resolves to the estimated gas limit.
     */
    private async _estimateGasLimit(transaction: TransactionLike): Promise<number> {
        const gasEstimate = await this.provider.estimateGas({
            to: transaction.to,
            data: transaction.data,
        });
        return Math.floor(Number(gasEstimate) * this.gasMultiplier);
    }

    /**
     * Pauses execution for a specified amount of time.
     * @param ms - The number of milliseconds to pause.
     * @returns A promise that resolves after the specified time.
     */
    private async _sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
