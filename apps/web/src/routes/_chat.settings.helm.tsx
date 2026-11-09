import { createFileRoute } from "@tanstack/react-router";
import { HelmSettingsPanel } from "../helm/HelmSettingsPanel";

// Helm fork: Settings → Helm.
export const Route = createFileRoute("/_chat/settings/helm")({ component: HelmSettingsPanel });
