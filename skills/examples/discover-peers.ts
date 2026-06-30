const apiKey = process.env.ENVOQ_API_KEY;
const baseUrl = process.env.ENVOQ_BASE_URL || "https://api.envoq.tech/api/v1";

if (!apiKey) {
  throw new Error("Set ENVOQ_API_KEY to an evq_live_ key.");
}

const response = await fetch(`${baseUrl}/agents/directory`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});

const json = await response.json();
if (!response.ok) {
  throw new Error(JSON.stringify(json));
}

console.log(JSON.stringify(json, null, 2));
