/**
 * Smart Order Router CLI 
 * Interactive quote fetcher across V2, V3, and V4 pools
 * Supports native ETH and ERC20 tokens
 * 
 * Protocol.MIXED for V3↔V4 cross-liquidity routing
 * This enables routes like: TOKEN → WETH (V3) → unwrap → ETH → TOKEN (V4)
 * 
 * Usage: node smart-router-cli.js
 */

const { AlphaRouter, SwapType, nativeOnChain } = require('@uniswap/smart-order-router');
const { UniversalRouterVersion } = require('@uniswap/universal-router-sdk'); 
const { Protocol } = require('@uniswap/router-sdk');
const { Token, CurrencyAmount, TradeType, Percent, ChainId } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const readline = require('readline');
require('dotenv').config();

// =============================================================================
// CONFIGURATION
// =============================================================================

const BASE_RPC = process.env.BASE_RPC || 'SEPOLIA_HTTP_RPC_ENDPOINT';
const CHAIN_ID = ChainId.SEPOLIA;  // Sepolia ETH. Use 'BASE' for Base Mainnet

// Colors for console
const colors = {
    reset: "\x1b[0m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    bold: "\x1b[1m"
};

// ERC20 ABI for fetching token info
const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function name() view returns (string)'
];

// =============================================================================
// COMMON TOKENS (shortcuts)
// =============================================================================

const KNOWN_TOKENS = {
    'weth': '0x4200000000000000000000000000000000000006',
    'eth': 'NATIVE',
    'native': 'NATIVE',
    'usdc': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'usdbc': '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    'dai': '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    'cbeth': '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
};

// =============================================================================
// HELPERS
// =============================================================================

function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function resolveToken(input) {
    const lower = input.toLowerCase();
    if (KNOWN_TOKENS[lower]) {
        return KNOWN_TOKENS[lower];
    }
    return input;
}

async function getTokenInfo(address, provider) {
    // Handle native ETH
    if (address === 'NATIVE') {
        return { symbol: 'ETH', decimals: 18, name: 'Ether', address: 'NATIVE' };
    }
    
    try {
        const contract = new ethers.Contract(address, ERC20_ABI, provider);
        const [symbol, decimals, name] = await Promise.all([
            contract.symbol(),
            contract.decimals(),
            contract.name().catch(() => 'Unknown')
        ]);
        return { symbol, decimals, name, address };
    } catch (error) {
        throw new Error(`Failed to fetch token info for ${address}: ${error.message}`);
    }
}

function isValidTokenInput(input) {
    return input === 'NATIVE' || ethers.utils.isAddress(input);
}

// =============================================================================
// QUOTE FUNCTION
// =============================================================================

async function getQuote(router, tokenIn, tokenOut, amountIn, protocols, tokenInInfo, tokenOutInfo) {
    // Get display info (works for both Token and NativeCurrency)
    const tokenInSymbol = tokenIn.symbol || 'ETH';
    const tokenOutSymbol = tokenOut.symbol || 'ETH';
    const tokenInAddress = tokenIn.isNative ? 'NATIVE' : tokenIn.address;
    const tokenOutAddress = tokenOut.isNative ? 'NATIVE' : tokenOut.address;
    const tokenInDecimals = tokenIn.decimals;

    // Check if MIXED is included
    const hasMixed = protocols.includes(Protocol.MIXED);

    console.log(`\n${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}  FETCHING QUOTE${colors.reset}`);
    console.log(`${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`);
    
    console.log(`${colors.yellow}Token In:${colors.reset}  ${tokenInSymbol} (${tokenInAddress})`);
    console.log(`${colors.yellow}Token Out:${colors.reset} ${tokenOutSymbol} (${tokenOutAddress})`);
    console.log(`${colors.yellow}Amount:${colors.reset}    ${amountIn} ${tokenInSymbol}`);
    console.log(`${colors.yellow}Protocols:${colors.reset} ${protocols.join(', ')}`);
    
    if (hasMixed) {
        console.log(`${colors.green}${colors.bold}✓ MIXED protocol enabled - V3↔V4 cross-liquidity active${colors.reset}`);
    }
    
    // Create CurrencyAmount
    const amountInWei = ethers.utils.parseUnits(amountIn.toString(), tokenInDecimals);
    const currencyAmountIn = CurrencyAmount.fromRawAmount(tokenIn, amountInWei.toString());
    
    console.log(`\n${colors.blue}Searching for best route...${colors.reset}`);
    const startTime = Date.now();
    
    try {
        const route = await router.route(
            currencyAmountIn,
            tokenOut,
            TradeType.EXACT_INPUT,
            {
                type: SwapType.UNIVERSAL_ROUTER,
                version: UniversalRouterVersion.V2_0,  
                recipient: '0x0000000000000000000000000000000000000001', // msg.sender (the address making the tx)
                slippageTolerance: new Percent(50, 10_000),
                deadline: Math.floor(Date.now() / 1000) + 1800,
            },
            {
                protocols: protocols,
                maxSplits: 10,
                maxSwapsPerPath: 10,  // Allow longer paths for cross-liquidity routes
                shouldEnableMixedRouteEthWeth: true,  // KEY FLAG for V3 WETH ↔ V4 ETH bridging
            }
        );
        
        const elapsed = Date.now() - startTime;
        
        if (!route) {
            console.log(`\n${colors.red}✗ No route found! (${elapsed}ms)${colors.reset}`);
            console.log(`${colors.yellow}Possible reasons:${colors.reset}`);
            console.log(`  - No liquidity for this pair`);
            console.log(`  - Token addresses incorrect`);
            console.log(`  - Amount too small/large`);
            if (!hasMixed) {
                console.log(`  - Try enabling MIXED protocol (option 7 or 8) for cross-liquidity routes`);
            }
            return null;
        }

        // Raw output
        console.log('\n=== RAW ROUTE OBJECT ===');
        console.log(JSON.stringify(route, (key, value) => 
            typeof value === 'bigint' ? value.toString() : value, 2));
        console.log('=== END RAW ===\n');
        
        // Display results
        console.log(`\n${colors.green}═══════════════════════════════════════════════════════════════${colors.reset}`);
        console.log(`${colors.green}  ✓ ROUTE FOUND (${elapsed}ms)${colors.reset}`);
        console.log(`${colors.green}═══════════════════════════════════════════════════════════════${colors.reset}`);
        
        console.log(`\n${colors.magenta}Quote Summary:${colors.reset}`);
        console.log(`  Input:            ${currencyAmountIn.toExact()} ${tokenInSymbol}`);
        console.log(`  Output:           ${route.quote.toExact()} ${tokenOutSymbol}`);
        console.log(`  Gas Adjusted:     ${route.quoteGasAdjusted.toExact()} ${tokenOutSymbol}`);
        
        // Calculate effective price
        const inputAmount = parseFloat(currencyAmountIn.toExact());
        const outputAmount = parseFloat(route.quote.toExact());
        const price = outputAmount / inputAmount;
        console.log(`  Price:            1 ${tokenInSymbol} = ${price.toFixed(6)} ${tokenOutSymbol}`);
        
        console.log(`\n${colors.magenta}Gas Estimates:${colors.reset}`);
        console.log(`  Gas Used:         ${route.estimatedGasUsed.toString()}`);
        console.log(`  Gas Price:        ${ethers.utils.formatUnits(route.gasPriceWei, 'gwei')} gwei`);
        console.log(`  Gas Cost (USD):   $${route.estimatedGasUsedUSD.toFixed(4)}`);
        
        // Display route details
        console.log(`\n${colors.magenta}Route Details (${route.route.length} route(s)):${colors.reset}`);
        
        route.route.forEach((routeWithQuote, index) => {
            const percent = routeWithQuote.percent;
            const protocol = routeWithQuote.protocol;
            
            // Highlight MIXED routes
            const protocolColor = protocol === 'MIXED' ? colors.green + colors.bold : colors.cyan;
            console.log(`\n  ${protocolColor}Route ${index + 1} (${percent}% via ${protocol}):${colors.reset}`);
            
            if (protocol === 'MIXED' && routeWithQuote.route && routeWithQuote.route.pools) {
                // Detect which protocols are mixed
                const protocols = new Set();
                routeWithQuote.route.pools.forEach(pool => {
                    if (pool.hooks !== undefined || pool.poolKey !== undefined) {
                        protocols.add('V4');
                    } else if (pool.fee !== undefined && pool.tickSpacing !== undefined) {
                        protocols.add('V3');
                    } else {
                        protocols.add('V2');
                    }
                });
                const protocolList = Array.from(protocols).sort().join('↔');
                console.log(`    ${colors.green}★ CROSS-LIQUIDITY ROUTE (${protocolList} bridge)${colors.reset}`);
            }
            
            // Build path string
            if (routeWithQuote.route && routeWithQuote.route.path) {
                const pathStr = routeWithQuote.route.path
                    .map(token => token.symbol || token.address?.slice(0, 10) || 'ETH')
                    .join(' → ');
                console.log(`    Path: ${pathStr}`);
            } else if (routeWithQuote.tokenPath) {
                const pathStr = routeWithQuote.tokenPath
                    .map(token => token.symbol || (token.isNative ? 'ETH' : token.address?.slice(0, 10)))
                    .join(' → ');
                console.log(`    Path: ${pathStr}`);
            }
            
            // Show pools with protocol info
            if (routeWithQuote.poolAddresses) {
                routeWithQuote.poolAddresses.forEach((pool, i) => {
                    console.log(`    Pool ${i + 1}: ${pool}`);
                });
            } else if (routeWithQuote.poolIdentifiers) {
                routeWithQuote.poolIdentifiers.forEach((pool, i) => {
                    console.log(`    Pool ${i + 1}: ${pool}`);
                });
            }
            
            // Show fee tiers and detect V2 vs V3 vs V4
            if (routeWithQuote.route && routeWithQuote.route.pools) {
                const poolInfo = routeWithQuote.route.pools.map((pool, i) => {
                    // Detect pool version:
                    // V4: has hooks or poolKey property
                    // V3: has fee AND tickSpacing (but no hooks)
                    // V2: has neither fee nor tickSpacing (uses reserve0/reserve1)
                    let version;
                    let fee;
                    
                    if (pool.hooks !== undefined || pool.poolKey !== undefined) {
                        version = 'V4';
                        fee = pool.fee !== undefined ? `${pool.fee / 10000}%` : 'dynamic';
                    } else if (pool.fee !== undefined && pool.tickSpacing !== undefined) {
                        version = 'V3';
                        fee = `${pool.fee / 10000}%`;
                    } else {
                        // V2 pools have reserve0/reserve1 but no fee tier
                        version = 'V2';
                        fee = '0.3%';  // V2 has fixed 0.3% fee
                    }
                    
                    return `${fee} (${version})`;
                });
                console.log(`    Fees: ${poolInfo.join(' → ')}`);
            }
            
            console.log(`    Output: ${routeWithQuote.quote.toExact()} ${tokenOutSymbol}`);
        });

        // Execution summary with FULL calldata
        console.log(`\n${colors.magenta}Execution Parameters:${colors.reset}`);
        console.log(`  Router:   ${route.methodParameters.to}`);
        console.log(`  Value:    ${route.methodParameters.value}`);
        console.log(`\n${colors.magenta}Calldata (full):${colors.reset}`);
        console.log(route.methodParameters.calldata);
        
        return route;
        
    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.log(`\n${colors.red}✗ Error after ${elapsed}ms${colors.reset}`);
        console.log(`${colors.red}  ${error.message}${colors.reset}`);
        if (error.stack) {
            console.log(`${colors.red}  ${error.stack.split('\n')[1]}${colors.reset}`);
        }
        return null;
    }
}

// =============================================================================
// MAIN INTERACTIVE LOOP
// =============================================================================

async function main() {
    console.log(`${colors.cyan}╔═══════════════════════════════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.cyan}║     UNISWAP SMART ORDER ROUTER CLI - BASE CHAIN               ║${colors.reset}`);
    console.log(`${colors.cyan}║     ${colors.green}With V3↔V4 Cross-Liquidity Support (MIXED)${colors.cyan}              ║${colors.reset}`);
    console.log(`${colors.cyan}╚═══════════════════════════════════════════════════════════════╝${colors.reset}`);
    
    console.log(`\n${colors.yellow}RPC:${colors.reset} ${BASE_RPC}`);
    
    // Initialize provider
    const provider = new ethers.providers.JsonRpcProvider(BASE_RPC);
    
    // Check connection
    try {
        const blockNumber = await provider.getBlockNumber();
        console.log(`${colors.green}✓ Connected to Base - Block: ${blockNumber}${colors.reset}`);
    } catch (error) {
        console.log(`${colors.red}✗ Failed to connect: ${error.message}${colors.reset}`);
        console.log(`${colors.yellow}Try setting BASE_RPC environment variable to your RPC URL${colors.reset}`);
        return;
    }
    
    // Initialize router
    console.log(`\n${colors.blue}Initializing AlphaRouter...${colors.reset}`);
    const router = new AlphaRouter({
        chainId: CHAIN_ID,
        provider: provider,
    });
    console.log(`${colors.green}✓ Router ready${colors.reset}`);
    
    // Show shortcuts
    console.log(`\n${colors.cyan}Token Shortcuts:${colors.reset}`);
    console.log(`  eth/native (native ETH), weth, usdc, usdbc, dai, cbeth`);
    console.log(`  tibbir, nemesis (custom tokens)`);
    console.log(`  Or paste any token address`);
    
    // Main loop
    while (true) {
        console.log(`\n${colors.cyan}───────────────────────────────────────────────────────────────${colors.reset}`);
        
        // Get token in
        const tokenInInput = await prompt(`${colors.yellow}Token In (address or shortcut, 'q' to quit): ${colors.reset}`);
        
        if (tokenInInput.toLowerCase() === 'q') {
            console.log(`\n${colors.green}Goodbye!${colors.reset}`);
            break;
        }
        
        const tokenInAddress = resolveToken(tokenInInput);
        
        if (!isValidTokenInput(tokenInAddress)) {
            console.log(`${colors.red}Invalid address: ${tokenInAddress}${colors.reset}`);
            continue;
        }
        
        // Get token out
        const tokenOutInput = await prompt(`${colors.yellow}Token Out (address or shortcut): ${colors.reset}`);
        const tokenOutAddress = resolveToken(tokenOutInput);
        
        if (!isValidTokenInput(tokenOutAddress)) {
            console.log(`${colors.red}Invalid address: ${tokenOutAddress}${colors.reset}`);
            continue;
        }
        
        // Fetch token info
        console.log(`\n${colors.blue}Fetching token info...${colors.reset}`);
        
        let tokenInInfo, tokenOutInfo;
        try {
            [tokenInInfo, tokenOutInfo] = await Promise.all([
                getTokenInfo(tokenInAddress, provider),
                getTokenInfo(tokenOutAddress, provider)
            ]);
            
            console.log(`${colors.green}Token In:  ${tokenInInfo.symbol} (${tokenInInfo.decimals} decimals)${tokenInInfo.address === 'NATIVE' ? ' [NATIVE]' : ''}${colors.reset}`);
            console.log(`${colors.green}Token Out: ${tokenOutInfo.symbol} (${tokenOutInfo.decimals} decimals)${tokenOutInfo.address === 'NATIVE' ? ' [NATIVE]' : ''}${colors.reset}`);
        } catch (error) {
            console.log(`${colors.red}${error.message}${colors.reset}`);
            continue;
        }
        
        // Get amount
        const amountInput = await prompt(`${colors.yellow}Amount of ${tokenInInfo.symbol} to swap: ${colors.reset}`);
        const amount = parseFloat(amountInput);
        
        if (isNaN(amount) || amount <= 0) {
            console.log(`${colors.red}Invalid amount${colors.reset}`);
            continue;
        }
        
        // Get protocols
        console.log(`\n${colors.cyan}Protocol Options:${colors.reset}`);
        console.log(`  1: V2 only`);
        console.log(`  2: V3 only`);
        console.log(`  3: V4 only`);
        console.log(`  4: V2 + V3`);
        console.log(`  5: V3 + V4`);
        console.log(`  6: V2 + V3 + V4`);
        console.log(`  ${colors.green}7: V3 + V4 + MIXED (cross-liquidity)${colors.reset}`);
        console.log(`  ${colors.green}8: ALL (V2 + V3 + V4 + MIXED) [default]${colors.reset}`);
        
        const protocolChoice = await prompt(`${colors.yellow}Select protocols (1-8, default 8): ${colors.reset}`);
        
        let protocols;
        switch (protocolChoice) {
            case '1':
                protocols = [Protocol.V2];
                break;
            case '2':
                protocols = [Protocol.V3];
                break;
            case '3':
                protocols = [Protocol.V4];
                break;
            case '4':
                protocols = [Protocol.V2, Protocol.V3];
                break;
            case '5':
                protocols = [Protocol.V3, Protocol.V4];
                break;
            case '6':
                protocols = [Protocol.V2, Protocol.V3, Protocol.V4];
                break;
            case '7':
                // V3 + V4 + MIXED - optimal for cross-liquidity
                // Note: MIXED requires at least 2 protocols besides MIXED
                protocols = [Protocol.V3, Protocol.V4, Protocol.MIXED];
                break;
            case '8':
            default:
                // ALL protocols including MIXED for maximum route options
                protocols = [Protocol.V2, Protocol.V3, Protocol.V4, Protocol.MIXED];
                break;
        }
        
        // Create Currency objects (Token or NativeCurrency)
        let tokenIn, tokenOut;
        
        if (tokenInInfo.address === 'NATIVE') {
            tokenIn = nativeOnChain(CHAIN_ID);
        } else {
            tokenIn = new Token(
                CHAIN_ID,
                tokenInInfo.address,
                tokenInInfo.decimals,
                tokenInInfo.symbol,
                tokenInInfo.name
            );
        }
        
        if (tokenOutInfo.address === 'NATIVE') {
            tokenOut = nativeOnChain(CHAIN_ID);
        } else {
            tokenOut = new Token(
                CHAIN_ID,
                tokenOutInfo.address,
                tokenOutInfo.decimals,
                tokenOutInfo.symbol,
                tokenOutInfo.name
            );
        }
        
        // Get quote
        await getQuote(router, tokenIn, tokenOut, amount, protocols, tokenInInfo, tokenOutInfo);
        
        // Ask to continue
        const continueChoice = await prompt(`\n${colors.yellow}Get another quote? (Y/n): ${colors.reset}`);
        if (continueChoice.toLowerCase() === 'n') {
            console.log(`\n${colors.green}Goodbye!${colors.reset}`);
            break;
        }
    }
}

// Run
main().catch(error => {
    console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
    process.exit(1);
});