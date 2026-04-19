import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const sb: SupabaseClient = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    headers: {
      "X-Client-Info": "hocker-node-agent/2.2.0",
    },
  },
});