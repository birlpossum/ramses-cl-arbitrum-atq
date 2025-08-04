import fetch from "node-fetch";
import { ContractTag, ITagService } from "atq-types";
// --- constants & types ---
export const PAGE = 1000; // The Graph caps page size at 1000
/**
 * Ramses Concentrated Liquidity subgraph on Arbitrum
 * Subgraph ID: ATQTt3wRTgXy4canCh6t1yeczAz4ZuEkFQL2mrLXEMyQ
 */
export function endpoint(apiKey?: string): string {
  const subgraphId = "ATQTt3wRTgXy4canCh6t1yeczAz4ZuEkFQL2mrLXEMyQ";
  // Use Arbitrum gateway endpoint
  if (!apiKey || apiKey === "dummy") {
    return `https://gateway-arbitrum.network.thegraph.com/api/[api-key]/subgraphs/id/${subgraphId}`;
  }
  return `https://gateway-arbitrum.network.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
}

// --- types ---

interface Pool {
  id: string;
  feeTier: string;
  liquidity: string;
  sqrtPrice: string;
  tickSpacing?: string; // If available
  createdAtTimestamp: number;
  token0: Token;
  token1: Token;
}

interface Token {
  id: string;
  name: string;
  symbol: string;
  decimals: string;
}

interface GraphQLData {
  pools: Pool[];
}

interface GraphQLResponse {
  data?: GraphQLData;
  errors?: { message: string }[];
}

// --- query ---
const PAIR_QUERY = `
  query GetPools($lastTimestamp: Int) {
    pools(
      first: 1000,
      orderBy: createdAtTimestamp,
      orderDirection: asc,
      where: { createdAtTimestamp_gt: $lastTimestamp }
    ) {
      id
      feeTier
      liquidity
      sqrtPrice
      tickSpacing
      createdAtTimestamp
      token0 { id name symbol decimals }
      token1 { id name symbol decimals }
    }
  }
`;

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

function containsHtmlOrMarkdown(text: string): boolean {
  return /<[^>]+>/.test(text);
}

function isError(e: unknown): e is Error {
  return (
    typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof (e as Error).message === "string"
  );
}

function truncateString(text: string, maxLength: number) {
  if (text.length > maxLength) {
    return text.substring(0, maxLength - 3) + "...";
  }
  return text;
}

// --- utils ---
/** Decode 32-byte hex (with/without 0x) → printable ASCII, strip junk */
export function cleanSymbol(raw: string): string {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    raw = Buffer.from(hex, "hex")
      .toString("utf8")
      .replace(/\u0000/g, "");
  }
  const txt = raw.replace(/[^\u0002-\u007f]/g, "").trim(); // printable ASCII
  return txt.length >= 2 && txt.length <= 32 ? txt : "";
}
/**
 * Transform pools into ContractTag objects, applying policy and field validation.
 */
// Transform pools into ContractTag objects, applying policy and field validation.
function transformPoolsToTags(chainId: string, pools: Pool[]): ContractTag[] {
  // First, filter and log invalid entries
  const validPools: Pool[] = [];
  const rejectedNames: string[] = [];

  pools.forEach((pool) => {
    const token0 = pool.token0;
    const token1 = pool.token1;
    if (!token0 || !token1) return;
    const token0Invalid = containsHtmlOrMarkdown(token0.name) || containsHtmlOrMarkdown(token0.symbol);
    const token1Invalid = containsHtmlOrMarkdown(token1.name) || containsHtmlOrMarkdown(token1.symbol);

    if (token0Invalid || token1Invalid) {
      if (token0Invalid) {
        rejectedNames.push(token0.name + ", Symbol: " + token0.symbol);
      }
      if (token1Invalid) {
        rejectedNames.push(token1.name + ", Symbol: " + token1.symbol);
      }
    } else {
      validPools.push(pool);
    }
  });

  // Log all rejected names
  if (rejectedNames.length > 0) {
    console.log(
      "Rejected token names due to HTML/Markdown content:",
      rejectedNames
    );
  }


  // Helper: get fee pct string
  function getFeePct(pool: Pool): string {
    return pool.feeTier ? (parseFloat(pool.feeTier) / 10000).toFixed(2) + "%" : "";
  }
  return validPools.map((pool) => {
    const token0 = pool.token0;
    const token1 = pool.token1;
    const feePct = getFeePct(pool);
    const tick = pool.tickSpacing ?? 'N/A';
    const suffix = ` CL Pool (${feePct}, tick: ${tick})`;
    const maxSymbolsLen = 50 - suffix.length - 1; // -1 for '/'
    let symbol0 = token0.symbol;
    let symbol1 = token1.symbol;
    let symbolsText = `${symbol0}/${symbol1}`;
    if (symbolsText.length > maxSymbolsLen) {
      // Truncate both symbols proportionally and add '...'
      // Reserve space for two '...' (6 chars)
      const ellipsis = '...';
      const reserved = 6; // for two '...'
      const available = maxSymbolsLen - reserved;
      const half = Math.floor(available / 2);
      let len0 = Math.ceil(half);
      let len1 = Math.floor(available - len0);
      if (symbol0.length > len0) symbol0 = symbol0.slice(0, len0) + ellipsis;
      if (symbol1.length > len1) symbol1 = symbol1.slice(0, len1) + ellipsis;
      symbolsText = `${symbol0}/${symbol1}`;
    }
    let tagName = `${symbolsText}${suffix}`;
    // Safety check: truncate to 50 chars if off by 1 due to rounding
    if (tagName.length > 50) {
      tagName = tagName.slice(0, 50);
    }
    return {
      "Contract Address": `eip155:${chainId}:${pool.id}`,
      "Public Name Tag": tagName,
      "Project Name": "Ramses Concentrated Liquidity",
      "UI/Website Link": "https://ramses.exchange",
      "Public Note": `Ramses CL pool for ${token0.symbol} (${token0.name}) / ${token1.symbol} (${token1.name}), fee tier: ${pool.feeTier}, tick spacing: ${pool.tickSpacing ?? 'N/A'}`
    };
  });
}


// --- main logic ---


async function fetchPools(apiKey: string, lastTimestamp: number): Promise<Pool[]> {
  const resp = await fetch(endpoint(apiKey), {
    method: "POST",
    headers,
    body: JSON.stringify({ query: PAIR_QUERY, variables: { lastTimestamp } }),
  });
  if (!resp.ok) {
    throw new Error(`HTTP error: ${resp.status}`);
  }
  const json = (await resp.json()) as GraphQLResponse;
  if (json.errors) {
    json.errors.forEach((error) => {
      console.error(`GraphQL error: ${error.message}`);
    });
    throw new Error("GraphQL errors occurred: see logs for details.");
  }
  if (!json.data || !json.data.pools) {
    throw new Error("No pools data found.");
  }
  return json.data.pools;
}



class TagService implements ITagService {
  returnTags = async (
    chainId: string,
    apiKey: string
  ): Promise<ContractTag[]> => {
    if (Number(chainId) !== 42161)
      throw new Error(`Unsupported Chain ID: ${chainId}. Only Arbitrum (42161) is supported.`);
    if (!apiKey) throw new Error("API key is required");
    let lastTimestamp: number = 0;
    let allTags: ContractTag[] = [];
    let isMore = true;
    let counter = 0;
    const seenAddr = new Set<string>();
    while (isMore) {
      let pools: Pool[];
      try {
        pools = await fetchPools(apiKey, lastTimestamp);
        const tagsForPools = transformPoolsToTags(chainId, pools).filter(tag => {
          if (seenAddr.has(tag["Contract Address"])) return false;
          seenAddr.add(tag["Contract Address"]);
          return true;
        });
        allTags.push(...tagsForPools);
        counter++;
        console.log(`Retrieved first ${counter * 1000} entries...`);
        isMore = pools.length === 1000;
        if (isMore) {
          lastTimestamp = pools[pools.length - 1].createdAtTimestamp;
        }
      } catch (error) {
        if (isError(error)) {
          console.error(`An error occurred: ${error.message}`);
          throw new Error(`Failed fetching data: ${error}`);
        } else {
          console.error("An unknown error occurred.");
          throw new Error("An unknown error occurred during fetch operation.");
        }
      }
    }
    return allTags;
  };
}

const tagService = new TagService();
export const returnTags = tagService.returnTags;
