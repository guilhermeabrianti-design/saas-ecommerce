import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/layouts/AppShell';
import { AuthLayout } from '@/layouts/AuthLayout';
import { RedirectIfAuthenticated, RequireAuth } from '@/features/auth/guards';
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
import { FinancePage } from '@/features/finance/pages/FinancePage';
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
          {
            element: <RequireOrganization />,
            children: [
              { path: 'organizacao', element: <OrganizationSettingsPage /> },
              { path: 'produtos', element: <ProductsPage /> },
              { path: 'produtos/novo', element: <NewProductPage /> },
              { path: 'produtos/:productId', element: <EditProductPage /> },
              { path: 'estoque', element: <InventoryPage /> },
              { path: 'estoque/:itemId', element: <InventoryItemPage /> },
              { path: 'financeiro', element: <FinancePage /> },
              {
                element: <RequireOrgKind kind="seller" />,
                children: [
                  { path: 'catalogo', element: <CatalogPage /> },
                  { path: 'catalogo/:listingId', element: <CatalogListingPage /> },
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
