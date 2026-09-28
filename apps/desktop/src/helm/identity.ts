// Helm fork: the desktop app's own identity, so Helm installs next to T3 Code
// without sharing its app bundle, data, deep links or update feed. Keep the
// schemes in sync with DESKTOP_RENDERER_ORIGINS in apps/server/src/http.ts.
export const HELM_DESKTOP_IDENTITY = {
  appId: "com.sketchpiece.helm",
  productName: "Helm",
  artifactBaseName: "Helm",
  scheme: "helm",
  developmentScheme: "helm-dev",
  userDataDirName: "helm",
  developmentUserDataDirName: "helm-dev",
  /** The server's home, next to T3 Code's ~/.t3. */
  homeDirName: ".helm",
} as const;
