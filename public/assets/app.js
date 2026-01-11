import { sdk } from "https://esm.sh/@farcaster/miniapp-sdk";
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
const debugEnabled = urlParams.has("debug") || window.localStorage.getItem("debug") === "1";
const appVersion = (document.body.dataset.appVersion || "").trim() || "unknown";
const apiOriginOverride = (urlParams.get("apiOrigin") || "").trim();
const htmlApiOrigin = (document.body.dataset.apiOrigin || "").trim();
const apiOrigin = (apiOriginOverride || htmlApiOrigin).trim();
const defaultApiBase = resolveApiBase("https://degendogs-dao.ael-dev3.deno.net");
const isFirebaseHost = window.location.origin.includes("web.app") ||
    window.location.origin.includes("firebaseapp.com");
const apiBase = resolveApiBase(apiOrigin || (isFirebaseHost ? defaultApiBase : window.location.origin));
const apiVerifyUrl = `${apiBase}/api/verify`;
const fallbackVerifyUrl = `${defaultApiBase}/api/verify`;
const authStatus = byId("auth-status");
const walletStatus = byId("wallet-status");
const chainStatus = byId("chain-status");
const dogsStatus = byId("dogs-status");
const resultBox = byId("result");
const authButton = byId("auth-btn");
const authButtonLabel = authButton.textContent?.trim() || "Sign in & verify";
const walletButton = byId("wallet-btn");
const walletButtonLabel = walletButton.textContent?.trim() || "Connect wallet";
const debugPanel = document.getElementById("debug-panel");
const debugLog = document.getElementById("debug-log");
const debugApi = document.getElementById("debug-api");
const debugMode = document.getElementById("debug-mode");
const debugVersion = document.getElementById("debug-version");
const debugLines = [];
let provider = null;
let address = null;
let fid = null;
let verifiedAddresses = [];
let hasSignedIn = false;
let sdkReady = false;
let profileHoldings = null;
function byId(id) {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`Missing element: ${id}`);
    }
    return el;
}
function setText(el, text) {
    el.textContent = text;
}
function setResult(state, text) {
    resultBox.dataset.state = state;
    resultBox.textContent = text;
}
function setBusy(button, isBusy) {
    button.disabled = isBusy;
    button.setAttribute("aria-busy", isBusy ? "true" : "false");
}
function setButtonLabel(button, text) {
    button.textContent = text;
}
function resolveApiBase(raw) {
    let base = raw.trim();
    if (!base) {
        return window.location.origin;
    }
    if (base.includes("/api/verify")) {
        base = base.replace(/\/api\/verify\/?$/, "");
    }
    return base.replace(/\/+$/, "");
}
function setDebugValue(el, text) {
    if (el) {
        el.textContent = text;
    }
}
function truncate(value, max = 260) {
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max)}...`;
}
function decodeJwtPayload(token) {
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
        return JSON.parse(atob(padded));
    }
    catch {
        return null;
    }
}
function formatTokenTimestamp(value) {
    if (typeof value !== "number") {
        return undefined;
    }
    return new Date(value * 1000).toISOString();
}
function logDebug(message, detail) {
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
        }
        catch {
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
function logError(context, err) {
    logDebug(`${context} error`, errorMessage(err));
    if (err instanceof Error && err.stack) {
        logDebug(`${context} stack`, truncate(err.stack, 1200));
    }
}
function apiConfigLines(activeUrl) {
    return [
        `URL: ${activeUrl}`,
        `data-api-origin: ${apiOrigin || "(empty)"}`,
        `window.origin: ${window.location.origin}`,
        `fallback: ${fallbackVerifyUrl}`,
        `firebaseHost: ${isFirebaseHost ? "yes" : "no"}`,
        `version: ${appVersion}`,
    ];
}
function authEndpointErrorMessage(status, bodyText, activeUrl) {
    const lines = [`Auth endpoint not found (HTTP ${status}).`, `URL: ${activeUrl}`];
    lines.push(...apiConfigLines(activeUrl));
    if (bodyText) {
        lines.push(`body: ${truncate(bodyText, 260)}`);
    }
    return lines.join("\n");
}
function formatAddress(value) {
    if (!value || value.length < 10) {
        return value || "";
    }
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
function normalizeAddress(value) {
    const trimmed = value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(trimmed)) {
        return null;
    }
    return trimmed;
}
function uniqueAddresses(addresses) {
    const unique = new Set();
    for (const address of addresses) {
        const normalized = normalizeAddress(address);
        if (normalized) {
            unique.add(normalized);
        }
    }
    return Array.from(unique);
}
function pluralize(count, singular, plural = `${singular}s`) {
    return count === 1 ? singular : plural;
}
function profileSummaryForWalletResult(summary) {
    if (!summary.checked) {
        return "No verified addresses on your Farcaster profile.";
    }
    const walletLabel = pluralize(summary.checked, "wallet");
    const failureNote = summary.failed
        ? ` ${summary.failed} ${pluralize(summary.failed, "address")} failed to load.`
        : "";
    if (summary.total > 0n) {
        return `Verified addresses hold ${summary.total} Degen Dogs across ${summary.checked} ${walletLabel}.${failureNote}`;
    }
    return `No Degen Dogs found across ${summary.checked} verified ${walletLabel}.${failureNote}`;
}
function encodeBalanceOf(addr) {
    const clean = addr.toLowerCase().replace("0x", "");
    if (clean.length !== 40) {
        throw new Error("Invalid address");
    }
    return "0x70a08231" + clean.padStart(64, "0");
}
function parseHexToBigInt(value) {
    if (!value || value === "0x") {
        return 0n;
    }
    return BigInt(value);
}
function errorMessage(err) {
    if (err instanceof Error) {
        return err.message;
    }
    try {
        return JSON.stringify(err);
    }
    catch {
        return String(err);
    }
}
function isMethodUnsupported(err) {
    const message = errorMessage(err).toLowerCase();
    const code = err && typeof err === "object"
        ? err.code
        : undefined;
    return (message.includes("not support") ||
        message.includes("unsupported") ||
        code === -32601 ||
        code === "METHOD_NOT_FOUND" ||
        code === 4200 ||
        code === "4200");
}
function isUserRejected(err) {
    const message = errorMessage(err).toLowerCase();
    const code = err && typeof err === "object"
        ? err.code
        : undefined;
    return (code === 4001 ||
        code === "4001" ||
        code === "ACTION_REJECTED" ||
        message.includes("user rejected"));
}
function normalizeChainId(value) {
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
async function requestAccounts(activeProvider, allowPrompt = true) {
    const methods = allowPrompt
        ? ["eth_accounts", "eth_requestAccounts"]
        : ["eth_accounts"];
    for (const method of methods) {
        try {
            const accounts = (await activeProvider.request({
                method,
            }));
            if (accounts?.length) {
                return accounts;
            }
        }
        catch (err) {
            if (isMethodUnsupported(err)) {
                logDebug(`Wallet: ${method} unsupported`, errorMessage(err));
                continue;
            }
            if (isUserRejected(err)) {
                logDebug(`Wallet: ${method} rejected`, errorMessage(err));
                return null;
            }
            throw err;
        }
    }
    return null;
}
async function rpcCallBase(method, params) {
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
    const json = (await res.json());
    if (json.error) {
        throw new Error(json.error.message || "Base RPC error");
    }
    return json.result ?? "";
}
async function balanceOfAddress(address) {
    const data = encodeBalanceOf(address);
    const result = await rpcCallBase("eth_call", [{ to: CONTRACT, data }, "latest"]);
    return parseHexToBigInt(result);
}
async function checkProfileHoldings() {
    profileHoldings = null;
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
        setResult("warn", "No verified addresses on your Farcaster profile. Connect a wallet to check holdings.");
        profileHoldings = { total: 0n, checked: 0, failed: 0 };
        return profileHoldings;
    }
    const results = await Promise.allSettled(addresses.map((address) => balanceOfAddress(address)));
    let total = 0n;
    let checked = 0;
    let failed = 0;
    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            total += result.value;
            checked += 1;
        }
        else {
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
        profileHoldings = null;
        return { total, checked, failed };
    }
    setText(dogsStatus, total.toString());
    const walletLabel = pluralize(checked, "wallet");
    const failureNote = failed
        ? ` ${failed} ${pluralize(failed, "address")} failed to load.`
        : "";
    if (total > 0n) {
        setResult("ok", `Verified addresses hold ${total} Degen Dogs across ${checked} ${walletLabel}.${failureNote}`);
    }
    else {
        setResult("warn", `No Degen Dogs found across ${checked} verified ${walletLabel}.${failureNote}`);
    }
    profileHoldings = { total, checked, failed };
    return profileHoldings;
}
function formatErrorDetail(value) {
    const base = value.error || "error";
    const extras = Object.entries(value)
        .filter(([key, item]) => key !== "error" && item !== undefined && item !== "")
        .map(([key, item]) => {
        if (typeof item === "string" ||
            typeof item === "number" ||
            typeof item === "boolean") {
            return `${key}=${String(item)}`;
        }
        try {
            return `${key}=${truncate(JSON.stringify(item), 260)}`;
        }
        catch {
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
    const next = (await sdk.wallet.getEthereumProvider());
    if (!next) {
        throw new Error("No wallet provider available");
    }
    provider = next;
    return provider;
}
async function ensureBaseChain(activeProvider, allowSwitch = false) {
    setText(chainStatus, "Checking...");
    let chainId = null;
    try {
        const rawChainId = await activeProvider.request({ method: "eth_chainId" });
        chainId = normalizeChainId(rawChainId);
        logDebug("Wallet chainId", chainId ?? rawChainId);
    }
    catch (err) {
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
        }
        catch (err) {
            const code = err && typeof err === "object"
                ? err.code
                : null;
            const message = errorMessage(err);
            logDebug("wallet_switchEthereumChain failed", {
                code,
                message,
            });
            if (code === 4902 || code === "4902") {
                try {
                    await activeProvider.request({
                        method: "wallet_addEthereumChain",
                        params: [BASE_CHAIN_PARAMS],
                    });
                    const rawNextChainId = await activeProvider.request({ method: "eth_chainId" });
                    chainId = normalizeChainId(rawNextChainId);
                }
                catch (addErr) {
                    logError("wallet_addEthereumChain", addErr);
                    setText(chainStatus, chainId ? `Chain ${chainId} (rpc)` : "Unknown (rpc)");
                    return { chainId, useRpcFallback: true };
                }
            }
            else if (isMethodUnsupported(err) || isUserRejected(err)) {
                setText(chainStatus, chainId ? `Chain ${chainId} (rpc)` : "Unknown (rpc)");
                return { chainId, useRpcFallback: true };
            }
            else {
                throw err;
            }
        }
    }
    const isBase = chainId === BASE_CHAIN_ID;
    setText(chainStatus, isBase ? "Base (0x2105)" : chainId ? `Chain ${chainId}` : "Unknown (rpc)");
    return { chainId, useRpcFallback: !isBase };
}
async function readResponseText(res) {
    try {
        return await res.text();
    }
    catch {
        return "";
    }
}
async function quickAuthFetch(url) {
    logDebug("Auth: quickAuth.fetch", url);
    const res = await sdk.quickAuth.fetch(url);
    logDebug("Auth: response", `${res.status} ${res.statusText}`);
    const traceId = res.headers.get("x-deno-trace-id");
    if (traceId) {
        logDebug("Auth: deno trace id", traceId);
    }
    const bodyText = await readResponseText(res);
    let parsed = null;
    if (bodyText) {
        try {
            parsed = JSON.parse(bodyText);
        }
        catch {
            logDebug("Auth: non-JSON response", bodyText);
        }
    }
    return { res, bodyText, parsed, url };
}
async function logQuickAuthToken(context) {
    if (!debugEnabled) {
        return;
    }
    try {
        const tokenResult = await sdk.quickAuth.getToken();
        const token = typeof tokenResult === "string"
            ? tokenResult
            : tokenResult && typeof tokenResult === "object"
                ? tokenResult.token
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
    }
    catch (err) {
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
    }
    catch (err) {
        logError("Probe", err);
    }
}
async function handleSignIn() {
    setBusy(authButton, true);
    setButtonLabel(authButton, "Signing in...");
    setResult("idle", "Requesting Farcaster sign in...");
    setText(authStatus, "Signing in...");
    setBusy(walletButton, true);
    setButtonLabel(walletButton, walletButtonLabel);
    let signedIn = false;
    try {
        // Quick Auth triggers Farcaster sign-in if needed.
        const attempt = await quickAuthFetch(apiVerifyUrl);
        let res = attempt.res;
        let bodyText = attempt.bodyText;
        let parsed = attempt.parsed;
        let activeAuthUrl = apiVerifyUrl;
        if (!res.ok &&
            (res.status === 404 || res.status === 405) &&
            fallbackVerifyUrl !== apiVerifyUrl) {
            logDebug("Auth: retry fallback", fallbackVerifyUrl);
            const fallback = await quickAuthFetch(fallbackVerifyUrl);
            if (fallback.res.ok ||
                (fallback.res.status !== 404 && fallback.res.status !== 405)) {
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
                throw new Error(authEndpointErrorMessage(res.status, bodyText, activeAuthUrl));
            }
            const detail = parsed && "error" in parsed && parsed.error
                ? formatErrorDetail(parsed)
                : bodyText
                    ? truncate(bodyText)
                    : `HTTP ${res.status}`;
            throw new Error(`Auth failed: ${detail}`);
        }
        if (!parsed || !("fid" in parsed)) {
            throw new Error("Auth failed: invalid response body");
        }
        const data = parsed;
        fid = data.fid;
        verifiedAddresses = Array.isArray(data.verifiedEthAddresses)
            ? data.verifiedEthAddresses
            : [];
        if (data.custodyAddress) {
            verifiedAddresses = Array.from(new Set([...verifiedAddresses, data.custodyAddress]));
        }
        const handle = data.username ? `@${data.username}` : "";
        setText(authStatus, handle ? `${handle} (FID ${fid})` : `FID ${fid}`);
        setResult("ok", data.displayName
            ? `${data.displayName} signed in.`
            : "Farcaster sign in verified.");
        logDebug("Auth: verified", {
            fid,
            username: data.username,
            verifiedAddressCount: verifiedAddresses.length,
        });
        signedIn = true;
        try {
            await checkProfileHoldings();
        }
        catch (err) {
            logError("Profile", err);
            setResult("error", errorMessage(err));
        }
        let autoChecked = false;
        if (sdkReady) {
            setButtonLabel(walletButton, "Connecting wallet...");
            autoChecked = await connectWalletAndCheck({
                allowPrompt: true,
                silent: true,
            });
        }
        setBusy(walletButton, false);
        walletButton.disabled = false;
        setButtonLabel(walletButton, autoChecked ? "Recheck wallet" : walletButtonLabel);
    }
    catch (err) {
        const msg = errorMessage(err);
        logError("Auth", err);
        setText(authStatus, "Not signed in");
        if (msg.toLowerCase().includes("fetch")) {
            setResult("error", "Auth server not reachable. Set data-api-origin in index.html.");
        }
        else {
            setResult("error", msg);
        }
        setBusy(walletButton, false);
        walletButton.disabled = true;
        setButtonLabel(walletButton, walletButtonLabel);
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
    const checked = await connectWalletAndCheck({ allowPrompt: true, silent: false });
    setBusy(walletButton, false);
    setButtonLabel(walletButton, checked ? "Recheck wallet" : walletButtonLabel);
    return checked;
}
async function connectWalletAndCheck(options = {}) {
    const { allowPrompt = true, silent = false } = options;
    if (!silent) {
        setResult("idle", "Connecting Farcaster wallet...");
    }
    setText(walletStatus, "Connecting...");
    setText(dogsStatus, "Checking...");
    let activeProvider;
    try {
        activeProvider = await getProvider();
    }
    catch (err) {
        logError("Wallet provider", err);
        setText(walletStatus, "Not connected");
        setText(chainStatus, "Unknown");
        setText(dogsStatus, "Unchecked");
        if (!silent) {
            setResult("warn", "Wallet provider not available. Open this mini app inside Farcaster to connect a wallet.");
        }
        return false;
    }
    try {
        logDebug("Wallet: provider ready");
        const { chainId } = await ensureBaseChain(activeProvider, false);
        const accounts = await requestAccounts(activeProvider, allowPrompt);
        if (!accounts?.length) {
            setText(walletStatus, "Not connected");
            setText(dogsStatus, "Unchecked");
            if (!silent) {
                setResult("warn", "Wallet not connected. Tap Connect wallet to retry.");
            }
            return false;
        }
        address = accounts[0];
        setText(walletStatus, formatAddress(address));
        logDebug("Wallet: account", formatAddress(address));
        if (!silent) {
            setResult("idle", "Checking Degen Dogs ownership...");
        }
        const data = encodeBalanceOf(address);
        const rpcNote = " Read-only check via Base RPC.";
        const chainNote = chainId && chainId !== BASE_CHAIN_ID
            ? ` Wallet is on ${chainId}.`
            : "";
        const result = await rpcCallBase("eth_call", [{ to: CONTRACT, data }, "latest"]);
        logDebug("Wallet: rpc balance check", BASE_RPC_URL);
        const balance = parseHexToBigInt(result);
        setText(dogsStatus, balance.toString());
        logDebug("Wallet: balance", balance.toString());
        const normalizedAddress = address.toLowerCase();
        const hasVerifiedMatch = verifiedAddresses.some((addr) => addr.toLowerCase() === normalizedAddress);
        const verificationNote = verifiedAddresses.length && !hasVerifiedMatch
            ? " Wallet not linked to your Farcaster profile."
            : "";
        if (silent && profileHoldings) {
            const profileNote = profileSummaryForWalletResult(profileHoldings);
            const walletNote = `Connected wallet holds ${balance} Degen Dogs.`;
            const combinedStatus = balance > 0n || profileHoldings.total > 0n ? "ok" : "warn";
            setResult(combinedStatus, `${profileNote} ${walletNote}${verificationNote}${chainNote}${rpcNote}`);
            return true;
        }
        if (balance > 0n) {
            setResult("ok", `Holder verified with ${balance} Degen Dogs.${verificationNote}${chainNote}${rpcNote}`);
        }
        else {
            setResult("warn", `No Degen Dogs found for this wallet.${verificationNote}${chainNote}${rpcNote}`);
        }
        return true;
    }
    catch (err) {
        setText(walletStatus, "Not connected");
        setText(chainStatus, "Unknown");
        setText(dogsStatus, "Unchecked");
        logError("Wallet", err);
        if (!silent) {
            setResult("error", errorMessage(err));
        }
        return false;
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
        setDebugValue(debugMode, `on (${originNote}, crossOrigin=${apiBase !== window.location.origin})`);
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
        sdkReady = true;
        logDebug("SDK ready");
        if (debugEnabled) {
            try {
                const context = await sdk.context;
                logDebug("SDK context", context);
            }
            catch (err) {
                logError("SDK context", err);
            }
        }
    }
    catch (err) {
        sdkReady = false;
        logError("SDK ready", err);
        setResult("warn", "Not running inside a Farcaster host.");
    }
}
init();
