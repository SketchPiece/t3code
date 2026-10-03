import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

// Helm fork: signs the packed Helm.app with the developer's own Apple
// Development certificate (HELM_MAC_SIGN_IDENTITY, e.g. "Apple Development:
// Name (ID)") before electron-builder makes the DMG. Not notarized: this is for
// the developer's own Macs. A stable signature lets macOS keep "Always Allow"
// for Helm's keychain item across rebuilds, which an ad-hoc signature cannot.
// electron-builder itself only picks Developer ID certificates outside the
// Mac App Store, so it stays unsigned and this afterPack hook does the work.
export default async function signHelmLocally(context: {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}): Promise<void> {
  const identity = process.env.HELM_MAC_SIGN_IDENTITY?.trim();
  if (!identity || context.electronPlatformName !== "darwin") return;
  const appPath = NodePath.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  NodeChildProcess.execFileSync(
    "codesign",
    ["--force", "--deep", "--timestamp=none", "--sign", identity, appPath],
    { stdio: "inherit" },
  );
  NodeChildProcess.execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
}
