import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

// Helm fork: agent notifications and Live Activities go to the Volna core
// (its /helm routes speak the relay's publish API) instead of T3 Connect.
// The secret `helm-push` ({"url": "https://…", "token": "…"}, secrets/helm-push.bin)
// turns publishing on; without it the upstream relay link decides as before.
export const HELM_PUSH_SECRET = "helm-push";

const HelmPushConfig = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)),
  token: Schema.String.check(Schema.isMinLength(1)),
});
const decodeHelmPushConfig = Schema.decodeUnknownOption(Schema.fromJsonString(HelmPushConfig));

export const readHelmPushConfig = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  secrets.get(HELM_PUSH_SECRET).pipe(
    Effect.map((bytes) =>
      Option.isSome(bytes)
        ? Option.getOrNull(decodeHelmPushConfig(new TextDecoder().decode(bytes.value)))
        : null,
    ),
    Effect.map((config) =>
      config ? { url: `${config.url.replace(/\/+$/, "")}/helm`, token: config.token } : null,
    ),
    Effect.orElseSucceed(() => null),
  );
