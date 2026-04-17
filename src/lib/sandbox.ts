import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import type { JsonObject } from "../types.js";

type DB = {
  public: {
    Tables: {
      commands: {
        Row: {
          id: string;
          project_id: string;
          node_id: string;
          command: string;
          payload: JsonObject;
          signature: string;
          status: string;
          result: JsonObject | null;
          error: string | null;
          created_at: string;
          executed_at: string | null;
        };
      };
      events: {
        Row: {
          id: string;
          project_id: string;
          node_id: string | null;
          type: string;
          message: string;
          level: string;
          data: JsonObject | null;
          created_at: string;
        };
      };
    };
  };
};

export function createAdminSupabase(): SupabaseClient<DB> {
  return createClient<DB>(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}