// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './supabase-sim';

/**
 * Invariants that must hold for the whole schema, not just today's tables.
 * A new migration that forgets RLS, a grant revoke or `search_path` fails here.
 */

/** RPCs deliberately callable by signed-in users. Anything else must not be. */
const AUTHENTICATED_RPCS = [
  'academy_ask',
  'academy_catalog',
  'academy_certificate',
  'academy_claim_certificate',
  'academy_course',
  'academy_delete_question',
  'academy_lesson',
  'academy_lesson_questions',
  'academy_request_unlock',
  'academy_save_progress',
  'academy_set_completed',
  'accept_invitation',
  'accept_invite_link',
  'adjust_stock',
  'admin_academy_questions',
  'admin_academy_students',
  'admin_academy_unlock_requests',
  'admin_answer_question',
  'admin_approve_unlock',
  'admin_approve_withdrawal',
  'admin_audit_entries',
  'admin_checkout_payments',
  'admin_checkout_refund_begin',
  'admin_checkout_summary',
  'admin_delete_commission_rule',
  'admin_issue_certificate',
  'admin_list_commission_rules',
  'admin_list_organizations',
  'admin_live_campaign',
  'admin_live_campaigns',
  'admin_moderate_listing',
  'admin_moderation_listings',
  'admin_move_academy_item',
  'admin_pay_withdrawal',
  'admin_referrals',
  'admin_referrals_overview',
  'admin_reject_withdrawal',
  'admin_review_supplier',
  'admin_reviews',
  'admin_save_category',
  'admin_save_commission_rule',
  'admin_save_fee_rule',
  'admin_save_live_campaign',
  'admin_save_referral_settings',
  'admin_save_wallet_settings',
  'admin_search_listings',
  'admin_set_category_active',
  'admin_set_fee_rule_active',
  'admin_set_review_hidden',
  'admin_set_suspension',
  'admin_simulate_split',
  'admin_stats',
  'admin_supplier_reviews',
  'admin_support_overview',
  'admin_support_ticket_context',
  'admin_support_tickets',
  'admin_update_listing_content',
  'admin_withdrawals',
  'admin_withdrawals_overview',
  'affiliate_stats',
  'ai_begin_description',
  'ai_begin_generation',
  'ai_finish',
  'ai_usage_today',
  'analytics_channels',
  'analytics_daily',
  'analytics_overview',
  'analytics_series',
  'analytics_top_items',
  'apply_referral_code',
  'cancel_order',
  'cancel_withdrawal',
  'catalog_browse',
  'catalog_suppliers',
  'checkout_order_status',
  'checkout_product_summary',
  'close_support_ticket',
  'confirm_order',
  'create_affiliate_link',
  'create_invite_link',
  'create_order',
  'create_organization',
  'create_support_ticket',
  'decline_invitation',
  'deliver_order',
  'ensure_my_organization',
  'estimate_sale_split',
  'finance_summary',
  'get_catalog_listing',
  'import_catalog_listing',
  'invite_link_preview',
  'invite_member',
  'link_listing',
  'list_organization_members',
  'listing_supplier_reputation',
  'live_campaign_for_seller',
  'live_campaigns_for_seller',
  'mark_all_notifications_read',
  'mark_notifications_read',
  'ml_documents_request',
  'my_pending_invitations',
  'my_supplier_reviews',
  'my_suspended_organizations',
  'oauth_begin',
  'organization_reputation',
  'pay_supplier_order',
  'pricing_simulate',
  'pricing_target',
  'record_order_payment',
  'referral_summary',
  'refund_order_payment',
  'register_shipping_label',
  'remove_member',
  'reply_review',
  'reply_support_ticket',
  'request_supplier_review',
  'request_withdrawal',
  'resubmit_catalog_listing',
  'retry_integration_event',
  'review_supplier_order',
  'revoke_invitation',
  'sales_center',
  'sales_center_listing',
  'save_product_channel_config',
  'search_catalog',
  'seller_dashboard',
  'seller_onboarding',
  'seller_suggestions',
  'set_connection_auto_forward',
  'set_connection_status',
  'set_live_campaign_participation',
  'set_product_checkout',
  'set_product_image_order',
  'set_public_code',
  'set_stock',
  'ship_order',
  'ship_supplier_order',
  'unlink_listing',
  'update_affiliate_link',
  'update_member_role',
  'void_shipping_label',
  'wallet_pending',
  'wallet_summary',
];

/** `private` functions used inside RLS policies/check constraints (evaluated as the caller). */
const POLICY_HELPERS = [
  'academy_file_readable',
  'can_manage_listing',
  // MFA da equipe (Fase 26): lido por is_platform_admin nas policies.
  'current_aal',
  'current_email',
  'has_org_role',
  'is_catalog_image',
  'is_moderation_image',
  'is_org_member',
  'is_platform_admin',
  'is_seller_member',
  // Check constraints de profiles.phone/document (rodam com o papel de quem grava).
  'is_valid_document',
  'is_valid_phone',
  // Etiquetas (Fase 30): policies do bucket e da tabela.
  'label_file_access',
  'org_kind',
  'org_role_of',
  'product_image_path_org',
  'sales_file_readable',
  'sales_material_listing',
  'shipment_org',
  'valid_variant_attributes',
  'visible_listing',
];

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe('RLS deny-by-default', () => {
  it('toda tabela do schema public tem RLS habilitada', async () => {
    const res = await db.query<{ relname: string }>(`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    `);
    expect(res.rows.map((r) => r.relname)).toEqual([]);
  });

  it('anon não tem privilégio em nenhuma tabela do schema public', async () => {
    const res = await db.query<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon'
    `);
    expect(res.rows).toEqual([]);
  });

  it('tabelas novas nascem sem acesso para anon/authenticated', async () => {
    await db.exec('create table public.future_table (id int); create sequence public.future_seq;');
    const res = await db.query<Record<string, boolean>>(`
      select
        has_table_privilege('anon', 'public.future_table', 'select') as anon_table,
        has_table_privilege('authenticated', 'public.future_table', 'select,insert,update,delete') as auth_table,
        has_sequence_privilege('authenticated', 'public.future_seq', 'usage') as auth_seq
    `);
    expect(res.rows[0]).toEqual({ anon_table: false, auth_table: false, auth_seq: false });
    await db.exec('drop table public.future_table; drop sequence public.future_seq;');
  });

  it('funções novas nascem sem permissão de execução', async () => {
    await db.exec('create function public.future_fn() returns int language sql as $$ select 1 $$;');
    const res = await db.query<Record<string, boolean>>(`
      select
        has_function_privilege('anon', 'public.future_fn()', 'execute') as anon,
        has_function_privilege('authenticated', 'public.future_fn()', 'execute') as auth
    `);
    expect(res.rows[0]).toEqual({ anon: false, auth: false });
    await db.exec('drop function public.future_fn();');
  });

  // Exceções: o comprador do checkout (sem conta) consulta o próprio pedido pelo token, e quem
  // recebeu um convite vê de qual empresa é antes de criar a conta.
  it('anon só executa a consulta do pedido do checkout e a prévia do convite', async () => {
    const res = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and has_function_privilege('anon', p.oid, 'execute')
      order by p.proname
    `);
    expect(res.rows.map((r) => r.proname)).toEqual([
      'checkout_order_status',
      'invite_link_preview',
    ]);
  });

  it('authenticated executa apenas as RPCs previstas no schema public', async () => {
    const res = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
      order by p.proname
    `);
    expect(res.rows.map((r) => r.proname)).toEqual(AUTHENTICATED_RPCS);
  });

  it('authenticated executa apenas os helpers de policy do schema private', async () => {
    // Internals such as reserve_stock / consume_reserved_stock / next_order_number
    // skip role checks by design and must stay reachable only through the RPCs.
    const res = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'execute')
      order by p.proname
    `);
    expect(res.rows.map((r) => r.proname)).toEqual(POLICY_HELPERS);
  });

  it('toda função security definer fixa search_path vazio', async () => {
    const res = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not coalesce('search_path=""' = any (p.proconfig), false)
    `);
    expect(res.rows.map((r) => r.proname)).toEqual([]);
  });
});
