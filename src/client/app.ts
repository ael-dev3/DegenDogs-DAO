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
const authButton = byId("auth-btn") as HTMLButtonElement;
const authButtonLabel = authButton.textContent?.trim() || "Sign in & verify";

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

function setButtonLabel(text: string) {
  authButton.textContent = text;
}

function formatAddress(value: string | null) {
  if (!value || value.length < 10) {
    return value || "";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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
  return String(err);
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

async function ensureBaseChain(activeProvider: EthereumProvider) {
  setText(chainStatus, "Switching...");
  let chainId = (await activeProvider.request({ method: "eth_chainId" })) as string;
  if (chainId !== BASE_CHAIN_ID) {
    try {
      await activeProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID }],
      });
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: number | string }).code : null;
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
  chainId = (await activeProvider.request({ method: "eth_chainId" })) as string;
  setText(chainStatus, chainId === BASE_CHAIN_ID ? "Base (0x2105)" : `Chain ${chainId}`);
  return chainId;
}

async function handleSignIn() {
  setBusy(authButton, true);
  setButtonLabel("Signing in...");
  setResult("idle", "Requesting Farcaster sign in...");
  setText(authStatus, "Signing in...");

  let signedIn = false;
  try {
    // Quick Auth triggers Farcaster sign-in if needed.
    const res = await sdk.quickAuth.fetch(`${apiBase}/api/verify`);

    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error(
          "Auth endpoint not found. Deploy the verifier and set data-api-origin.",
        );
      }
      const errBody = await res.json().catch(() => null);
      const detail = errBody && errBody.error ? errBody.error : `HTTP ${res.status}`;
      throw new Error(`Auth failed: ${detail}`);
    }

    const data = (await res.json()) as VerifyResponse;
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
    signedIn = true;
  } catch (err) {
    const msg = errorMessage(err);
    setText(authStatus, "Not signed in");
    if (msg.toLowerCase().includes("fetch")) {
      setResult(
        "error",
        "Auth server not reachable. Set data-api-origin in index.html.",
      );
    } else {
      setResult("error", msg);
    }
  }

  hasSignedIn = signedIn;
  if (signedIn) {
    try {
      await connectWalletAndCheck();
    } catch (err) {
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
    await ensureBaseChain(activeProvider);

    const accounts = (await activeProvider.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts || !accounts.length) {
      throw new Error("No account returned");
    }

    address = accounts[0];
    setText(walletStatus, formatAddress(address));

    setButtonLabel("Checking holdings...");
    setResult("idle", "Checking Degen Dogs ownership...");
    const data = encodeBalanceOf(address);
    const result = (await activeProvider.request({
      method: "eth_call",
      params: [{ to: CONTRACT, data }, "latest"],
    })) as string;

    const balance = parseHexToBigInt(result);
    setText(dogsStatus, balance.toString());
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
        `Holder verified with ${balance} Degen Dogs.${verificationNote}`,
      );
    } else {
      setResult("warn", `No Degen Dogs found for this wallet.${verificationNote}`);
    }
  } catch (err) {
    setText(walletStatus, "Not connected");
    setText(chainStatus, "Unknown");
    setText(dogsStatus, "Unchecked");
    throw err;
  }
}

async function init() {
  authButton.addEventListener("click", handleSignIn);

  if (!apiOrigin && isStaticHosting) {
    setResult(
      "warn",
      "Auth server not configured. Set data-api-origin or host the verifier.",
    );
  }

  try {
    await sdk.actions.ready();
  } catch (err) {
    setResult("warn", "Not running inside a Farcaster host.");
  }
}

init();
