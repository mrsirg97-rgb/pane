import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function paneSetupExtension(_pi: ExtensionAPI) {
  try {
    const source = fileURLToPath(new URL("../themes", import.meta.url));
    const target = join(homedir(), ".pi/agent/themes");
    if (!existsSync(source)) return;
    mkdirSync(target, { recursive: true });
    for (const file of readdirSync(source)) {
      if (!file.endsWith(".json")) continue;
      const destination = join(target, file);
      if (!existsSync(destination)) copyFileSync(join(source, file), destination);
    }
  } catch {
    /* pi runs fine without the themes; never block loading over them */
  }
}
