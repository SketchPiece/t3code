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

interface PairRequest {
  readonly id: string;
  readonly label: string;
  readonly nodeName: string;
  readonly address: string;
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
    const notification = new Notification("A phone wants to connect", {
      body: `${request.label} (${request.nodeName}) on your tailnet`,
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
        };
        if (stopped) return;
        setRequests(body.requests);
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

  const current = requests[0];
  const answer = async (approve: boolean) => {
    if (!current) return;
    setAnswering(true);
    try {
      await primaryFetch(REQUESTS_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: current.id, approve }),
      });
      setRequests((list) => list.filter((request) => request.id !== current.id));
    } finally {
      setAnswering(false);
    }
  };

  return (
    <AlertDialog open={current !== undefined}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Connect {current?.label ?? "a phone"} to Helm?</AlertDialogTitle>
          <AlertDialogDescription>
            {current?.nodeName} ({current?.address}) on your tailnet asks to pair with Helm. Allow
            it only if this is your device: it will be able to run and control your agents.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={answering} onClick={() => void answer(false)}>
            Deny
          </Button>
          <Button disabled={answering} onClick={() => void answer(true)}>
            Allow
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
