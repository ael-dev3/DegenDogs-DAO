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

const apiOrigin = (document.body.dataset.apiOrigin || "").trim();
const apiBase = apiOrigin || window.location.origin;
const isStaticHosting =
  window.location.hostname.endsWith(".web.app") ||
  window.location.hostname.endsWith(".firebaseapp.com");
const authStatus = byId("auth-status");
const walletStatus = byId("wallet-status");
const chainStatus = byId("chain-status");
const dogsStatus = byId("dogs-status");
const resultBox = byId("result");
const authButton = byId("auth-btn");
const walletButton = byId("wallet-btn");
const checkButton = byId("check-btn");

let provider = null;
let address = null;
let fid = null;

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
  return String(err);
}

async function getProvider() {
  if (provider) {
    return provider;
  }
  const next = await sdk.wallet.getEthereumProvider();
  if (!next) {
    throw new Error("No wallet provider available");
  }
  provider = next;
  return provider;
}

async function ensureBaseChain(activeProvider) {
  let chainId = await activeProvider.request({ method: "eth_chainId" });
  if (chainId !== BASE_CHAIN_ID) {
    try {
      await activeProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID }],
      });
    } catch (err) {
      const code = err && typeof err === "object" ? err.code : null;
      if (code === 4902 || code === "4902") {
        await activeProvider.request({
          method: "wallet_addEthereumChain",
          params: [BASE_CHAIN_PARAMS],
        });
      } else {
        throw err;
      }
    }
  }
  chainId = await activeProvider.request({ method: "eth_chainId" });
  setText(chainStatus, chainId === BASE_CHAIN_ID ? "Base (0x2105)" : `Chain ${chainId}`);
  return chainId;
}

async function handleSignIn() {
  setBusy(authButton, true);
  setResult("idle", "Requesting Farcaster sign in...");

  try {
    const { token } = await sdk.quickAuth.getToken();
    const res = await fetch(`${apiBase}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error(
          "Auth endpoint not found. Deploy the verifier and set data-api-origin."
        );
      }
      const errBody = await res.json().catch(() => null);
      const detail = errBody && errBody.error ? errBody.error : `HTTP ${res.status}`;
      throw new Error(`Auth failed: ${detail}`);
    }

    const data = await res.json();
    fid = data.fid;
    setText(authStatus, `FID ${fid}`);
    setResult("ok", "Farcaster sign in verified.");
    return true;
  } catch (err) {
    const msg = errorMessage(err);
    setText(authStatus, "Not signed in");
    if (msg.toLowerCase().includes("fetch")) {
      setResult(
        "error",
        "Auth server not reachable. Set data-api-origin in index.html."
      );
    } else {
      setResult("error", msg);
    }
    return false;
  } finally {
    setBusy(authButton, false);
  }
}

async function handleConnectWallet() {
  setBusy(walletButton, true);
  setResult("idle", "Connecting wallet...");

  try {
    const activeProvider = await getProvider();
    await ensureBaseChain(activeProvider);
    const accounts = await activeProvider.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) {
      throw new Error("No account returned");
    }
    address = accounts[0];
    setText(walletStatus, formatAddress(address));
    setResult("ok", "Wallet connected.");
  } catch (err) {
    setText(walletStatus, "Not connected");
    setResult("error", errorMessage(err));
  } finally {
    setBusy(walletButton, false);
  }
}

async function handleCheckOwnership() {
  setBusy(checkButton, true);
  setResult("idle", "Verifying holder status...");

  try {
    const activeProvider = await getProvider();
    if (!fid) {
      const signedIn = await handleSignIn();
      if (!signedIn) {
        return;
      }
    }
    if (!address) {
      await handleConnectWallet();
    }
    if (!address) {
      throw new Error("Connect a wallet first");
    }

    await ensureBaseChain(activeProvider);
    const data = encodeBalanceOf(address);
    const result = await activeProvider.request({
      method: "eth_call",
      params: [{ to: CONTRACT, data }, "latest"],
    });

    const balance = parseHexToBigInt(result);
    setText(dogsStatus, balance.toString());
    if (balance > 0n) {
      setResult("ok", `Wallet holds ${balance} Degen Dogs.`);
    } else {
      setResult("warn", "No Degen Dogs found for this wallet.");
    }
  } catch (err) {
    setResult("error", errorMessage(err));
  } finally {
    setBusy(checkButton, false);
  }
}

async function init() {
  authButton.addEventListener("click", handleSignIn);
  walletButton.addEventListener("click", handleConnectWallet);
  checkButton.addEventListener("click", handleCheckOwnership);

  if (!apiOrigin && isStaticHosting) {
    setResult(
      "warn",
      "Auth server not configured. Set data-api-origin or host the verifier."
    );
  }

  try {
    await sdk.actions.ready();
  } catch (err) {
    setResult("warn", "Not running inside a Farcaster host.");
  }
}

init();
