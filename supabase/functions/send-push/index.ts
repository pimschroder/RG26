import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// @deno-types="npm:@types/web-push"
import webpush from 'npm:web-push';

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

webpush.setVapidDetails('mailto:admin@rg2026.app', VAPID_PUBLIC, VAPID_PRIVATE);

serve(async (req) => {
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { title, body, sender } = await req.json();
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: subs } = await sb.from('push_subscriptions').select('id, user_name, subscription');
    if (!subs?.length) return new Response(JSON.stringify({ sent: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const payload = JSON.stringify({ title, body });
    const toSend = subs.filter(s => s.user_name !== sender);
    const results = await Promise.allSettled(toSend.map(s => webpush.sendNotification(s.subscription, payload)));

    // Verwijder verlopen subscriptions
    const expiredIds = results.map((r, i) => r.status === 'rejected' ? toSend[i].id : null).filter(Boolean);
    if (expiredIds.length) await sb.from('push_subscriptions').delete().in('id', expiredIds);

    const sent = results.filter(r => r.status === 'fulfilled').length;
    return new Response(JSON.stringify({ sent }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
