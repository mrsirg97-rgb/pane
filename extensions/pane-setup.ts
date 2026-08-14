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
      if (!existsSync(destination))
        copyFileSync(join(source, file), destination);
    }
  } catch {
    /* pi runs fine without the themes; never block loading over them */
  }
  try {
    // Seed the working contract on fresh machines. Never overwrite: the local
    // copy is the user's live contract; delete it to re-seed from the pack.
    // (Template name keeps the repo copy out of pi's in-repo context discovery.)
    const contract = fileURLToPath(
      new URL("../AGENTS.template.md", import.meta.url),
    );
    const destination = join(homedir(), ".pi/agent/AGENTS.md");
    if (existsSync(contract) && !existsSync(destination))
      copyFileSync(contract, destination);
  } catch {
    /* best-effort, same as themes */
  }
}
