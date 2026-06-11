import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { sql } from "../db/neon.js";

const router = Router();

type DiagnosticsStatus = "healthy" | "degraded" | "failed" | "unknown";

function getExpectedAgentKey(): string {
  return String(process.env.CONECTA_AGENT_KEY || "").trim();
}

function getExpectedAgentId(): string {
  return String(process.env.CONECTA_AGENT_ID || "").trim();
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readBearerToken(req: Request): string {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function requireAgentAuth(req: Request, res: Response, next: NextFunction) {
  const expectedAgentKey = getExpectedAgentKey();
  const expectedAgentId = getExpectedAgentId();

  if (!expectedAgentKey || !expectedAgentId) {
    return res.status(503).json({
      ok: false,
      error: "AGENT_ROUTE_NOT_CONFIGURED",
      message: "CONECTA_AGENT_KEY and CONECTA_AGENT_ID must be configured on the proxy before /api/agent routes can run in real mode."});
  }

  const providedAgentKey = readBearerToken(req);
  const providedAgentId = String(req.headers["x-agent-id"] || "").trim();

  if (
    !providedAgentKey ||
    !providedAgentId ||
    !timingSafeEqualString(providedAgentKey, expectedAgentKey) ||
    !timingSafeEqualString(providedAgentId, expectedAgentId)
  ) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED_AGENT",
      message: "Bearer token or X-Agent-ID is invalid for /api/agent access."});
  }

  return next();
}

function getServiceManifests() {
  const serviceName = process.env.K_SERVICE || process.env.SERVICE_NAME || "conecta-proxy";
  const serviceUrl = process.env.API_BASE || process.env.APP_URL || process.env.CLIENT_URL || "https://api.holaconecta.com";

  return [
    {
      id: "sm-conecta-proxy",
      name: serviceName,
      type: "cloudrun",
      repo: "hola_conecta/proxy",
      path: "/proxy",
      env: [
        `NODE_ENV=${process.env.NODE_ENV || "production"}`,
        `API_BASE=${serviceUrl}`,
      ],
      dependencies: ["neon", "firebase-admin"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()},
  ];
}

function getCapabilities() {
  const now = new Date().toISOString();
  return [
    {
      id: "cap-agent-manifests-read",
      name: "list_service_manifests",
      target_system: "conecta-proxy",
      scope: "read",
      blast_radius: "low",
      auth_type: "machine-key",
      input_schema: { type: "object", properties: {} },
      output_schema: { type: "array" },
      retry_policy: "3x-exponential",
      verification_method: "none",
      audit_logging: true,
      createdAt: now,
      updatedAt: now},
    {
      id: "cap-agent-capabilities-read",
      name: "list_agent_capabilities",
      target_system: "conecta-proxy",
      scope: "read",
      blast_radius: "low",
      auth_type: "machine-key",
      input_schema: { type: "object", properties: {} },
      output_schema: { type: "array" },
      retry_policy: "3x-exponential",
      verification_method: "none",
      audit_logging: true,
      createdAt: now,
      updatedAt: now},
    {
      id: "cap-agent-diagnostics-run",
      name: "run_proxy_diagnostics",
      target_system: "conecta-proxy",
      scope: "read",
      blast_radius: "low",
      auth_type: "machine-key",
      input_schema: {
        type: "object",
        properties: {
          targetSystem: { type: "string" },
          issueType: { type: "string" }},
        required: ["targetSystem", "issueType"]},
      output_schema: { type: "object" },
      retry_policy: "2x-linear",
      verification_method: "manual-review",
      audit_logging: true,
      createdAt: now,
      updatedAt: now},
  ];
}

async function runDiagnostics(targetSystem: string, issueType: string) {
  const findings: string[] = [];
  const configSnapshot = {
    targetSystem,
    issueType,
    nodeEnv: process.env.NODE_ENV || "development",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    serviceName: process.env.K_SERVICE || process.env.SERVICE_NAME || "conecta-proxy"};

  let status: DiagnosticsStatus = "healthy";

  if (!process.env.DATABASE_URL) {
    status = "degraded";
    findings.push("DATABASE_URL is not configured on the proxy.");
  } else {
    try {
      await sql`SELECT 1 AS ok`;
      findings.push("Neon connectivity check passed.");
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      status = "failed";
      findings.push(`Neon connectivity check failed: ${typedError.message}`);
    }
  }

  if (findings.length === 0) {
    findings.push("No issues detected.");
  }

  return {
    status,
    findings,
    config_snapshot: configSnapshot,
    raw_logs: `Diagnostics executed for ${targetSystem} (${issueType}) at ${new Date().toISOString()}`};
}

router.use(requireAgentAuth);

router.get("/manifests", (req, res) => {
  res.json(getServiceManifests());
});

router.get("/capabilities", (req, res) => {
  res.json(getCapabilities());
});

router.post("/diagnostics", async (req, res) => {
  const { targetSystem, issueType } = req.body || {};

  if (!targetSystem || !issueType) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_REQUEST",
      message: "targetSystem and issueType are required."});
  }

  try {
    const diagnostics = await runDiagnostics(String(targetSystem), String(issueType));
    return res.json(diagnostics);
  } catch (error) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    return res.status(500).json({
      ok: false,
      error: "AGENT_DIAGNOSTICS_FAILED",
      message: typedError.message || "Diagnostics failed."});
  }
});

export default router;
