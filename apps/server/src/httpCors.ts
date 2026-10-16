import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

// Helm fork: Helm's renderer origins (apps/desktop/src/helm/identity.ts).
export const DESKTOP_RENDERER_ORIGINS = [
  "t3code://app",
  "t3code-dev://app",
  "helm://app",
  "helm-dev://app",
] as const;
