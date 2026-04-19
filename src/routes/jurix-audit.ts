import { FastifyInstance } from "fastify";
import { createAdminSupabase } from "../lib/sandbox.js";

export async function jurixAuditRoutes(app: FastifyInstance) {
  const sb = createAdminSupabase();

  app.get("/v1/jurix/audit/logs", async (req: any) => {
    const { project_id = "hocker-one" } = req.query ?? {};

    const { data, error } = await sb
      .from("audit_logs")
      .select("*")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;
    return { ok: true, logs: data };
  });

  app.get("/v1/jurix/compliance", async (req: any) => {
    const { project_id = "hocker-one" } = req.query ?? {};

    const { data, error } = await sb
      .from("compliance_events")
      .select("*")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return { ok: true, events: data };
  });

  app.post("/v1/jurix/compliance/create", async (req: any) => {
    const body = req.body ?? {};

    const { data, error } = await sb
      .from("compliance_events")
      .insert({
        project_id: body.project_id,
        category: body.category,
        severity: body.severity,
        title: body.title,
        description: body.description,
        evidence: body.evidence || [],
      })
      .select()
      .single();

    if (error) throw error;
    return { ok: true, event: data };
  });
}