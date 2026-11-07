// Creates the release signing key pair (ed25519):
//   private key -> .keys/update-signing-key.pem  (git-ignored: put it into the GitHub secret UNI_GIT_SIGNING_KEY and
//                                                 keep a copy in a password manager)
//   public key  -> backend/src/update-key.ts      (committed: installed copies accept only releases signed by the pair)
// A new key means installed copies refuse every later update until they are reinstalled, so an existing key is kept
// unless --force is given.
//   node tools/release/keygen.mjs [--force]
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const privFile = resolve(root, ".keys/update-signing-key.pem");
const pubFile = resolve(root, "backend/src/update-key.ts");

if (existsSync(privFile) && !process.argv.includes("--force")) {
  console.error(`${privFile} exists; installed copies trust it. Use --force to replace it anyway.`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(privFile), { recursive: true });
writeFileSync(privFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
writeFileSync(
  pubFile,
  `/**\n * Public half of the release signing key (tools/release/keygen.mjs). The updater installs only releases whose\n * latest.json is signed with the private half, which lives in the GitHub secret UNI_GIT_SIGNING_KEY.\n */\nexport const UPDATE_PUBLIC_KEY = "${spki}";\n`,
);
console.log(`private key: ${privFile}\npublic key:  ${pubFile}\n${spki}`);
