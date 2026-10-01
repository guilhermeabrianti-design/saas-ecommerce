import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from '@/layouts/AppShell';
import { AuthLayout } from '@/layouts/AuthLayout';
import { PublicLayout } from '@/layouts/PublicLayout';
import { RedirectIfAuthenticated, RequireAuth, RequireRole } from '@/features/auth/guards';
import { AccountPage } from '@/features/auth/pages/AccountPage';
import { ForgotPasswordPage } from '@/features/auth/pages/ForgotPasswordPage';
import { MfaVerifyPage } from '@/features/auth/pages/MfaVerifyPage';
import { ResetPasswordPage } from '@/features/auth/pages/ResetPasswordPage';
import { SignInPage } from '@/features/auth/pages/SignInPage';
import { SignUpPage } from '@/features/auth/pages/SignUpPage';
import { InventoryItemPage } from '@/features/inventory/pages/InventoryItemPage';
import { InventoryPage } from '@/features/inventory/pages/InventoryPage';
import { RequireOrganization, RequireOrgKind } from '@/features/organizations/guards';
import { InvitePage } from '@/features/organizations/pages/InvitePage';
import { OrganizationSettingsPage } from '@/features/organizations/pages/OrganizationSettingsPage';
import { EditProductPage, NewProductPage } from '@/features/products/pages/ProductFormPage';
import { AcademyAdminPage } from '@/features/academy/pages/AcademyAdminPage';
import { AcademyPage } from '@/features/academy/pages/AcademyPage';
import { CertificatePage } from '@/features/academy/pages/CertificatePage';
import { CourseEditorPage } from '@/features/academy/pages/CourseEditorPage';
import { CoursePage } from '@/features/academy/pages/CoursePage';
import { LessonPage } from '@/features/academy/pages/LessonPage';
import { AdminPage } from '@/features/admin/pages/AdminPage';
import { AffiliatesPage } from '@/features/affiliates/pages/AffiliatesPage';
import { LinkRedirectPage } from '@/features/affiliates/pages/LinkRedirectPage';
import { ReferralsAdminPage } from '@/features/affiliates/pages/ReferralsAdminPage';
import { ReferralsPage } from '@/features/affiliates/pages/ReferralsPage';
import { StorePage } from '@/features/affiliates/pages/StorePage';
import { FeesAdminPage } from '@/features/fees/pages/FeesAdminPage';
import { CheckoutAdminPage } from '@/features/checkout/pages/CheckoutAdminPage';
import { CheckoutPage } from '@/features/checkout/pages/CheckoutPage';
import { CheckoutStatusPage } from '@/features/checkout/pages/CheckoutStatusPage';
import { ModerationPage } from '@/features/moderation/pages/ModerationPage';
import { ReputationPage } from '@/features/reviews/pages/ReputationPage';
import { ReviewsAdminPage } from '@/features/reviews/pages/ReviewsAdminPage';
import { AdminTicketPage, SupportAdminPage } from '@/features/support/pages/SupportAdminPage';
import { SupportPage, TicketPage } from '@/features/support/pages/SupportPage';
import { NotificationsPage } from '@/features/notifications/pages/NotificationsPage';
import { LiveCampaignEditorPage } from '@/features/sales/pages/LiveCampaignEditorPage';
import { LiveCampaignPage } from '@/features/sales/pages/LiveCampaignPage';
import { LiveCampaignsAdminPage } from '@/features/sales/pages/LiveCampaignsAdminPage';
import { LiveCampaignsPage } from '@/features/sales/pages/LiveCampaignsPage';
import { SalesCenterPage } from '@/features/sales/pages/SalesCenterPage';
import { SalesListingPage } from '@/features/sales/pages/SalesListingPage';
import { ToolsPage } from '@/features/tools/pages/ToolsPage';
import { AnalyticsPage } from '@/features/analytics/pages/AnalyticsPage';
import { FinancePage } from '@/features/finance/pages/FinancePage';
import { WalletPage } from '@/features/wallet/pages/WalletPage';
import { WithdrawalsAdminPage } from '@/features/wallet/pages/WithdrawalsAdminPage';
import { IntegrationPage } from '@/features/integrations/pages/IntegrationPage';
import { IntegrationsPage } from '@/features/integrations/pages/IntegrationsPage';
import { NewOrderPage } from '@/features/orders/pages/NewOrderPage';
import { OrderPage } from '@/features/orders/pages/OrderPage';
import { OrdersPage } from '@/features/orders/pages/OrdersPage';
import { CatalogListingPage } from '@/features/seller/pages/CatalogListingPage';
import { CatalogPage } from '@/features/seller/pages/CatalogPage';
import { SupplierOrderPage } from '@/features/supplier/pages/SupplierOrderPage';
import { SupplierOrdersPage } from '@/features/supplier/pages/SupplierOrdersPage';
import { ProductsPage } from '@/features/products/pages/ProductsPage';
import { HomePage } from '@/pages/HomePage';
import { RootRoute } from '@/pages/landing/RootRoute';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SystemStatusPage } from '@/pages/SystemStatusPage';
import { env } from '@/lib/env';

// Routes are added per phase. Only routes with working pages are registered
// (no placeholder screens or dead links).
export const router = createBrowserRouter([
  {
    // Landing page para visitantes (Fase 25); Início do app para quem entrou.
    // Home decides itself: staff accounts have no organization.
    path: '/',
    element: <RootRoute />,
    children: [{ index: true, element: <HomePage /> }],
  },
  {
    // Checkout público: quem compra não tem conta.
    element: <PublicLayout />,
    children: [
      { path: 'c/pedido/:token', element: <CheckoutStatusPage /> },
      { path: 'c/:productId', element: <CheckoutPage /> },
      // Divulgação do vendedor (Fase 23).
      { path: 'loja/:code', element: <StorePage /> },
      { path: 'r/:code', element: <LinkRedirectPage /> },
    ],
  },
  {
    element: <AuthLayout />,
    children: [
      {
        element: <RedirectIfAuthenticated />,
        children: [
          { path: 'entrar', element: <SignInPage /> },
          { path: 'cadastro', element: <SignUpPage /> },
          { path: 'recuperar-senha', element: <ForgotPasswordPage /> },
        ],
      },
      // Needs the recovery session, so it is not behind RedirectIfAuthenticated.
      { path: 'redefinir-senha', element: <ResetPasswordPage /> },
      // Link de convite: funciona com ou sem login.
      { path: 'convite/:token', element: <InvitePage /> },
      // Segundo passo do login (Fase 26): precisa da sessão aal1.
      { path: 'verificacao', element: <MfaVerifyPage /> },
    ],
  },
  {
    element: <AppShell />,
    children: [
      // Diagnóstico: aberto só antes de configurar o Supabase; depois, só a equipe.
      ...(env.supabase ? [] : [{ path: 'status', element: <SystemStatusPage /> }]),
      {
        element: <RequireAuth />,
        children: [
          { path: 'conta', element: <AccountPage /> },
          { path: 'notificacoes', element: <NotificationsPage /> },
          { path: 'suporte', element: <SupportPage /> },
          { path: 'suporte/:ticketId', element: <TicketPage /> },
          // Não existe mais "criar organização": a empresa nasce com a conta.
          { path: 'organizacao/nova', element: <Navigate to="/" replace /> },
          {
            // Academia: só contas de vendedor (não depende de organização).
            element: <RequireRole allowed={['seller']} />,
            children: [
              { path: 'academia', element: <AcademyPage /> },
              { path: 'academia/:courseId', element: <CoursePage /> },
              { path: 'academia/aula/:lessonId', element: <LessonPage /> },
              { path: 'academia/certificado/:certificateId', element: <CertificatePage /> },
            ],
          },
          {
            element: <RequireRole allowed={['admin']} />,
            children: [
              { path: 'admin', element: <AdminPage /> },
              ...(env.supabase ? [{ path: 'status', element: <SystemStatusPage /> }] : []),
              { path: 'admin/taxas', element: <FeesAdminPage /> },
              { path: 'admin/pagamentos', element: <CheckoutAdminPage /> },
              { path: 'admin/saques', element: <WithdrawalsAdminPage /> },
              { path: 'admin/indicacoes', element: <ReferralsAdminPage /> },
              { path: 'admin/suporte', element: <SupportAdminPage /> },
              { path: 'admin/avaliacoes', element: <ReviewsAdminPage /> },
              { path: 'admin/suporte/:ticketId', element: <AdminTicketPage /> },
              { path: 'admin/moderacao', element: <ModerationPage /> },
              { path: 'admin/academia', element: <AcademyAdminPage /> },
              { path: 'admin/academia/:courseId', element: <CourseEditorPage /> },
              { path: 'admin/lives', element: <LiveCampaignsAdminPage /> },
              { path: 'admin/lives/:campaignId', element: <LiveCampaignEditorPage /> },
            ],
          },
          {
            element: <RequireOrganization />,
            children: [
              { path: 'organizacao', element: <OrganizationSettingsPage /> },
              { path: 'produtos', element: <ProductsPage /> },
              { path: 'produtos/novo', element: <NewProductPage /> },
              { path: 'produtos/:productId', element: <EditProductPage /> },
              { path: 'estoque', element: <InventoryPage /> },
              { path: 'estoque/:itemId', element: <InventoryItemPage /> },
              { path: 'analises', element: <AnalyticsPage /> },
              { path: 'financeiro', element: <FinancePage /> },
              { path: 'carteira', element: <WalletPage /> },
              { path: 'reputacao', element: <ReputationPage /> },
              {
                element: <RequireOrgKind kind="seller" />,
                children: [
                  { path: 'indicacoes', element: <ReferralsPage /> },
                  { path: 'catalogo', element: <CatalogPage /> },
                  { path: 'catalogo/:listingId', element: <CatalogListingPage /> },
                  { path: 'central', element: <SalesCenterPage /> },
                  { path: 'central/lives', element: <LiveCampaignsPage /> },
                  { path: 'central/lives/:campaignId', element: <LiveCampaignPage /> },
                  { path: 'central/:listingId', element: <SalesListingPage /> },
                  { path: 'ferramentas', element: <ToolsPage /> },
                  { path: 'divulgacao', element: <AffiliatesPage /> },
                  { path: 'integracoes', element: <IntegrationsPage /> },
                  { path: 'integracoes/:connectionId', element: <IntegrationPage /> },
                  { path: 'pedidos', element: <OrdersPage /> },
                  { path: 'pedidos/novo', element: <NewOrderPage /> },
                  { path: 'pedidos/:orderId', element: <OrderPage /> },
                ],
              },
              {
                element: <RequireOrgKind kind="supplier" />,
                children: [
                  { path: 'fornecimentos', element: <SupplierOrdersPage /> },
                  {
                    path: 'fornecimentos/:supplierOrderId',
                    element: <SupplierOrderPage />,
                  },
                ],
              },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
