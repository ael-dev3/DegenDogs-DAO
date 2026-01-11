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
function setButtonLabel(text) {
    authButton.textContent = text;
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
async function ensureBaseChain(activeProvider) {
    setText(chainStatus, "Switching...");
    let chainId = (await activeProvider.request({ method: "eth_chainId" }));
    logDebug("Wallet chainId", chainId);
    if (chainId !== BASE_CHAIN_ID) {
        try {
            await activeProvider.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: BASE_CHAIN_ID }],
            });
        }
        catch (err) {
            const code = err && typeof err === "object" ? err.code : null;
            logDebug("wallet_switchEthereumChain failed", { code, message: errorMessage(err) });
            if (code === 4902 || code === "4902") {
                await activeProvider.request({
                    method: "wallet_addEthereumChain",
                    params: [BASE_CHAIN_PARAMS],
                });
            }
            else {
                throw err;
            }
        }
    }
    chainId = (await activeProvider.request({ method: "eth_chainId" }));
    setText(chainStatus, chainId === BASE_CHAIN_ID ? "Base (0x2105)" : `Chain ${chainId}`);
    return chainId;
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
    setButtonLabel("Signing in...");
    setResult("idle", "Requesting Farcaster sign in...");
    setText(authStatus, "Signing in...");
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
        if (!res.ok) {
            if (res.status === 404 || res.status === 405) {
                throw new Error(authEndpointErrorMessage(res.status, bodyText, activeAuthUrl));
            }
            const detail = parsed && "error" in parsed && parsed.error
                ? parsed.error
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
    }
    hasSignedIn = signedIn;
    if (signedIn) {
        try {
            await connectWalletAndCheck();
        }
        catch (err) {
            setResult("error", errorMessage(err));
        }
    }
    setBusy(authButton, false);
    setButtonLabel(hasSignedIn ? "Recheck holder" : authButtonLabel);
    return signedIn;
}
async function connectWalletAndCheck() {
    setButtonLabel("Connecting wallet...");
    setResult("idle", "Connecting Farcaster wallet...");
    setText(walletStatus, "Connecting...");
    setText(dogsStatus, "Checking...");
    try {
        const activeProvider = await getProvider();
        logDebug("Wallet: provider ready");
        await ensureBaseChain(activeProvider);
        const accounts = (await activeProvider.request({ method: "eth_requestAccounts" }));
        if (!accounts || !accounts.length) {
            throw new Error("No account returned");
        }
        address = accounts[0];
        setText(walletStatus, formatAddress(address));
        logDebug("Wallet: account", formatAddress(address));
        setButtonLabel("Checking holdings...");
        setResult("idle", "Checking Degen Dogs ownership...");
        const data = encodeBalanceOf(address);
        const result = (await activeProvider.request({
            method: "eth_call",
            params: [{ to: CONTRACT, data }, "latest"],
        }));
        const balance = parseHexToBigInt(result);
        setText(dogsStatus, balance.toString());
        logDebug("Wallet: balance", balance.toString());
        const normalizedAddress = address.toLowerCase();
        const hasVerifiedMatch = verifiedAddresses.some((addr) => addr.toLowerCase() === normalizedAddress);
        const verificationNote = verifiedAddresses.length && !hasVerifiedMatch
            ? " Wallet not linked to your Farcaster profile."
            : "";
        if (balance > 0n) {
            setResult("ok", `Holder verified with ${balance} Degen Dogs.${verificationNote}`);
        }
        else {
            setResult("warn", `No Degen Dogs found for this wallet.${verificationNote}`);
        }
    }
    catch (err) {
        setText(walletStatus, "Not connected");
        setText(chainStatus, "Unknown");
        setText(dogsStatus, "Unchecked");
        logError("Wallet", err);
        throw err;
    }
}
async function init() {
    authButton.addEventListener("click", handleSignIn);
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
        logDebug("SDK ready");
    }
    catch (err) {
        logError("SDK ready", err);
        setResult("warn", "Not running inside a Farcaster host.");
    }
}
init();
