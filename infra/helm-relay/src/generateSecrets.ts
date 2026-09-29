// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

// Prints the relay's own secrets as Railway variables, generated the way
// Alchemy generates them for the Worker (an ed25519 PEM pair and 32 random
// bytes). PEM newlines are escaped so each value fits on one line.
// Generate once: a new mint key invalidates every token the relay has issued.

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const oneLine = (pem: string) => pem.trim().replaceAll("\n", "\\n");

process.stdout.write(
  [
    `RELAY_MINT_PRIVATE_KEY=${oneLine(privateKey)}`,
    `RELAY_MINT_PUBLIC_KEY=${oneLine(publicKey)}`,
    `RELAY_JOB_SIGNING_SECRET=${NodeCrypto.randomBytes(32).toString("hex")}`,
    "",
  ].join("\n"),
);
