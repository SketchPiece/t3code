import * as Schema from "effect/Schema";

// Helm fork: the Mac asks Helm Mobile to confirm with Face ID. Two kinds of request:
//
// - "sudo": the pam_helm module (native/helm-auth/pam_helm.c) waits for a signature from the
//   phone's Secure Enclave key over `helm-sudo-v1\n<nonce>\n<user>\n<host>\n<command>`. The Mac
//   checks it against the keys in /etc/helm/sudo-approvers, so only the phone can approve.
// - "prompt": a Touch ID / password sheet is on the Mac's screen (1Password unlocking, an app
//   asking for the login password). The phone answers with a password from its Keychain, sealed
//   to the helper that will type it (P-256 ECDH, HKDF-SHA256, AES-GCM), so the server never
//   sees it.

/** Which of the phone's stored passwords fits a prompt. */
export const HelmAuthSecretKind = Schema.Literals(["mac", "onepassword"]);
export type HelmAuthSecretKind = typeof HelmAuthSecretKind.Type;

export const HelmAuthSudo = Schema.Struct({
  /** Base64, fresh for every sudo call. */
  nonce: Schema.String,
  user: Schema.String,
  host: Schema.String,
  /** The command line sudo was asked to run, as the phone shows it. */
  command: Schema.String,
});
export type HelmAuthSudo = typeof HelmAuthSudo.Type;

export const HelmAuthRequest = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["sudo", "prompt"]),
  /** The asking app: "1Password", "System Settings", or "sudo". */
  app: Schema.String,
  /** The prompt's first line ("1Password is trying to unlock."), or the sudo command. */
  title: Schema.String,
  detail: Schema.String,
  createdAt: Schema.Number,
  /** When the Mac stops waiting (ms since epoch); prompts have none, they last while on screen. */
  expiresAt: Schema.optional(Schema.Number),
  sudo: Schema.optional(HelmAuthSudo),
  /** For a prompt: the stored passwords that can answer it, best first. */
  secretKinds: Schema.Array(HelmAuthSecretKind),
  /** For a prompt: the helper's P-256 key-agreement key (base64 X9.63) to seal the password to. */
  sealingKey: Schema.optional(Schema.String),
});
export type HelmAuthRequest = typeof HelmAuthRequest.Type;

export const HelmAuthSudoSetup = Schema.Struct({
  /** pam_helm is installed and listed in /etc/pam.d/sudo_local. */
  installed: Schema.Boolean,
  /** Public keys (base64 X9.63) in /etc/helm/sudo-approvers. */
  approvers: Schema.Array(Schema.String),
  /** What to run in a terminal on the Mac to install or update (asks for the password once). */
  setupCommand: Schema.String,
});
export type HelmAuthSudoSetup = typeof HelmAuthSudoSetup.Type;

export const HelmAuthOutcome = Schema.Literals(["approved", "denied", "expired", "gone", "failed"]);
export type HelmAuthOutcome = typeof HelmAuthOutcome.Type;

/** What `helm.subscribe` streams for the "auth" topic. */
export const HelmAuthEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    requests: Schema.Array(HelmAuthRequest),
    sudo: HelmAuthSudoSetup,
    /** The helper that watches the screen has Accessibility access. */
    promptsAvailable: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("added"), request: HelmAuthRequest }),
  Schema.Struct({
    type: Schema.Literal("removed"),
    id: Schema.String,
    outcome: HelmAuthOutcome,
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("sudo"), sudo: HelmAuthSudoSetup }),
]);
export type HelmAuthEvent = typeof HelmAuthEvent.Type;

export const HelmAuthSealedSecret = Schema.Struct({
  kind: HelmAuthSecretKind,
  /** The phone's one-off P-256 key (base64 X9.63). */
  ephemeralKey: Schema.String,
  /** AES-GCM combined box (nonce ‖ ciphertext ‖ tag), base64. */
  box: Schema.String,
});
export type HelmAuthSealedSecret = typeof HelmAuthSealedSecret.Type;

export const HelmAuthRespondInput = Schema.Struct({
  id: Schema.String,
  action: Schema.Literals(["approve", "deny"]),
  /** Sudo: DER ECDSA-SHA256 signature, base64. */
  signature: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  /** Prompt: the password to type. */
  secret: Schema.optional(HelmAuthSealedSecret),
});
export type HelmAuthRespondInput = typeof HelmAuthRespondInput.Type;

export const HelmAuthRespondResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
});
export type HelmAuthRespondResult = typeof HelmAuthRespondResult.Type;

export const HelmAuthRegisterApproverInput = Schema.Struct({
  /** The phone's Secure Enclave signing key, base64 X9.63. */
  publicKey: Schema.String.check(Schema.isMaxLength(256)),
  deviceName: Schema.String.check(Schema.isMaxLength(128)),
});
export type HelmAuthRegisterApproverInput = typeof HelmAuthRegisterApproverInput.Type;
