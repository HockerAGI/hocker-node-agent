import type { FastifyInstance, FastifyRequest } from "fastify";
import { sb } from "../supabase.js";

type ProjectQuery = {
  project_id?: string;
};

type ComplianceCreateBody = {
  project_id?: string;
  category?: string;
  severity?: string;
  title?: string;
  description?: string;
  evidence?: unknown;
};

function normalizeProjectId(value: unknown): string {
  const normalized = String(value ?? "hocker-one")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);

  return normalized || "hocker-one";
}

function asEvidence(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function jurixAuditRoutes(app: FastifyInstance) {
  app.get("/v1/jurix/audit/logs", async (req: FastifyRequest<{ Querystring: ProjectQuery }>) => {
    const project_id = normalizeProjectId(req.query?.project_id);

    const { data, error } = await sb
      .from("audit_logs")
      .select("*")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      throw new Error(error.message);
    }

    return { ok: true, logs: data ?? [] };
  });

  app.get("/v1/jurix/compliance", async (req: FastifyRequest<{ Querystring: ProjectQuery }>) => {
    const project_id = normalizeProjectId(req.query?.project_id);

    const { data, error } = await sb
      .from("compliance_events")
      .select("*")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    return { ok: true, events: data ?? [] };
  });

  app.post("/v1/jurix/compliance/create", async (req: FastifyRequest<{ Body: ComplianceCreateBody }>) => {
    const body = req.body ?? {};

    const payload = {
      project_id: normalizeProjectId(body.project_id),
      category: String(body.category ?? "general").trim(),
      severity: String(body.severity ?? "info").trim(),
      title: String(body.title ?? "Compliance event").trim(),
      description: String(body.description ?? "").trim(),
      evidence: asEvidence(body.evidence),
    };

    const { data, error } = await sb
      .from("compliance_events")
      .insert(payload)
      .select("*")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return { ok: true, event: data };
  });
}