import { sdk } from "https://esm.sh/@farcaster/miniapp-sdk";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  getFirestore,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";

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
  authButton.textContent?.trim() || "Sign in & verify";
const walletButton = byId("wallet-btn") as HTMLButtonElement;
const walletButtonLabel =
  walletButton.textContent?.trim() || "Connect wallet";
const postsPanel = byId("posts-panel");
const postsStatus = byId("posts-status");
const postsList = byId("posts-list");
const postsEmpty = byId("posts-empty");
const postForm = byId("post-form") as HTMLFormElement;
const postTitle = byId("post-title") as HTMLInputElement;
const postBody = byId("post-body") as HTMLTextAreaElement;
const postSubmit = byId("post-submit") as HTMLButtonElement;
const refreshPostsButton = byId("refresh-posts") as HTMLButtonElement;
const debugPanel = document.getElementById("debug-panel");
const debugLog = document.getElementById("debug-log");
const debugApi = document.getElementById("debug-api");
const debugMode = document.getElementById("debug-mode");
const debugVersion = document.getElementById("debug-version");
const debugLines: string[] = [];

let provider: EthereumProvider | null = null;
let address: string | null = null;
let fid: number | null = null;
let userProfile: { username?: string; displayName?: string } | null = null;
let verifiedAddresses: string[] = [];
let hasSignedIn = false;
let sdkReady = false;
let isMiniApp = false;
let supportsWallet = false;
let signInInProgress = false;
let profileHoldings: { total: bigint; checked: number; failed: number } | null =
  null;
let walletHoldings: bigint | null = null;
let isHolder = false;
let firestoreDb: any = null;
let firestoreReady = false;
let firestoreInitInProgress = false;
let firebaseAuth: any = null;
let firebaseUser: { uid: string } | null = null;
let firebaseAuthReady = false;
let firebaseAuthError = false;

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

function profileSummaryForWalletResult(summary: {
  total: bigint;
  checked: number;
  failed: number;
}) {
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

function normalizeFirebaseConfig(raw: Record<string, unknown>) {
  const apiKey =
    typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const authDomain =
    typeof raw.authDomain === "string" ? raw.authDomain.trim() : "";
  const projectId =
    typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  const appId =
    typeof raw.appId === "string" ? raw.appId.trim() : "";
  const messagingSenderId =
    typeof raw.messagingSenderId === "string"
      ? raw.messagingSenderId.trim()
      : "";
  const storageBucket =
    typeof raw.storageBucket === "string" ? raw.storageBucket.trim() : "";

  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }

  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    messagingSenderId: messagingSenderId || undefined,
    storageBucket: storageBucket || undefined,
  };
}

function getFirebaseConfig() {
  const globalConfig = (window as typeof window & {
    FIREBASE_CONFIG?: Record<string, unknown>;
  }).FIREBASE_CONFIG;
  if (globalConfig && typeof globalConfig === "object") {
    const normalized = normalizeFirebaseConfig(globalConfig);
    if (normalized) {
      return normalized;
    }
  }

  const dataset = document.body.dataset;
  const raw = {
    apiKey: dataset.firebaseApiKey,
    authDomain: dataset.firebaseAuthDomain,
    projectId: dataset.firebaseProjectId,
    appId: dataset.firebaseAppId,
    messagingSenderId: dataset.firebaseMessagingSenderId,
    storageBucket: dataset.firebaseStorageBucket,
  };
  return normalizeFirebaseConfig(raw);
}

async function loadFirebaseConfig() {
  const config = getFirebaseConfig();
  if (config) {
    return config;
  }

  try {
    const res = await fetch("/__/firebase/init.json");
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    return normalizeFirebaseConfig(json);
  } catch (err) {
    logDebug("Firebase init.json unavailable", errorMessage(err));
    return null;
  }
}

function setPostsStatus(state: string, text: string) {
  postsStatus.dataset.state = state;
  postsStatus.textContent = text;
}

function updateHolderState() {
  const profileTotal = profileHoldings?.total ?? 0n;
  const walletTotal = walletHoldings ?? 0n;
  isHolder = profileTotal > 0n || walletTotal > 0n;
  updatePostFormState();
}

function updatePostFormState() {
  const canWrite = firestoreReady && !!firebaseUser && hasSignedIn && isHolder;
  postSubmit.disabled = !canWrite;
  postTitle.disabled = !firestoreReady;
  postBody.disabled = !firestoreReady;
  refreshPostsButton.disabled = !firestoreReady;
  if (!firestoreReady) {
    const status = firestoreInitInProgress ? "idle" : "warn";
    const message = firestoreInitInProgress
      ? "Connecting to Firebase..."
      : "Firestore is not configured yet.";
    setPostsStatus(status, message);
    postsPanel.dataset.state = "disabled";
    return;
  }
  postsPanel.dataset.state = canWrite ? "ready" : "readonly";
  if (firebaseAuthError) {
    setPostsStatus("error", "Firebase auth failed to initialize.");
    return;
  }
  if (!firebaseUser) {
    const message = firebaseAuthReady
      ? "Firebase auth not ready. Enable anonymous auth in Firebase."
      : "Connecting to Firebase...";
    setPostsStatus("warn", message);
    return;
  }
  if (!hasSignedIn) {
    setPostsStatus("warn", "Sign in to create posts and vote.");
    return;
  }
  if (!isHolder) {
    setPostsStatus(
      "warn",
      "Only Degen Dogs holders can create posts or vote.",
    );
    return;
  }
  setPostsStatus("ok", "Ready to post and vote.");
}

function formatPostDate(value: unknown) {
  if (!value) {
    return "Just now";
  }
  const asAny = value as { toDate?: () => Date };
  if (typeof asAny.toDate === "function") {
    return asAny.toDate().toLocaleString();
  }
  if (value instanceof Date) {
    return value.toLocaleString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
  }
  return "Just now";
}

function renderPosts(posts: Array<Record<string, unknown>>) {
  postsList.innerHTML = "";
  if (!posts.length) {
    postsEmpty.hidden = false;
    return;
  }
  postsEmpty.hidden = true;
  for (const post of posts) {
    const card = document.createElement("article");
    card.className = "post-card";

    const header = document.createElement("div");
    header.className = "post-header";

    const title = document.createElement("h3");
    title.textContent = String(post.title || "Untitled");

    const meta = document.createElement("div");
    meta.className = "post-meta";
    const author = post.displayName || post.username || post.fid || "Unknown";
    meta.textContent = `${author} - ${formatPostDate(post.createdAt)}`;

    header.appendChild(title);
    header.appendChild(meta);

    const body = document.createElement("p");
    body.className = "post-body";
    body.textContent = String(post.body || "");

    const actions = document.createElement("div");
    actions.className = "post-actions";
    const voteButton = document.createElement("button");
    voteButton.type = "button";
    voteButton.textContent = "Vote";
    voteButton.disabled =
      !firestoreReady || !firebaseUser || !hasSignedIn || !isHolder;
    const voteCount = document.createElement("span");
    voteCount.className = "vote-count";
    const countValue =
      typeof post.voteCount === "number" ? post.voteCount : 0;
    voteCount.textContent = `${countValue} votes`;

    voteButton.addEventListener("click", () => {
      void voteOnPost(String(post.id), voteButton, voteCount);
    });

    actions.appendChild(voteButton);
    actions.appendChild(voteCount);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(actions);
    postsList.appendChild(card);
  }
}

async function loadPosts() {
  if (!firestoreDb) {
    return;
  }
  setPostsStatus("idle", "Loading posts...");
  try {
    const postsRef = collection(firestoreDb, "posts");
    const q = query(postsRef, orderBy("createdAt", "desc"), limit(25));
    const snapshot = await getDocs(q);
    const posts = snapshot.docs.map((docSnap: any) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    renderPosts(posts);
    if (!posts.length) {
      setPostsStatus("idle", "No posts yet. Create the first one.");
    }
  } catch (err) {
    logError("Posts: load", err);
    setPostsStatus("error", "Unable to load posts right now.");
  }
}

async function createPost() {
  if (!firestoreDb) {
    setPostsStatus("warn", "Firestore is not configured yet.");
    return;
  }
  if (!firebaseUser) {
    setPostsStatus("warn", "Firebase auth not ready yet.");
    return;
  }
  if (!hasSignedIn) {
    setPostsStatus("warn", "Sign in to create a post.");
    return;
  }
  if (!isHolder) {
    setPostsStatus("warn", "Only holders can create posts.");
    return;
  }
  if (!fid) {
    setPostsStatus("warn", "Unable to determine your Farcaster ID.");
    return;
  }
  const uid = firebaseUser.uid;
  const title = postTitle.value.trim();
  const body = postBody.value.trim();
  if (!title || !body) {
    setPostsStatus("warn", "Add a title and description.");
    return;
  }
  if (title.length > 120 || body.length > 1200) {
    setPostsStatus("warn", "Post is too long.");
    return;
  }

  setBusy(postSubmit, true);
  setPostsStatus("idle", "Posting...");
  try {
    const postsRef = collection(firestoreDb, "posts");
    await addDoc(postsRef, {
      title,
      body,
      fid,
      username: userProfile?.username || undefined,
      displayName: userProfile?.displayName || undefined,
      uid,
      createdAt: serverTimestamp(),
      voteCount: 0,
    });
    postTitle.value = "";
    postBody.value = "";
    setPostsStatus("ok", "Post created.");
    await loadPosts();
  } catch (err) {
    logError("Posts: create", err);
    setPostsStatus("error", "Unable to create post.");
  } finally {
    setBusy(postSubmit, false);
  }
}

async function voteOnPost(
  postId: string,
  button: HTMLButtonElement,
  countEl: HTMLElement,
) {
  if (!firestoreDb || !firebaseUser || !fid || !hasSignedIn) {
    setPostsStatus("warn", "Sign in to vote.");
    return;
  }
  if (!isHolder) {
    setPostsStatus("warn", "Only holders can vote.");
    return;
  }

  const uid = firebaseUser.uid;
  button.disabled = true;
  try {
    let didVote = false;
    await runTransaction(firestoreDb, async (tx: any) => {
      const postRef = doc(firestoreDb, "posts", postId);
      const voteRef = doc(firestoreDb, "posts", postId, "votes", uid);
      const voteSnap = await tx.get(voteRef);
      if (voteSnap.exists()) {
        return;
      }
      tx.set(voteRef, {
        fid,
        uid,
        createdAt: serverTimestamp(),
      });
      tx.update(postRef, {
        voteCount: increment(1),
      });
      didVote = true;
    });
    if (didVote) {
      const current = Number(countEl.textContent?.split(" ")[0] || 0);
      countEl.textContent = `${current + 1} votes`;
      setPostsStatus("ok", "Vote recorded.");
    } else {
      setPostsStatus("warn", "You already voted on this post.");
    }
  } catch (err) {
    logError("Posts: vote", err);
    setPostsStatus("error", "Unable to record vote.");
    button.disabled = false;
  }
}

async function initFirestore() {
  if (firestoreDb || firestoreInitInProgress) {
    return firestoreDb;
  }
  firestoreInitInProgress = true;
  updatePostFormState();
  const config = await loadFirebaseConfig();
  if (!config) {
    firestoreInitInProgress = false;
    setPostsStatus(
      "warn",
      "Firestore is not configured yet. Add Firebase config values.",
    );
    postsPanel.dataset.state = "disabled";
    return null;
  }

  try {
    const app = initializeApp(config);
    firestoreDb = getFirestore(app);
    firestoreReady = true;
    firestoreInitInProgress = false;
    updatePostFormState();
    void initFirebaseAuth(app);
    return firestoreDb;
  } catch (err) {
    firestoreInitInProgress = false;
    logError("Firestore init", err);
    setPostsStatus("error", "Firestore failed to initialize.");
    return null;
  }
}

async function initFirebaseAuth(app: unknown) {
  if (firebaseAuth) {
    return firebaseAuth;
  }
  try {
    firebaseAuth = getAuth(app);
    firebaseAuthReady = true;
    onAuthStateChanged(firebaseAuth, (user: any) => {
      firebaseUser = user ? { uid: user.uid } : null;
      updatePostFormState();
    });
    if (!firebaseAuth.currentUser) {
      await signInAnonymously(firebaseAuth);
    } else {
      firebaseUser = { uid: firebaseAuth.currentUser.uid };
      updatePostFormState();
    }
  } catch (err) {
    firebaseAuthError = true;
    logError("Firebase auth", err);
    setPostsStatus("error", "Firebase auth failed to initialize.");
    updatePostFormState();
  }
  return firebaseAuth;
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

function isUserRejected(err: unknown) {
  const message = errorMessage(err).toLowerCase();
  const code =
    err && typeof err === "object"
      ? (err as { code?: number | string }).code
      : undefined;
  return (
    code === 4001 ||
    code === "4001" ||
    code === "ACTION_REJECTED" ||
    message.includes("user rejected")
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

async function requestAccounts(
  activeProvider: EthereumProvider,
  allowPrompt = true,
) {
  const methods = allowPrompt
    ? ["eth_accounts", "eth_requestAccounts"]
    : ["eth_accounts"];

  for (const method of methods) {
    try {
      const accounts = (await activeProvider.request({
        method,
      })) as string[];
      if (accounts?.length) {
        return accounts;
      }
    } catch (err) {
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
    setResult(
      "warn",
      "No verified addresses on your Farcaster profile. Connect a wallet to check holdings.",
    );
    profileHoldings = { total: 0n, checked: 0, failed: 0 };
    updateHolderState();
    return profileHoldings;
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
    profileHoldings = null;
    updateHolderState();
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

  profileHoldings = { total, checked, failed };
  updateHolderState();
  return profileHoldings;
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
      } else if (isMethodUnsupported(err) || isUserRejected(err)) {
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

type WalletCheckOptions = {
  allowPrompt?: boolean;
  silent?: boolean;
};

type SignInOptions = {
  auto?: boolean;
};

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

async function handleSignIn(options: SignInOptions = {}) {
  if (signInInProgress) {
    return false;
  }
  signInInProgress = true;
  const { auto = false } = options;
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
    userProfile = {
      username: data.username,
      displayName: data.displayName,
    };
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
    let autoChecked = false;
    if (sdkReady && supportsWallet) {
      setButtonLabel(walletButton, "Connecting wallet...");
      autoChecked = await connectWalletAndCheck({
        allowPrompt: false,
        silent: true,
      });
    }
    setBusy(walletButton, false);
    walletButton.disabled = !supportsWallet;
    setButtonLabel(
      walletButton,
      autoChecked ? "Recheck wallet" : supportsWallet ? walletButtonLabel : "Wallet unavailable",
    );
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
    setBusy(walletButton, false);
    walletButton.disabled = true;
    setButtonLabel(walletButton, walletButtonLabel);
  } finally {
    hasSignedIn = signedIn;
    setBusy(authButton, false);
    setButtonLabel(
      authButton,
      hasSignedIn ? "Recheck profile" : authButtonLabel,
    );
    signInInProgress = false;
    updatePostFormState();
    if (auto && !signedIn) {
      logDebug("Auth: auto sign-in failed");
    }
  }
  return signedIn;
}

async function handleWalletCheck() {
  if (!hasSignedIn) {
    setResult("warn", "Sign in first to verify your profile.");
    return false;
  }
  if (!supportsWallet) {
    setResult("warn", "Wallet access is not available in this host.");
    return false;
  }

  setBusy(walletButton, true);
  setButtonLabel(walletButton, "Checking wallet...");
  const checked = await connectWalletAndCheck({ allowPrompt: true, silent: false });
  setBusy(walletButton, false);
  setButtonLabel(walletButton, checked ? "Recheck wallet" : walletButtonLabel);
  return checked;
}

async function connectWalletAndCheck(options: WalletCheckOptions = {}) {
  const { allowPrompt = true, silent = false } = options;
  const snapshot = silent
    ? {
        wallet: walletStatus.textContent || "",
        chain: chainStatus.textContent || "",
        dogs: dogsStatus.textContent || "",
        result: resultBox.textContent || "",
        state: resultBox.dataset.state || "idle",
      }
    : null;
  const restoreSnapshot = () => {
    if (!snapshot) {
      return;
    }
    setText(walletStatus, snapshot.wallet);
    setText(chainStatus, snapshot.chain);
    setText(dogsStatus, snapshot.dogs);
    setResult(snapshot.state, snapshot.result);
  };
  if (!silent) {
    setResult("idle", "Connecting Farcaster wallet...");
    setText(walletStatus, "Connecting...");
    setText(dogsStatus, "Checking...");
  }

  let activeProvider: EthereumProvider;
  try {
    activeProvider = await getProvider();
  } catch (err) {
    logError("Wallet provider", err);
    if (silent) {
      restoreSnapshot();
      return false;
    }
    setText(walletStatus, "Not connected");
    setText(chainStatus, "Unknown");
    setText(dogsStatus, "Unchecked");
    if (!silent) {
      setResult(
        "warn",
        "Wallet provider not available. Open this mini app inside Farcaster to connect a wallet.",
      );
    }
    return false;
  }

  try {
    logDebug("Wallet: provider ready");
    const accounts = await requestAccounts(activeProvider, allowPrompt);
    if (!accounts?.length) {
      if (silent) {
        restoreSnapshot();
      } else {
        setText(walletStatus, "Not connected");
        setText(dogsStatus, "Unchecked");
        setResult(
          "warn",
          "Wallet not connected. Tap Connect wallet to retry.",
        );
      }
      return false;
    }

    const { chainId } = await ensureBaseChain(activeProvider, false);

    address = accounts[0];
    setText(walletStatus, formatAddress(address));
    logDebug("Wallet: account", formatAddress(address));

    if (!silent) {
      setResult("idle", "Checking Degen Dogs ownership...");
    }
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
    walletHoldings = balance;
    updateHolderState();
    const normalizedAddress = address.toLowerCase();
    const hasVerifiedMatch = verifiedAddresses.some(
      (addr) => addr.toLowerCase() === normalizedAddress,
    );
    const verificationNote =
      verifiedAddresses.length && !hasVerifiedMatch
        ? " Wallet not linked to your Farcaster profile."
        : "";

    if (silent && profileHoldings) {
      const profileNote = profileSummaryForWalletResult(profileHoldings);
      const walletNote = `Connected wallet holds ${balance} Degen Dogs.`;
      const combinedStatus =
        balance > 0n || profileHoldings.total > 0n ? "ok" : "warn";
      setResult(
        combinedStatus,
        `${profileNote} ${walletNote}${verificationNote}${chainNote}${rpcNote}`,
      );
      return true;
    }

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
    return true;
  } catch (err) {
    if (silent) {
      restoreSnapshot();
      return false;
    }
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
  authButton.addEventListener("click", () => {
    void handleSignIn({ auto: false });
  });
  walletButton.addEventListener("click", handleWalletCheck);
  walletButton.disabled = true;
  postForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createPost();
  });
  refreshPostsButton.addEventListener("click", () => {
    void loadPosts();
  });
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
    isMiniApp = await sdk.isInMiniApp();
  } catch (err) {
    logError("SDK isInMiniApp", err);
  }

  if (!isMiniApp) {
    sdkReady = false;
    supportsWallet = false;
    setResult("warn", "Not running inside a Farcaster host.");
  } else {
    try {
      await sdk.actions.ready();
      sdkReady = true;
      logDebug("SDK ready");
      try {
        const capabilities = await sdk.getCapabilities();
        supportsWallet = capabilities.includes("wallet.getEthereumProvider");
        logDebug("SDK capabilities", {
          supportsWallet,
          count: capabilities.length,
        });
      } catch (err) {
        logError("SDK capabilities", err);
        supportsWallet = false;
      }

      if (debugEnabled) {
        try {
          const context = await sdk.context;
          logDebug("SDK context", context);
        } catch (err) {
          logError("SDK context", err);
        }
      }

      void handleSignIn({ auto: true });
    } catch (err) {
      sdkReady = false;
      supportsWallet = false;
      logError("SDK ready", err);
      setResult("warn", "Not running inside a Farcaster host.");
    }
  }

  void initFirestore().then(() => {
    void loadPosts();
  });
  updatePostFormState();
}

init();
