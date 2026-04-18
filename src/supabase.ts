import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const sb: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
);

export function hasSupabaseCredentials(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}