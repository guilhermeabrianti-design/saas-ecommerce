import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/layouts/AppShell';
import { AuthLayout } from '@/layouts/AuthLayout';
import { RedirectIfAuthenticated, RequireAuth, RequireRole } from '@/features/auth/guards';
import { AccountPage } from '@/features/auth/pages/AccountPage';
import { ForgotPasswordPage } from '@/features/auth/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '@/features/auth/pages/ResetPasswordPage';
import { SignInPage } from '@/features/auth/pages/SignInPage';
import { SignUpPage } from '@/features/auth/pages/SignUpPage';
import { InventoryItemPage } from '@/features/inventory/pages/InventoryItemPage';
import { InventoryPage } from '@/features/inventory/pages/InventoryPage';
import { RequireOrganization, RequireOrgKind } from '@/features/organizations/guards';
import { CreateOrganizationPage } from '@/features/organizations/pages/CreateOrganizationPage';
import { OrganizationSettingsPage } from '@/features/organizations/pages/OrganizationSettingsPage';
import { EditProductPage, NewProductPage } from '@/features/products/pages/ProductFormPage';
import { AcademyAdminPage } from '@/features/academy/pages/AcademyAdminPage';
import { AcademyPage } from '@/features/academy/pages/AcademyPage';
import { CertificatePage } from '@/features/academy/pages/CertificatePage';
import { CourseEditorPage } from '@/features/academy/pages/CourseEditorPage';
import { CoursePage } from '@/features/academy/pages/CoursePage';
import { LessonPage } from '@/features/academy/pages/LessonPage';
import { AdminPage } from '@/features/admin/pages/AdminPage';
import { FeesAdminPage } from '@/features/fees/pages/FeesAdminPage';
import { ModerationPage } from '@/features/moderation/pages/ModerationPage';
import { LiveCampaignEditorPage } from '@/features/sales/pages/LiveCampaignEditorPage';
import { LiveCampaignPage } from '@/features/sales/pages/LiveCampaignPage';
import { LiveCampaignsAdminPage } from '@/features/sales/pages/LiveCampaignsAdminPage';
import { LiveCampaignsPage } from '@/features/sales/pages/LiveCampaignsPage';
import { SalesCenterPage } from '@/features/sales/pages/SalesCenterPage';
import { SalesListingPage } from '@/features/sales/pages/SalesListingPage';
import { AnalyticsPage } from '@/features/analytics/pages/AnalyticsPage';
import { FinancePage } from '@/features/finance/pages/FinancePage';
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
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SystemStatusPage } from '@/pages/SystemStatusPage';

// Routes are added per phase. Only routes with working pages are registered
// (no placeholder screens or dead links).
export const router = createBrowserRouter([
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
    ],
  },
  {
    element: <AppShell />,
    children: [
      // Public diagnostic page: must work before Supabase is configured.
      { path: 'status', element: <SystemStatusPage /> },
      {
        element: <RequireAuth />,
        children: [
          // Home decides itself: staff accounts have no organization.
          { index: true, element: <HomePage /> },
          { path: 'conta', element: <AccountPage /> },
          { path: 'organizacao/nova', element: <CreateOrganizationPage /> },
          // Academia: qualquer conta (não depende de organização).
          { path: 'academia', element: <AcademyPage /> },
          { path: 'academia/:courseId', element: <CoursePage /> },
          { path: 'academia/aula/:lessonId', element: <LessonPage /> },
          { path: 'academia/certificado/:certificateId', element: <CertificatePage /> },
          {
            element: <RequireRole allowed={['admin']} />,
            children: [
              { path: 'admin', element: <AdminPage /> },
              { path: 'admin/taxas', element: <FeesAdminPage /> },
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
              {
                element: <RequireOrgKind kind="seller" />,
                children: [
                  { path: 'catalogo', element: <CatalogPage /> },
                  { path: 'catalogo/:listingId', element: <CatalogListingPage /> },
                  { path: 'central', element: <SalesCenterPage /> },
                  { path: 'central/lives', element: <LiveCampaignsPage /> },
                  { path: 'central/lives/:campaignId', element: <LiveCampaignPage /> },
                  { path: 'central/:listingId', element: <SalesListingPage /> },
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
