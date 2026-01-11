import { sdk } from "https://esm.sh/@farcaster/miniapp-sdk";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type VerifyResponse = {
  fid: number;
  username?: string;
  displayName?: string;
  custodyAddress?: string;
  verifiedEthAddresses?: string[];
};

const CONTRACT = "0x09154248fFDbaF8aA877aE8A4bf8cE1503596428";
const BASE_CHAIN_ID = "0x2105";
const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_ID,
  chainName: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://base.publicnode.com"],
  blockExplorerUrls: ["https://basescan.org"],
};
const BASE_RPC_URL = BASE_CHAIN_PARAMS.rpcUrls[0] || "";

const urlParams = new URLSearchParams(window.location.search);
const debugEnabled =
  urlParams.has("debug") || window.localStorage.getItem("debug") === "1";
const appVersion = (document.body.dataset.appVersion || "").trim() || "unknown";
const apiOriginOverride = (urlParams.get("apiOrigin") || "").trim();
const htmlApiOrigin = (document.body.dataset.apiOrigin || "").trim();
const apiOrigin = (apiOriginOverride || htmlApiOrigin).trim();
const defaultApiBase = resolveApiBase(
  "https://degendogs-dao.ael-dev3.deno.net",
);
const isFirebaseHost =
  window.location.origin.includes("web.app") ||
  window.location.origin.includes("firebaseapp.com");
const apiBase = resolveApiBase(
  apiOrigin || (isFirebaseHost ? defaultApiBase : window.location.origin),
);
const apiVerifyUrl = `${apiBase}/api/verify`;
const fallbackVerifyUrl = `${defaultApiBase}/api/verify`;
const authStatus = byId("auth-status");
const walletStatus = byId("wallet-status");
const chainStatus = byId("chain-status");
const dogsStatus = byId("dogs-status");
const resultBox = byId("result");
const authButton = byId("auth-btn") as HTMLButtonElement;
const authButtonLabel =
  authButton.textContent?.trim() || "Sign in & verify profile";
const walletButton = byId("wallet-btn") as HTMLButtonElement;
const walletButtonLabel =
  walletButton.textContent?.trim() || "Connect wallet";
const debugPanel = document.getElementById("debug-panel");
const debugLog = document.getElementById("debug-log");
const debugApi = document.getElementById("debug-api");
const debugMode = document.getElementById("debug-mode");
const debugVersion = document.getElementById("debug-version");
const debugLines: string[] = [];

let provider: EthereumProvider | null = null;
let address: string | null = null;
let fid: number | null = null;
let verifiedAddresses: string[] = [];
let hasSignedIn = false;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element: ${id}`);
  }
  return el;
}

function setText(el: HTMLElement, text: string) {
  el.textContent = text;
}

function setResult(state: string, text: string) {
  resultBox.dataset.state = state;
  resultBox.textContent = text;
}

function setBusy(button: HTMLButtonElement, isBusy: boolean) {
  button.disabled = isBusy;
  button.setAttribute("aria-busy", isBusy ? "true" : "false");
}

function setButtonLabel(button: HTMLButtonElement, text: string) {
  button.textContent = text;
}

function resolveApiBase(raw: string) {
  let base = raw.trim();
  if (!base) {
    return window.location.origin;
  }
  if (base.includes("/api/verify")) {
    base = base.replace(/\/api\/verify\/?$/, "");
  }
  return base.replace(/\/+$/, "");
}

function setDebugValue(el: HTMLElement | null, text: string) {
  if (el) {
    el.textContent = text;
  }
}

function truncate(value: string, max = 260) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  const raw = parts[1] || "";
  if (!raw) {
    return null;
  }
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  try {
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatTokenTimestamp(value: unknown) {
  if (typeof value !== "number") {
    return undefined;
  }
  return new Date(value * 1000).toISOString();
}

function logDebug(message: string, detail?: unknown) {
  if (!debugEnabled || !debugLog) {
    return;
  }
  const stamp = new Date().toISOString().slice(11, 19);
  let line = `[${stamp}] ${message}`;
  if (detail !== undefined) {
    let detailText = "";
    try {
      detailText =
        typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    } catch {
      detailText = String(detail);
    }
    line += `\n${truncate(detailText, 1200)}`;
  }
  debugLines.push(line);
  if (debugLines.length > 200) {
    debugLines.shift();
  }
  debugLog.textContent = debugLines.join("\n\n");
  if (console && console.debug) {
    console.debug(message, detail);
  }
}

function logError(context: string, err: unknown) {
  logDebug(`${context} error`, errorMessage(err));
  if (err instanceof Error && err.stack) {
    logDebug(`${context} stack`, truncate(err.stack, 1200));
  }
}

function apiConfigLines(activeUrl: string) {
  return [
    `URL: ${activeUrl}`,
    `data-api-origin: ${apiOrigin || "(empty)"}`,
    `window.origin: ${window.location.origin}`,
    `fallback: ${fallbackVerifyUrl}`,
    `firebaseHost: ${isFirebaseHost ? "yes" : "no"}`,
    `version: ${appVersion}`,
  ];
}

function authEndpointErrorMessage(
  status: number,
  bodyText: string,
  activeUrl: string,
) {
  const lines = [`Auth endpoint not found (HTTP ${status}).`, `URL: ${activeUrl}`];
  lines.push(...apiConfigLines(activeUrl));
  if (bodyText) {
    lines.push(`body: ${truncate(bodyText, 260)}`);
  }
  return lines.join("\n");
}

function formatAddress(value: string | null) {
  if (!value || value.length < 10) {
    return value || "";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function normalizeAddress(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function uniqueAddresses(addresses: string[]) {
  const unique = new Set<string>();
  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function encodeBalanceOf(addr: string) {
  const clean = addr.toLowerCase().replace("0x", "");
  if (clean.length !== 40) {
    throw new Error("Invalid address");
  }
  return "0x70a08231" + clean.padStart(64, "0");
}

function parseHexToBigInt(value: string) {
  if (!value || value === "0x") {
    return 0n;
  }
  return BigInt(value);
}

function errorMessage(err: unknown) {
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isMethodUnsupported(err: unknown) {
  const message = errorMessage(err).toLowerCase();
  const code =
    err && typeof err === "object"
      ? (err as { code?: number | string }).code
      : undefined;
  return (
    message.includes("not support") ||
    message.includes("unsupported") ||
    code === -32601 ||
    code === "METHOD_NOT_FOUND" ||
    code === 4200 ||
    code === "4200"
  );
}

function normalizeChainId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `0x${value.toString(16)}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      return `0x${trimmed.slice(2).toLowerCase()}`;
    }
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return `0x${asNumber.toString(16)}`;
    }
  }
  return null;
}

async function requestAccounts(activeProvider: EthereumProvider) {
  try {
    const accounts = (await activeProvider.request({
      method: "eth_requestAccounts",
    })) as string[];
    if (accounts?.length) {
      return accounts;
    }
  } catch (err) {
    if (!isMethodUnsupported(err)) {
      throw err;
    }
    logDebug("Wallet: eth_requestAccounts unsupported", errorMessage(err));
  }

  try {
    const accounts = (await activeProvider.request({
      method: "eth_accounts",
    })) as string[];
    if (accounts?.length) {
      return accounts;
    }
  } catch (err) {
    if (!isMethodUnsupported(err)) {
      throw err;
    }
    logDebug("Wallet: eth_accounts unsupported", errorMessage(err));
  }

  throw new Error(
    "Wallet provider does not expose accounts. Open the mini app in a Farcaster client with a connected wallet.",
  );
}

async function rpcCallBase(method: string, params: unknown[]) {
  if (!BASE_RPC_URL) {
    throw new Error("Base RPC URL is not configured.");
  }
  const res = await fetch(BASE_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(`Base RPC HTTP ${res.status}`);
  }
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (json.error) {
    throw new Error(json.error.message || "Base RPC error");
  }
  return json.result ?? "";
}

async function balanceOfAddress(address: string) {
  const data = encodeBalanceOf(address);
  const result = await rpcCallBase("eth_call", [{ to: CONTRACT, data }, "latest"]);
  return parseHexToBigInt(result);
}

async function checkProfileHoldings() {
  setText(walletStatus, "Profile only");
  setText(chainStatus, "Base (rpc)");
  setText(dogsStatus, "Checking...");
  setResult("idle", "Checking verified addresses...");

  const addresses = uniqueAddresses(verifiedAddresses);
  const skipped = Math.max(0, verifiedAddresses.length - addresses.length);
  if (skipped) {
    logDebug("Profile: skipped invalid addresses", skipped);
  }

  if (!addresses.length) {
    setText(dogsStatus, "0");
    setResult(
      "warn",
      "No verified addresses on your Farcaster profile. Connect a wallet to check holdings.",
    );
    return { total: 0n, checked: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    addresses.map((address) => balanceOfAddress(address)),
  );
  let total = 0n;
  let checked = 0;
  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      total += result.value;
      checked += 1;
    } else {
      failed += 1;
      logDebug("Profile: balanceOf failed", {
        address: addresses[index],
        error: errorMessage(result.reason),
      });
    }
  });

  if (!checked) {
    setText(dogsStatus, "Error");
    setResult("error", "Unable to check verified addresses right now.");
    return { total, checked, failed };
  }

  setText(dogsStatus, total.toString());
  const walletLabel = pluralize(checked, "wallet");
  const failureNote = failed
    ? ` ${failed} ${pluralize(failed, "address")} failed to load.`
    : "";
  if (total > 0n) {
    setResult(
      "ok",
      `Verified addresses hold ${total} Degen Dogs across ${checked} ${walletLabel}.${failureNote}`,
    );
  } else {
    setResult(
      "warn",
      `No Degen Dogs found across ${checked} verified ${walletLabel}.${failureNote}`,
    );
  }

  return { total, checked, failed };
}

function formatErrorDetail(value: { error?: string; [key: string]: unknown }) {
  const base = value.error || "error";
  const extras = Object.entries(value)
    .filter(([key, item]) => key !== "error" && item !== undefined && item !== "")
    .map(([key, item]) => {
      if (
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
      ) {
        return `${key}=${String(item)}`;
      }
      try {
        return `${key}=${truncate(JSON.stringify(item), 260)}`;
      } catch {
        return `${key}=${String(item)}`;
      }
    });
  if (!extras.length) {
    return base;
  }
  return `${base} (${extras.join(", ")})`;
}

async function getProvider() {
  if (provider) {
    return provider;
  }
  const next = (await sdk.wallet.getEthereumProvider()) as EthereumProvider | null;
  if (!next) {
    throw new Error("No wallet provider available");
  }
  provider = next;
  return provider;
}

async function ensureBaseChain(
  activeProvider: EthereumProvider,
  allowSwitch = false,
) {
  setText(chainStatus, "Checking...");
  let chainId: string | null = null;
  try {
    const rawChainId = await activeProvider.request({ method: "eth_chainId" });
    chainId = normalizeChainId(rawChainId);
    logDebug("Wallet chainId", chainId ?? rawChainId);
  } catch (err) {
    logError("wallet_chainId", err);
    setText(chainStatus, "Unknown (rpc)");
    return { chainId: null, useRpcFallback: true };
  }

  if (allowSwitch && chainId !== BASE_CHAIN_ID) {
    try {
      await activeProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID }],
      });
      const rawNextChainId = await activeProvider.request({ method: "eth_chainId" });
      chainId = normalizeChainId(rawNextChainId);
    } catch (err) {
      const code =
        err && typeof err === "object"
          ? (err as { code?: number | string }).code
          : null;
      const message = errorMessage(err);
      logDebug("wallet_switchEthereumChain failed", {
        code,
        message,
      });
      const messageLower = message.toLowerCase();
      const isRejected =
        code === 4001 ||
        code === "4001" ||
        code === "ACTION_REJECTED" ||
        messageLower.includes("user rejected");
      if (code === 4902 || code === "4902") {
        try {
          await activeProvider.request({
            method: "wallet_addEthereumChain",
            params: [BASE_CHAIN_PARAMS],
          });
          const rawNextChainId = await activeProvider.request({ method: "eth_chainId" });
          chainId = normalizeChainId(rawNextChainId);
        } catch (addErr) {
          logError("wallet_addEthereumChain", addErr);
          setText(chainStatus, chainId ? `Chain ${chainId} (rpc)` : "Unknown (rpc)");
          return { chainId, useRpcFallback: true };
        }
      } else if (isMethodUnsupported(err) || isRejected) {
        setText(chainStatus, chainId ? `Chain ${chainId} (rpc)` : "Unknown (rpc)");
        return { chainId, useRpcFallback: true };
      } else {
        throw err;
      }
    }
  }

  const isBase = chainId === BASE_CHAIN_ID;
  setText(
    chainStatus,
    isBase ? "Base (0x2105)" : chainId ? `Chain ${chainId}` : "Unknown (rpc)",
  );
  return { chainId, useRpcFallback: !isBase };
}

async function readResponseText(res: Response) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

type AuthAttempt = {
  res: Response;
  bodyText: string;
  parsed: VerifyResponse | { error?: string } | null;
  url: string;
};

async function quickAuthFetch(url: string): Promise<AuthAttempt> {
  logDebug("Auth: quickAuth.fetch", url);
  const res = await sdk.quickAuth.fetch(url);
  logDebug("Auth: response", `${res.status} ${res.statusText}`);
  const traceId = res.headers.get("x-deno-trace-id");
  if (traceId) {
    logDebug("Auth: deno trace id", traceId);
  }
  const bodyText = await readResponseText(res);
  let parsed: VerifyResponse | { error?: string } | null = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText) as VerifyResponse | { error?: string };
    } catch {
      logDebug("Auth: non-JSON response", bodyText);
    }
  }
  return { res, bodyText, parsed, url };
}

async function logQuickAuthToken(context: string) {
  if (!debugEnabled) {
    return;
  }
  try {
    const tokenResult = await sdk.quickAuth.getToken();
    const token =
      typeof tokenResult === "string"
        ? tokenResult
        : tokenResult && typeof tokenResult === "object"
          ? (tokenResult as { token?: string }).token
          : undefined;
    if (!token) {
      logDebug(`${context}: token`, "none");
      return;
    }
    const payload = decodeJwtPayload(token);
    if (!payload) {
      logDebug(`${context}: token`, "unreadable");
      return;
    }
    logDebug(`${context}: token`, {
      aud: payload.aud,
      iss: payload.iss,
      sub: payload.sub,
      exp: formatTokenTimestamp(payload.exp),
      iat: formatTokenTimestamp(payload.iat),
    });
  } catch (err) {
    logError(`${context}: token`, err);
  }
}

async function debugProbe() {
  if (!debugEnabled) {
    return;
  }
  try {
    const res = await fetch(`${apiBase}/api/verify`, { method: "GET" });
    logDebug("Probe GET /api/verify", `${res.status} ${res.statusText}`);
    const text = await readResponseText(res);
    if (text) {
      logDebug("Probe body", text);
    }
  } catch (err) {
    logError("Probe", err);
  }
}

async function handleSignIn() {
  setBusy(authButton, true);
  setButtonLabel(authButton, "Signing in...");
  setResult("idle", "Requesting Farcaster sign in...");
  setText(authStatus, "Signing in...");
  setBusy(walletButton, true);
  walletButton.disabled = true;
  setButtonLabel(walletButton, walletButtonLabel);

  let signedIn = false;
  try {
    // Quick Auth triggers Farcaster sign-in if needed.
    const attempt = await quickAuthFetch(apiVerifyUrl);
    let res = attempt.res;
    let bodyText = attempt.bodyText;
    let parsed = attempt.parsed;
    let activeAuthUrl = apiVerifyUrl;
    if (
      !res.ok &&
      (res.status === 404 || res.status === 405) &&
      fallbackVerifyUrl !== apiVerifyUrl
    ) {
      logDebug("Auth: retry fallback", fallbackVerifyUrl);
      const fallback = await quickAuthFetch(fallbackVerifyUrl);
      if (
        fallback.res.ok ||
        (fallback.res.status !== 404 && fallback.res.status !== 405)
      ) {
        res = fallback.res;
        bodyText = fallback.bodyText;
        parsed = fallback.parsed;
        activeAuthUrl = fallbackVerifyUrl;
        logDebug("Auth: using fallback", activeAuthUrl);
      }
    }
    await logQuickAuthToken("Auth");

    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error(
          authEndpointErrorMessage(res.status, bodyText, activeAuthUrl),
        );
      }
      const detail =
        parsed && "error" in parsed && parsed.error
          ? formatErrorDetail(parsed)
          : bodyText
            ? truncate(bodyText)
            : `HTTP ${res.status}`;
      throw new Error(`Auth failed: ${detail}`);
    }

    if (!parsed || !("fid" in parsed)) {
      throw new Error("Auth failed: invalid response body");
    }
    const data = parsed as VerifyResponse;
    fid = data.fid;
    verifiedAddresses = Array.isArray(data.verifiedEthAddresses)
      ? data.verifiedEthAddresses
      : [];
    if (data.custodyAddress) {
      verifiedAddresses = Array.from(
        new Set([...verifiedAddresses, data.custodyAddress]),
      );
    }
    const handle = data.username ? `@${data.username}` : "";
    setText(authStatus, handle ? `${handle} (FID ${fid})` : `FID ${fid}`);
    setResult(
      "ok",
      data.displayName
        ? `${data.displayName} signed in.`
        : "Farcaster sign in verified.",
    );
    logDebug("Auth: verified", {
      fid,
      username: data.username,
      verifiedAddressCount: verifiedAddresses.length,
    });
    signedIn = true;
    try {
      await checkProfileHoldings();
    } catch (err) {
      logError("Profile", err);
      setResult("error", errorMessage(err));
    }
    walletButton.disabled = false;
    setBusy(walletButton, false);
  } catch (err) {
    const msg = errorMessage(err);
    logError("Auth", err);
    setText(authStatus, "Not signed in");
    if (msg.toLowerCase().includes("fetch")) {
      setResult(
        "error",
        "Auth server not reachable. Set data-api-origin in index.html.",
      );
    } else {
      setResult("error", msg);
    }
    walletButton.disabled = true;
    setBusy(walletButton, false);
  }

  hasSignedIn = signedIn;
  setBusy(authButton, false);
  setButtonLabel(authButton, hasSignedIn ? "Recheck profile" : authButtonLabel);
  return signedIn;
}

async function handleWalletCheck() {
  if (!hasSignedIn) {
    setResult("warn", "Sign in first to verify your profile.");
    return false;
  }

  setBusy(walletButton, true);
  setButtonLabel(walletButton, "Checking wallet...");
  try {
    await connectWalletAndCheck();
    return true;
  } catch (err) {
    const message = errorMessage(err);
    const lower = message.toLowerCase();
    if (
      lower.includes("no wallet provider") ||
      lower.includes("does not expose accounts")
    ) {
      setResult(
        "warn",
        "Wallet provider not available. Open this mini app inside Farcaster to connect a wallet.",
      );
    } else {
      setResult("error", message);
    }
    return false;
  } finally {
    setBusy(walletButton, false);
    setButtonLabel(walletButton, "Recheck wallet");
  }
}

async function connectWalletAndCheck() {
  setResult("idle", "Connecting Farcaster wallet...");
  setText(walletStatus, "Connecting...");
  setText(dogsStatus, "Checking...");

  try {
    const activeProvider = await getProvider();
    logDebug("Wallet: provider ready");
    const { chainId } = await ensureBaseChain(activeProvider, false);

    const accounts = await requestAccounts(activeProvider);

    address = accounts[0];
    setText(walletStatus, formatAddress(address));
    logDebug("Wallet: account", formatAddress(address));

    setResult("idle", "Checking Degen Dogs ownership...");
    const data = encodeBalanceOf(address);
    const rpcNote = " Read-only check via Base RPC.";
    const chainNote =
      chainId && chainId !== BASE_CHAIN_ID
        ? ` Wallet is on ${chainId}.`
        : "";
    const result = await rpcCallBase("eth_call", [{ to: CONTRACT, data }, "latest"]);
    logDebug("Wallet: rpc balance check", BASE_RPC_URL);

    const balance = parseHexToBigInt(result);
    setText(dogsStatus, balance.toString());
    logDebug("Wallet: balance", balance.toString());
    const normalizedAddress = address.toLowerCase();
    const hasVerifiedMatch = verifiedAddresses.some(
      (addr) => addr.toLowerCase() === normalizedAddress,
    );
    const verificationNote =
      verifiedAddresses.length && !hasVerifiedMatch
        ? " Wallet not linked to your Farcaster profile."
        : "";
    if (balance > 0n) {
      setResult(
        "ok",
        `Holder verified with ${balance} Degen Dogs.${verificationNote}${chainNote}${rpcNote}`,
      );
    } else {
      setResult(
        "warn",
        `No Degen Dogs found for this wallet.${verificationNote}${chainNote}${rpcNote}`,
      );
    }
  } catch (err) {
    setText(walletStatus, "Not connected");
    setText(chainStatus, "Unknown");
    setText(dogsStatus, "Unchecked");
    logError("Wallet", err);
    throw err;
  }
}

async function init() {
  authButton.addEventListener("click", handleSignIn);
  walletButton.addEventListener("click", handleWalletCheck);
  walletButton.disabled = true;
  if (debugPanel) {
    debugPanel.hidden = !debugEnabled;
  }
  if (debugEnabled) {
    setDebugValue(debugApi, apiBase);
    const originNote = apiOrigin
      ? `apiOrigin=${apiOrigin}`
      : "apiOrigin=window.location";
    setDebugValue(
      debugMode,
      `on (${originNote}, crossOrigin=${apiBase !== window.location.origin})`,
    );
    setDebugValue(debugVersion, appVersion);
    logDebug("Debug enabled");
    logDebug("App version", appVersion);
    logDebug("Location", window.location.href);
    logDebug("API base", apiBase);
    logDebug("Firebase host", isFirebaseHost);
    if (apiOriginOverride) {
      logDebug("API override", apiOriginOverride);
    }
    debugProbe();
  }

  try {
    await sdk.actions.ready();
    logDebug("SDK ready");
    if (debugEnabled) {
      try {
        const context = await sdk.context;
        logDebug("SDK context", context);
      } catch (err) {
        logError("SDK context", err);
      }
    }
  } catch (err) {
    logError("SDK ready", err);
    setResult("warn", "Not running inside a Farcaster host.");
  }
}

init();
