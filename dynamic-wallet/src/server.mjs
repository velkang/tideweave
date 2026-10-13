import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DynamicEvmWalletClient } from "@dynamic-labs-wallet/node-evm";
import { getAddress, isAddress } from "viem";
import { createDynamicSession } from "./session.mjs";
import { parseUnsignedTransaction, signedMismatches } from "./transactions.mjs";

const required = ["DYNAMIC_ENV_ID", "DYNAMIC_AUTH_TOKEN", "DYNAMIC_SIGNER_SHARED_SECRET", "DYNAMIC_WALLET_DATA_DIR", "DYNAMIC_WALLET_ENCRYPTION_KEY"];
for (const name of required) if (!process.env[name]) throw new Error(`${name}_REQUIRED`);
const secret = process.env.DYNAMIC_SIGNER_SHARED_SECRET;
if (secret.length < 32) throw new Error("DYNAMIC_SIGNER_SHARED_SECRET_TOO_SHORT");
const encryptionKey = Buffer.from(process.env.DYNAMIC_WALLET_ENCRYPTION_KEY, "hex");
if (encryptionKey.length !== 32) throw new Error("DYNAMIC_WALLET_ENCRYPTION_KEY_INVALID");
const dataDir = process.env.DYNAMIC_WALLET_DATA_DIR;
const walletDir = join(dataDir, "wallets");
const nonceDir = join(dataDir, "nonces");
await Promise.all([mkdir(walletDir, { recursive: true, mode: 0o700 }), mkdir(nonceDir, { recursive: true, mode: 0o700 })]);

const client = new DynamicEvmWalletClient({ environmentId: process.env.DYNAMIC_ENV_ID });
// Dynamic's login expires; log in again every ten minutes, or sooner if Dynamic answers 401.
const dynamic = createDynamicSession({ login: () => client.authenticateApiToken(process.env.DYNAMIC_AUTH_TOKEN),
  maxAgeMs: 10 * 60_000 });
try {
  await dynamic.run(async () => undefined);
} catch {
  // SDK errors may include request headers containing the API token.
  console.error("Dynamic service startup authentication failed");
  process.exit(1);
}
const pending = new Set();
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const walletPath = id => join(walletDir, `${createHash("sha256").update(id).digest("hex")}.json`);

function seal(id, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") });
}

function unseal(id, text) {
  const stored = JSON.parse(text);
  if (stored.version !== 1) throw new Error("WALLET_VERSION_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(stored.iv, "hex"));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(Buffer.from(stored.tag, "hex"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "hex")), decipher.final()]).toString("utf8"));
}

async function loadWallet(id) {
  try { return unseal(id, await readFile(walletPath(id), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function saveWallet(id, wallet) {
  const path = walletPath(id);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(seal(id, wallet)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(walletDir, "r");
  try { await directory.sync(); }
  finally { await directory.close(); }
}

async function cleanExpiredNonces() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const name of await readdir(nonceDir)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const path = join(nonceDir, name);
    try { if ((await stat(path)).mtimeMs < cutoff) await unlink(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
await cleanExpiredNonces();
setInterval(() => cleanExpiredNonces().catch(() => console.error("Nonce cleanup failed")), 60 * 60_000).unref();

async function authenticate(request, path, body) {
  const timestamp = request.headers["x-tideweave-timestamp"];
  const nonce = request.headers["x-tideweave-nonce"];
  const signature = request.headers["x-tideweave-signature"];
  if (typeof timestamp !== "string" || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300_000) return false;
  if (typeof nonce !== "string" || !/^[0-9a-f-]{36}$/.test(nonce) || typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${nonce}\n${path}\n${body}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return false;
  const noncePath = join(nonceDir, createHash("sha256").update(nonce).digest("hex"));
  try { const file = await open(noncePath, "wx", 0o600); await file.close(); return true; }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
}

async function handle(path, payload) {
  if (path === "/v1/wallets/provision") {
    if (!validId(payload?.userId)) return [400, { error: "INVALID_REQUEST" }];
    const userId = payload.userId;
    if (pending.has(userId)) return [409, { error: "PROVISION_IN_PROGRESS" }];
    pending.add(userId);
    try {
      let wallet = await loadWallet(userId);
      if (!wallet) {
        const created = await dynamic.run(() => client.createWalletAccount({ thresholdSignatureScheme: "TWO_OF_TWO" }));
        if (!isAddress(created.walletMetadata?.accountAddress)) throw new Error("DYNAMIC_ADDRESS_INVALID");
        wallet = { userId, walletMetadata: created.walletMetadata, externalServerKeyShares: created.externalServerKeyShares };
        await saveWallet(userId, wallet);
      }
      return [200, { dynamicWalletId: userId, address: getAddress(wallet.walletMetadata.accountAddress) }];
    } finally { pending.delete(userId); }
  }
  if (path === "/v1/transactions/sign") {
    if (!validId(payload?.dynamicWalletId)) return [400, { error: "INVALID_REQUEST" }];
    let transaction;
    try { transaction = parseUnsignedTransaction(payload.transaction); }
    catch { return [400, { error: "INVALID_TRANSACTION" }]; }
    const wallet = await loadWallet(payload.dynamicWalletId);
    if (!wallet) return [404, { error: "WALLET_NOT_FOUND" }];
    const keys = { walletMetadata: wallet.walletMetadata, externalServerKeyShares: wallet.externalServerKeyShares };
    const signedTransaction = await dynamic.run(async () => {
      // A type-4 request carries its one allowed authorization unsigned; it is signed here.
      const authorizationList = transaction.type === "eip7702"
        ? await Promise.all(transaction.authorizationList.map(async (authorization) => ({ ...authorization,
          ...(await client.signAuthorization({ ...keys, authorization })) })))
        : undefined;
      return client.signTransaction({ ...keys,
        transaction: authorizationList ? { ...transaction, authorizationList } : transaction });
    });
    const mismatches = await signedMismatches(signedTransaction, transaction, wallet.walletMetadata.accountAddress);
    if (mismatches.length) throw new Error(`SIGNED_TRANSACTION_MISMATCH:${mismatches.join(",")}`);
    return [200, { signedTransaction }];
  }
  return [404, { error: "NOT_FOUND" }];
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (request.method !== "POST" || !["/v1/wallets/provision", "/v1/transactions/sign"].includes(path)) {
    response.writeHead(404).end(); return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (!await authenticate(request, path, body)) { response.writeHead(401).end(); return; }
    let payload;
    try { payload = JSON.parse(body); }
    catch { response.writeHead(400).end(); return; }
    const [status, result] = await handle(path, payload);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    const safeMessage = error instanceof Error
      ? error.message.replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]").slice(0, 200)
      : "unknown";
    console.error("Dynamic service request failed", safeMessage);
    response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "INTERNAL_ERROR" }));
  }
});
// Railway needs every interface; local runs set HOST=127.0.0.1.
server.listen(Number(process.env.PORT || 3000), process.env.HOST || "0.0.0.0");
