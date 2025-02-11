#!/usr/bin/env bun

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import Graphinator from './src/graphinator';


const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);

// Load default .env first
dotenv.config();

// Parse network parameter first, before full argument parsing
const networkArg = process.argv.find((arg) => arg.startsWith('--network=') || arg === '--network');
const networkParam = networkArg ? 
    networkArg.startsWith('--network=') ? 
        networkArg.split('=')[1] : 
        process.argv[process.argv.indexOf(networkArg) + 1]
    : process.env.NETWORK;

// Load network-specific .env if network is specified
if (networkParam && fs.existsSync(path.resolve(__dirname, `.env_${networkParam}`))) {
    dotenv.config({ path: path.resolve(__dirname, `.env_${networkParam}`) });
}

const argv = await yargs(hideBin(process.argv))
    .option('network', {
        alias: 'n',
        type: 'string',
        description: 'Set the network',
        demandOption: true,
        default: process.env.NETWORK
    })
    /*
    Note: there's currently no scientific way to determine a safe batch size.
    That's because the gas consumed by an individual flow's liquidation can vary widely, 
    especially if SuperApp callbacks are involved.
    The safe and default choice is thus 1.
    Most of the time considerably higher values (e.g. 10) will work and may be used.
    But since the logic is currently such that a failing batch could stall any progress,
    setting this differently should be a conscious choice.
    */
    .option('token', {
        alias: 't',
        type: 'string',
        description: 'Address of the Super Token to process. If not set, all "listed" (curated) Super Tokens will be processed',
        default: process.env.TOKEN
    })
    .option('referenceGasPriceLimitMwei', {
        alias: 'r',
        type: 'number',
        description: 'Set the reference gas price limit in mwei (milli wei) - limit which should be applied to a flow with a daily flowrate worth 1$. Default: 1000 (1 gwei)',
        default: process.env.REFERENCE_GAS_PRICE_LIMIT_MWEI ? parseInt(process.env.REFERENCE_GAS_PRICE_LIMIT_MWEI) : 1000
    })
    .option('fallbackGasPriceLimitMwei', {
        alias: 'f',
        type: 'number',
        description: 'Set the fallback gas price limit in mwei (milli wei) - used for flows with unknown token price. Default: 10 x referenceGasPriceLimit',
        default: process.env.FALLBACK_GAS_PRICE_LIMIT_MWEI ? parseInt(process.env.FALLBACK_GAS_PRICE_LIMIT_MWEI) : undefined
    })
    .option('minGasPriceLimitMwei', {
        alias: 'm',
        type: 'number',
        description: 'Set the minimum gas price limit in mwei (milli wei) - used to prevent dust streams to persist forever. Default: 0.1 x referenceGasPriceLimit',
        default: process.env.MIN_GAS_PRICE_LIMIT_MWEI ? parseInt(process.env.MIN_GAS_PRICE_LIMIT_MWEI) : undefined
    })
    .option('gasMultiplier', {
        alias: 'g',
        type: 'number',
        description: 'Set the gas multiplier - allows to define the gas limit margin set on top of the estimation',
        default: process.env.GAS_MULTIPLIER ? parseFloat(process.env.GAS_MULTIPLIER) : 1.2
    })
    .option('batchSize', {
        alias: 'b',
        type: 'number',
        description: 'Set the batch size',
        default: process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : 1
    })
    .option('loop', {
        alias: 'l',
        type: 'boolean',
        description: 'Set to true to loop forever, false to run once.',
        default: process.env.LOOP === 'true'
    })
    .parse();

const runAgainIn = 30000 //15 * 60 * 1000;
const network = argv.network;
const batchSize = argv.batchSize;
const gasMultiplier = argv.gasMultiplier;
const token = argv.token;
const loop = argv.loop;
const referenceGasPriceLimit = argv.referenceGasPriceLimitMwei * 1000000;
const fallbackGasPriceLimit = argv.fallbackGasPriceLimitMwei ? argv.fallbackGasPriceLimitMwei * 1000000 : referenceGasPriceLimit * 10;
const minGasPriceLimit = argv.minGasPriceLimitMwei ? argv.minGasPriceLimitMwei * 1000000 : referenceGasPriceLimit * 0.1;

const ghr = new Graphinator(network, batchSize, gasMultiplier, referenceGasPriceLimit, fallbackGasPriceLimit, minGasPriceLimit);
if(loop) {
    const executeLiquidations = async () => {
        try {
            await ghr.processAll(token);
        } catch (error) {
            console.error(error);
        } finally {
            log(`run again in ${runAgainIn}`);
            setTimeout(executeLiquidations, runAgainIn); // Schedule the next run
        }
    };
    await executeLiquidations();
} else {
    log(new Date().toISOString() + " - run liquidations...");
    await ghr.processAll(token);
}
