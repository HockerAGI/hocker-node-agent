import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

if (!config.supabase.url || !config.supabase.serviceRoleKey) {
  console.error("CRITICAL: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son obligatorios.");
  process.exit(1);
}

// Inicializa el cliente con la llave maestra para saltar RLS y actuar como el sistema
export const sb = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);