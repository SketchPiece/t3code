import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

// Helm fork: asks the owner whether a phone on their tailnet may pair (server
// side: apps/server/src/helm/tailnetPairRoute.ts). Long-polls the local
// server while Helm is open; a request the owner never answers expires there
// after five minutes. Raises a system notification when Helm is in the back.
// A device on the local network gets a code instead of the credential: after
// "Allow" the dialog shows it until the device sends it back.

interface PairRequest {
  readonly id: string;
  readonly label: string;
  readonly nodeName: string;
  readonly address: string;
  /** Asked from the local network, not the tailnet: allowing shows a code. */
  readonly needsCode?: boolean;
}

interface ShownCode {
  readonly id: string;
  readonly label: string;
  readonly address: string;
  readonly code: string;
}

const REQUESTS_PATH = "/api/helm/tailnet-pair-requests";
const RETRY_MS = 15_000;

async function primaryFetch(path: string, init: RequestInit = {}, query?: Record<string, string>) {
  const url = resolvePrimaryEnvironmentHttpUrl(path, query);
  const token = await readDesktopPrimaryBearerToken();
  return fetch(url, {
    ...init,
    ...(token
      ? { credentials: "omit", headers: { ...init.headers, Authorization: `Bearer ${token}` } }
      : { credentials: "include" }),
  });
}

function notify(request: PairRequest) {
  if (document.hasFocus() || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    const notification = new Notification("A device wants to connect", {
      body: request.needsCode
        ? `${request.label} (${request.address}) on your local network`
        : `${request.label} (${request.nodeName}) on your tailnet`,
      tag: `helm-pair-${request.id}`,
    });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
    });
  } catch {
    // The dialog is still there when Helm comes forward.
  }
}

export function TailnetPairPrompt() {
  const [requests, setRequests] = useState<ReadonlyArray<PairRequest>>([]);
  const [codes, setCodes] = useState<ReadonlyArray<ShownCode>>([]);
  const [answering, setAnswering] = useState(false);
  const notified = useRef(new Set<string>());

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async (after: number | null) => {
      try {
        const response = await primaryFetch(
          REQUESTS_PATH,
          { signal: controller.signal },
          after === null ? undefined : { after: String(after) },
        );
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as {
          version: number;
          requests: ReadonlyArray<PairRequest>;
          codes?: ReadonlyArray<ShownCode>;
        };
        if (stopped) return;
        setRequests(body.requests);
        setCodes(body.codes ?? []);
        for (const request of body.requests) {
          if (notified.current.has(request.id)) continue;
          notified.current.add(request.id);
          notify(request);
        }
        void poll(body.version);
      } catch {
        // Server restarting or not a Helm server: try again later.
        if (!stopped) retry = setTimeout(() => void poll(null), RETRY_MS);
      }
    };
    void poll(null);
    return () => {
      stopped = true;
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, []);

  // A code on screen comes first: someone is typing it on their device right now.
  const shown = codes[0];
  const current = shown ? undefined : requests[0];
  const answer = async (id: string, approve: boolean) => {
    setAnswering(true);
    try {
      const response = await primaryFetch(REQUESTS_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, approve }),
      });
      const answered = (await response.json().catch(() => ({}))) as { code?: string };
      const request = requests.find((item) => item.id === id);
      setRequests((list) => list.filter((item) => item.id !== id));
      setCodes((list) =>
        approve && answered.code && request
          ? [...list, { id, label: request.label, address: request.address, code: answered.code }]
          : list.filter((item) => item.id !== id),
      );
    } finally {
      setAnswering(false);
    }
  };

  if (shown) {
    return (
      <AlertDialog open>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Enter this code on {shown.label}</AlertDialogTitle>
            <AlertDialogDescription>
              Type it in Helm on the device ({shown.address}) to finish connecting. This closes by
              itself once it's in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2 text-center font-mono text-5xl font-semibold tracking-[0.3em] tabular-nums">
            {shown.code}
          </div>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={answering}
              onClick={() => void answer(shown.id, false)}
            >
              Cancel
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open={current !== undefined}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Connect {current?.label ?? "a device"} to Helm?</AlertDialogTitle>
          <AlertDialogDescription>
            {current?.needsCode
              ? `A device at ${current.address} on your local network asks to pair with Helm. If you allow it, Helm shows a code to type on that device.`
              : `${current?.nodeName} (${current?.address}) on your tailnet asks to pair with Helm.`}{" "}
            Allow it only if this is your device: it will be able to run and control your agents.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="outline"
            disabled={answering}
            onClick={() => current && void answer(current.id, false)}
          >
            Deny
          </Button>
          <Button disabled={answering} onClick={() => current && void answer(current.id, true)}>
            Allow
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
