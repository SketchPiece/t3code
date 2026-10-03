import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { toReachableUrl } from "./routing";

// Helm fork: images and attachments are loaded natively from URLs built on the
// prepared connection's httpBaseUrl, so that base is rewritten here too.
export function withTailnetUrls<
  S extends {
    readonly preparedConnectionValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<Option.Option<PreparedConnection>>;
  },
>(session: S): S {
  const preparedConnectionValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.map(get(session.preparedConnectionValueAtom(environmentId)), (prepared) => {
        const httpBaseUrl = toReachableUrl(prepared.httpBaseUrl);
        return httpBaseUrl === prepared.httpBaseUrl ? prepared : { ...prepared, httpBaseUrl };
      }),
    ).pipe(Atom.withLabel(`helm-tailnet-prepared-connection:${environmentId}`)),
  );
  return { ...session, preparedConnectionValueAtom };
}
