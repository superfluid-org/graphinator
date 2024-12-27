/*
 * Creates a json file with the current price of all listed tokens of all SF networks known to coingecko.
 * First fetches networks.json from github and filters mainnets.
 * Then fetches a list of "coins" from coingecko (/coins/list).
 * Then for each mainnet, gets the listed SuperTokens from protocol subgraph.
 * Matches SF networks and token addresses with coingecko platforms and coin addresses.
 * For each "platform", does a request to /simple/token_price/ for getting the price of assets we care about.
 * Writes the data to json.
 */

// Import necessary modules
import axios from 'axios';
import fs from 'fs';

const outputFile = './data/token_prices.json';
const cgBaseUrl = process.env.COINGECKO_BASE_URL || 'https://pro-api.coingecko.com/api/v3';
const cgApiKey = process.env.COINGECKO_API_KEY;

if (!cgApiKey) {
    throw new Error('COINGECKO_API_KEY is not set');
}

async function fetchListedSuperTokens(network) {
    const subgraph_url = `https://${network.name}.subgraph.x.superfluid.dev`;

    try {
        const response = await axios.post(subgraph_url, {
            query: `
                query {
                    tokens(first: 1000, where: { isSuperToken: true, isListed: true, isNativeAssetSuperToken: false }) {
                        id
                        underlyingAddress
                        name
                        symbol
                    }
                }
            `
        });
        return response.data.data.tokens;
    } catch (error) {
        throw new Error(`Error fetching tokens for ${network.name}: ${error}`);
    }
}

async function fetchCoingeckoPlatformTokenPrices(cg_base_url, cg_api_token, platform, addresses) {
    const url = `${cg_base_url}/simple/token_price/${platform}?contract_addresses=${addresses.join(',')}&vs_currencies=usd`;
    try {
        const response = await axios.get(url, {
            headers: {
                'x-cg-pro-api-key': cg_api_token
            }
        });
        return response.data;
    } catch (error) {
        console.error(`Error fetching prices for tokens on ${platform}: ${error}`);
        return {};
    }
}

async function fetchNativeTokenId(cg_base_url, cg_api_token, symbol) {
    // overrides: xDAI -> DAI, MATIC -> POL
    if (symbol === 'xDAI') {
        symbol = 'DAI';
    } else if (symbol === 'MATIC') {
        symbol = 'POL';
    }

    try {
        const response = await axios.get(`${cg_base_url}/search?query=${symbol}`, {
            headers: {
                'x-cg-pro-api-key': cg_api_token
            }
        });
        
        // Find the most relevant coin matching the symbol
        const coin = response.data.coins.find(c => 
            c.symbol.toLowerCase() === symbol.toLowerCase() && 
            c.market_cap_rank // Prefer coins with market cap ranking
        );
        
        return coin?.id;
    } catch (error) {
        console.error(`Error searching for native token ${symbol}: ${error}`);
        return null;
    }
}

async function fetchNativeCoinPrice(cg_base_url, cg_api_token, coinId) {
    const url = `${cg_base_url}/simple/price?ids=${coinId}&vs_currencies=usd`;
    try {
        const response = await axios.get(url, {
            headers: {
                'x-cg-pro-api-key': cg_api_token
            }
        });
        return response.data[coinId]?.usd;
    } catch (error) {
        console.error(`Error fetching price for native coin ${coinId}: ${error}`);
        return null;
    }
}

async function run(cg_base_url, cg_api_token) {
    let tokenPrices = {};

    try {
        console.log("Fetching networks.json from github");
        const networks_json = (await axios.get('https://raw.githubusercontent.com/superfluid-finance/protocol-monorepo/dev/packages/metadata/networks.json')).data;
        const filtered_networks = networks_json.filter(network => !network.isTestnet);

        console.log("Fetching coinList from coingecko");
        const coinList = (await axios.get(`${cg_base_url}/coins/list?include_platform=true`, {
            headers: {
                'x-cg-pro-api-key': cg_api_token
            }
        })).data;

        await filtered_networks.reduce(async (promise, network) => {
            await promise;
            
            if (!network.coinGeckoId) {
                console.log(`Skipping network ${network.name} - no Coingecko ID found`);
                return;
            }

            console.log(`Processing network ${network.name} (Coingecko platform: ${network.coinGeckoId})`);
            const tokens = await fetchListedSuperTokens(network);

            tokenPrices[network.name] = {};

            // Split tokens into three categories
            const nativeTokenWrapper = network.nativeTokenWrapper;

            const pureSuperTokens = tokens.filter(token => 
                token.underlyingAddress === '0x0000000000000000000000000000000000000000'
            );
            const wrapperSuperTokens = tokens.filter(token => 
                token.underlyingAddress !== '0x0000000000000000000000000000000000000000' &&
                token.id.toLowerCase() !== network.nativeTokenWrapper?.toLowerCase()
            );

            // 1. Handle native token wrapper
            if (nativeTokenWrapper && network.nativeTokenSymbol) {
                const nativeTokenId = await fetchNativeTokenId(cg_base_url, cg_api_token, network.nativeTokenSymbol);
                if (nativeTokenId) {
                    const price = await fetchNativeCoinPrice(cg_base_url, cg_api_token, nativeTokenId);
                    if (price) {
                        tokenPrices[network.name][nativeTokenWrapper] = price;
                        console.log(`  Native token wrapper ${nativeTokenWrapper} (${network.nativeTokenSymbol}x) price: ${price}`);
                    }
                }
            }

            // 2. Handle pure super tokens
            if (pureSuperTokens.length > 0) {
                const addresses = pureSuperTokens.map(token => token.id);
                const prices = await fetchCoingeckoPlatformTokenPrices(cg_base_url, cg_api_token, network.coinGeckoId, addresses);
                
                pureSuperTokens.forEach(token => {
                    const price = prices[token.id.toLowerCase()]?.usd;
                    if (price) {
                        tokenPrices[network.name][token.id] = price;
                        console.log(`  Pure super token ${token.id} (${token.symbol}) price: ${price}`);
                    }
                });
            }

            // 3. Handle wrapper super tokens
            if (wrapperSuperTokens.length > 0) {
                const addresses = wrapperSuperTokens.map(token => token.underlyingAddress);
                const prices = await fetchCoingeckoPlatformTokenPrices(cg_base_url, cg_api_token, network.coinGeckoId, addresses);
                
                wrapperSuperTokens.forEach(token => {
                    const price = prices[token.underlyingAddress.toLowerCase()]?.usd;
                    if (price) {
                        tokenPrices[network.name][token.id] = price;
                        console.log(`  Wrapper super token ${token.id} (${token.symbol}) price: ${price}`);
                    }
                });
            }
        }, Promise.resolve());

        // Write results to file
        fs.writeFileSync(outputFile, JSON.stringify(tokenPrices, null, 2));
        console.log(`Output saved to ${outputFile}`);

    } catch (error) {
        console.error("An error occurred:", error);
    }
}

run(cgBaseUrl, cgApiKey);
