#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8776);
const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "hola-conecta-app";
const service = process.env.CLOUD_RUN_SERVICE || "conecta-proxy-prod";
const freshness = process.env.LOG_FRESHNESS || "2h";
const limit = process.env.LOG_LIMIT || "300";
const maxEntries = process.env.LOG_MAX_ENTRIES ? Number(process.env.LOG_MAX_ENTRIES) : Number(limit);
const includeNoisy = process.env.LOG_INCLUDE_NOISY === "1";
const terms = (process.env.LOG_TERMS || "sophia_adk,google_adk,tool_bridge_decision,GoogleMapsGroundingTool,canonicalTool,grounding,directions,Maps,maps,Gemini,gemini")
  .split(",")
  .map((term) => term.trim())
  .filter(Boolean);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function sanitize(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/(api[_-]?key|access[_-]?token|authorization|bearer|secret|password)["':=\s]+[^\s"',}]+/gi, "$1=[redacted]");
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJson(item)]));
  }
  if (typeof value === "string") return sanitize(value);
  return value;
}

function entryText(entry) {
  return [
    entry.textPayload,
    entry.jsonPayload?.message,
    entry.jsonPayload?.event,
    entry.jsonPayload?.name,
    entry.jsonPayload ? JSON.stringify(entry.jsonPayload) : "",
    entry.labels ? JSON.stringify(entry.labels) : ""
  ].filter(Boolean).join(" ");
}

function isNoisyFrameLog(entry) {
  const text = entryText(entry).toLowerCase();
  return [
    "agent: sofia-voice-orchestrator",
    "agent\":\"sofia-voice-orchestrator",
    "voice.json.infobip",
    "voice.json.phone",
    "voice.json.media",
    "voice.json.gemini.server_frame",
    "voice.json.gemini.client_frame",
    "server_frame_received",
    "client_frame_sent",
    "audio_chunk",
    "audio frame",
    "media frame",
    "input_audio",
    "output_audio",
    "turn_complete",
    "setup_complete",
    "phone_presence",
    "presence_projection",
    "rtdb-event"
  ].some((pattern) => text.includes(pattern));
}

function isGeminiLiveEvidenceLog(entry) {
  const payload = entry.jsonPayload && typeof entry.jsonPayload === "object" ? entry.jsonPayload : {};
  return payload.provider === "gemini"
    && (payload.event === "voice.json.gemini.server_frame_received" || payload.stage === "server_frame_received");
}

function isChallengeEvidenceLog(entry) {
  const payload = entry.jsonPayload && typeof entry.jsonPayload === "object" ? entry.jsonPayload : {};
  if (isGeminiLiveEvidenceLog(entry)) {
    return true;
  }

  const decision = parseDecisionDump(payload);
  const text = entryText(entry).toLowerCase();
  return Boolean(decision)
    || payload.provider === "google_adk"
    || text.includes("sophia_adk")
    || text.includes("google_adk")
    || text.includes("tool_bridge_decision")
    || text.includes("googlemapsgroundingtool")
    || text.includes("canonicaltool")
    || text.includes("grounding")
    || text.includes("directions")
    || text.includes("vertex");
}

function compactPayloadValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return sanitize(value);
  if (Array.isArray(value)) return value.map(compactPayloadValue).filter(Boolean).slice(0, 4).join(", ");
  if (typeof value === "object") {
    const fields = ["message", "event", "name", "status", "tool", "workflow", "route", "intent", "summary", "description", "text"];
    return fields.map((field) => compactPayloadValue(value[field])).find(Boolean) || "";
  }
  return sanitize(value);
}

function parseDecisionDump(payload) {
  const chunks = payload?.decisionDump?.jsonChunks;
  if (!chunks || typeof chunks !== "object") return null;
  const text = Object.keys(chunks)
    .sort()
    .map((key) => chunks[key])
    .join("");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function humanLogMessage(entry) {
  const payload = entry.jsonPayload && typeof entry.jsonPayload === "object" ? entry.jsonPayload : {};
  if (isGeminiLiveEvidenceLog(entry)) {
    return [
      "Gemini Live API response received",
      [
        payload.converter ? `Converter: ${compactPayloadValue(payload.converter)}` : "",
        payload.sender ? `Sender: ${compactPayloadValue(payload.sender)}` : "",
        payload.receiver ? `Receiver: ${compactPayloadValue(payload.receiver)}` : "",
        payload.status ? `Status: ${compactPayloadValue(payload.status)}` : ""
      ].filter(Boolean).join(" | ")
    ].filter(Boolean).join(" — ");
  }

  const decision = parseDecisionDump(payload);
  if (decision) {
    const agent = compactPayloadValue(decision.agent);
    const canonicalTool = compactPayloadValue(decision.canonicalTool);
    const handler = compactPayloadValue(decision.canonicalHandler || payload.handler);
    const decisionText = compactPayloadValue(decision.decision);
    const provider = compactPayloadValue(payload.provider);
    const status = compactPayloadValue(payload.status);
    return [
      decisionText || `${agent || "Sophia ADK"} selected ${canonicalTool || "a tool"}`,
      [
        agent ? `Agent: ${agent}` : "",
        canonicalTool ? `Tool: ${canonicalTool}` : "",
        handler ? `Handler: ${handler}` : "",
        provider ? `Provider: ${provider}` : "",
        status ? `Status: ${status}` : ""
      ].filter(Boolean).join(" | ")
    ].filter(Boolean).join(" — ");
  }

  const primary = [
    entry.textPayload,
    payload.message,
    payload.summary,
    payload.description,
    payload.text
  ].map(compactPayloadValue).find(Boolean);
  const details = ["event", "name", "agent", "component", "tool", "workflow", "route", "intent", "status", "model", "provider"]
    .map((key) => {
      const value = compactPayloadValue(payload[key]);
      return value ? `${key}: ${value}` : "";
    })
    .filter(Boolean)
    .slice(0, 5);
  return [primary, details.join(" | ")].filter(Boolean).join(" — ") || "Log entry received";
}

function readCloudRunLogs() {
  if (process.env.K_SERVICE || process.env.USE_CLOUD_LOGGING_API === "1") {
    return readCloudRunLogsViaApi();
  }

  const termFilter = terms
    .map((term) => {
      const safeTerm = term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `(textPayload:"${safeTerm}" OR jsonPayload.message:"${safeTerm}" OR jsonPayload.event:"${safeTerm}" OR jsonPayload.name:"${safeTerm}" OR jsonPayload.agent:"${safeTerm}" OR jsonPayload.component:"${safeTerm}" OR jsonPayload.provider:"${safeTerm}" OR jsonPayload.stage:"${safeTerm}" OR jsonPayload.msg:"${safeTerm}" OR jsonPayload.handler:"${safeTerm}" OR jsonPayload.converter:"${safeTerm}" OR jsonPayload.receiver:"${safeTerm}" OR jsonPayload.sender:"${safeTerm}")`;
    })
    .join(" OR ");
  const filter = [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${service}"`,
    `(${termFilter})`
  ].join(" AND ");
  const args = [
    "logging",
    "read",
    filter,
    `--project=${project}`,
    `--freshness=${freshness}`,
    `--limit=${limit}`,
    "--format=json"
  ];

  return new Promise((resolve, reject) => {
    execFile("gcloud", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || ""}`.trim();
        reject(error);
        return;
      }

      const parsed = JSON.parse(stdout || "[]");
      resolve(buildLogResponse(parsed));
    });
  });
}

function buildLogFilter() {
  const termFilter = terms
    .map((term) => {
      const safeTerm = term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `(textPayload:"${safeTerm}" OR jsonPayload.message:"${safeTerm}" OR jsonPayload.event:"${safeTerm}" OR jsonPayload.name:"${safeTerm}" OR jsonPayload.agent:"${safeTerm}" OR jsonPayload.component:"${safeTerm}" OR jsonPayload.provider:"${safeTerm}" OR jsonPayload.stage:"${safeTerm}" OR jsonPayload.msg:"${safeTerm}" OR jsonPayload.handler:"${safeTerm}" OR jsonPayload.converter:"${safeTerm}" OR jsonPayload.receiver:"${safeTerm}" OR jsonPayload.sender:"${safeTerm}")`;
    })
    .join(" OR ");
  return [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${service}"`,
    `(${termFilter})`,
    `timestamp >= "${new Date(Date.now() - freshnessToMs(freshness)).toISOString()}"`
  ].join(" AND ");
}

function freshnessToMs(value) {
  const match = String(value).trim().match(/^(\d+)([smhd])$/i);
  if (!match) return 2 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

async function getMetadataAccessToken() {
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" }
  });
  if (!response.ok) {
    throw new Error(`metadata token request failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("metadata token response missing access_token");
  return data.access_token;
}

async function readCloudRunLogsViaApi() {
  const token = await getMetadataAccessToken();
  const response = await fetch("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      resourceNames: [`projects/${project}`],
      filter: buildLogFilter(),
      orderBy: "timestamp desc",
      pageSize: Number(limit)
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Cloud Logging API failed: HTTP ${response.status} ${detail.slice(0, 500)}`);
  }
  const data = await response.json();
  return buildLogResponse(data.entries || []);
}

function buildLogResponse(parsed) {
  const seenGeminiEvidence = new Set();
  const filtered = parsed
    .filter((entry) => entry.textPayload || entry.jsonPayload)
    .filter((entry) => {
      if (isGeminiLiveEvidenceLog(entry)) {
        const minute = String(entry.timestamp || entry.receiveTimestamp || "").slice(0, 16);
        const key = `gemini:${minute}`;
        if (seenGeminiEvidence.has(key)) return false;
        seenGeminiEvidence.add(key);
        return true;
      }
      return isChallengeEvidenceLog(entry) && (includeNoisy || !isNoisyFrameLog(entry));
    })
    .filter((entry) => humanLogMessage(entry) !== "Log entry received")
    .slice(0, maxEntries)
    .map((entry) => {
      const textPayload = humanLogMessage(entry);
      const payload = entry.jsonPayload && typeof entry.jsonPayload === "object" ? entry.jsonPayload : {};
      const decision = parseDecisionDump(payload);
      return {
        insertId: entry.insertId || null,
        timestamp: entry.timestamp || entry.receiveTimestamp || null,
        receiveTimestamp: entry.receiveTimestamp || null,
        severity: entry.severity || "INFO",
        product: isGeminiLiveEvidenceLog(entry) ? "Gemini" : decision?.canonicalTool === "GoogleMapsGroundingTool" ? "Google Maps" : decision ? "Google ADK" : payload.provider === "google_adk" ? "Google ADK" : null,
        resource: {
          type: entry.resource?.type || "cloud_run_revision",
          service_name: entry.resource?.labels?.service_name || service,
          revision_name: entry.resource?.labels?.revision_name || null,
          location: entry.resource?.labels?.location || null
        },
        message: textPayload.slice(0, 900),
        jsonPayload: entry.jsonPayload ? sanitizeJson(entry.jsonPayload) : undefined
      };
    });

  return {
    source: process.env.K_SERVICE ? "cloud-logging-api" : "google-cloud-logging",
    project,
    service,
    freshness,
    limit: Number(limit),
    maxEntries,
    includeNoisy,
    terms,
    fetchedAt: new Date().toISOString(),
    entries: filtered
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(value, null, 2));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/logs") {
      try {
        sendJson(res, 200, await readCloudRunLogs());
      } catch (error) {
        sendJson(res, 500, {
          error: "Unable to read Google Cloud logs",
          detail: sanitize(error.message),
          project,
          service,
          freshness
        });
      }
      return;
    }

    const pathname = url.pathname === "/" ? "/startup-challenge.html" : url.pathname;
    const safePath = pathname.replace(/^\/+/, "");
    if (safePath.includes("..")) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    const filePath = join(root, safePath);
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(port, () => {
  console.log("Conecta Sofia Call Startup Challenge server started.");
  console.log("Live log endpoint available at /logs.");
  console.log(`Project/service:         ${project} / ${service}`);
  console.log("Press Ctrl+C to stop.");
});
