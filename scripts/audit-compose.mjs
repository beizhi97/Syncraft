import { fileURLToPath } from "node:url";
import { auditComposeConfig } from "./lib/composeAudit.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const issues = await auditComposeConfig(root);

if (issues.length) {
  console.error("Compose config audit failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
} else {
  console.log("Compose config audit passed.");
}
