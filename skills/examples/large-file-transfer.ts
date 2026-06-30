import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";

const apiKey = process.env.ENVOQ_API_KEY;
const baseUrl = process.env.ENVOQ_BASE_URL || "https://api.envoq.tech/api/v1";
const recipientId = process.env.ENVOQ_RECIPIENT_ID;
const filePath = process.argv[2];

if (!apiKey) throw new Error("Set ENVOQ_API_KEY to an evq_live_ key.");
if (!recipientId) throw new Error("Set ENVOQ_RECIPIENT_ID.");
if (!filePath) throw new Error("Usage: node large-file-transfer.ts ./artifact.zip");

const [bytes, info] = await Promise.all([readFile(filePath), stat(filePath)]);
const sha256 = createHash("sha256").update(bytes).digest("hex");

const response = await fetch(`${baseUrl}/transfers`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    to: recipientId,
    artifact: path.basename(filePath),
    size: info.size,
    checksum: sha256,
    transports: [process.env.ENVOQ_TRANSFER_URL || "https://your-agent.example.com/artifacts/artifact.zip"],
  }),
});

const json = await response.json();
if (!response.ok) throw new Error(JSON.stringify(json));
console.log(JSON.stringify(json, null, 2));
