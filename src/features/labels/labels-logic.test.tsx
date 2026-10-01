import { render, screen } from '@testing-library/react';
import { inTransit } from '@/features/orders/schemas';
import { LabelsSection } from './components/LabelsSection';
import {
  checkLabelFile,
  labelErrorMessage,
  mlDocumentsErrorMessage,
  mlDocumentsMessage,
  labelPath,
  latestTracking,
  shipmentFolder,
  type ShippingLabel,
} from './labels';

const mocks = vi.hoisted(() => ({ labels: [] as unknown[] }));

vi.mock('./api', () => ({
  useShippingLabels: () => ({ isPending: false, isError: false, data: mocks.labels }),
  useUploadLabel: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useVoidLabel: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  labelDownloadUrl: vi.fn(),
}));

const so = '5b7c2a53-6d4e-4c1b-9f53-0b3f6f0f7a11';

const label = (over: Partial<ShippingLabel>): ShippingLabel => ({
  id: '7c9d3b64-7e5f-4d2c-8a64-1c4a7a1a8b22',
  supplier_order_id: so,
  order_id: null,
  storage_path: `so-${so}/a.pdf`,
  file_name: 'etiqueta-ml.pdf',
  carrier: 'Correios',
  tracking_code: 'AA123456789BR',
  uploaded_org_id: null,
  voided_at: null,
  created_at: '2026-09-28T12:00:00Z',
  kind: 'label',
  source: 'upload',
  ...over,
});

describe('regras', () => {
  it('pasta do envio e caminho do arquivo', () => {
    expect(shipmentFolder({ supplierOrderId: so, orderId: null })).toBe(`so-${so}`);
    expect(shipmentFolder({ supplierOrderId: null, orderId: so })).toBe(`o-${so}`);
    expect(labelPath({ supplierOrderId: so, orderId: null }, 'application/pdf', 'x')).toBe(
      `so-${so}/x.pdf`,
    );
  });

  it('confere tipo e tamanho antes de enviar', () => {
    expect(checkLabelFile({ type: 'application/pdf', size: 1000 })).toBeNull();
    expect(checkLabelFile({ type: 'image/gif', size: 1000 })).toMatch(/PDF, PNG ou JPG/);
    expect(checkLabelFile({ type: 'image/png', size: 6 * 1024 * 1024 })).toMatch(/5 MB/);
    // Nota fiscal: DANFE só PDF; XML pelo tipo ou, sem tipo, pela extensão.
    expect(checkLabelFile({ type: 'application/pdf', size: 10 }, 'invoice_pdf')).toBeNull();
    expect(checkLabelFile({ type: 'image/png', size: 10 }, 'invoice_pdf')).toMatch(/DANFE/);
    expect(checkLabelFile({ type: 'text/xml', size: 10 }, 'invoice_xml')).toBeNull();
    expect(checkLabelFile({ type: '', size: 10, name: 'NF-123.XML' }, 'invoice_xml')).toBeNull();
    expect(checkLabelFile({ type: 'application/pdf', size: 10 }, 'invoice_xml')).toMatch(/XML/);
    expect(labelPath({ supplierOrderId: so, orderId: null }, 'text/xml', 'x')).toBe(
      `so-${so}/x.xml`,
    );
  });

  it('resumo da busca no Mercado Livre', () => {
    expect(mlDocumentsMessage({ status: 'confirmed', attached: ['label', 'invoice_pdf'] })).toBe(
      '2 documentos anexados.',
    );
    expect(mlDocumentsMessage({ status: 'confirmed', attached: [] })).toMatch(/Nenhum documento/);
    expect(mlDocumentsMessage({ status: 'pending' })).toMatch(/pendente/);
    expect(mlDocumentsMessage({ skipped: 'pedido cancelled' })).toMatch(/cancelled/);
    expect(mlDocumentsErrorMessage('not_mercadolivre')).toMatch(/não veio do Mercado Livre/);
    expect(mlDocumentsErrorMessage(null)).toMatch(/Tente de novo/);
  });

  it('rastreio mais recente ativo; erros legíveis', () => {
    expect(
      latestTracking([
        label({ id: 'a', created_at: '2026-09-28T10:00:00Z', tracking_code: 'OLD1' }),
        label({ id: 'b', created_at: '2026-09-28T11:00:00Z', tracking_code: 'NEW1' }),
        label({
          id: 'c',
          created_at: '2026-09-28T12:00:00Z',
          tracking_code: 'VOID',
          voided_at: '2026-09-28T12:05:00Z',
        }),
      ])?.tracking_code,
    ).toBe('NEW1');
    expect(latestTracking([label({ tracking_code: null })])).toBeNull();
    expect(labelErrorMessage({ message: 'labels.shipment_closed' })).toMatch(/encerrado/);
    expect(labelErrorMessage({ message: 'new row violates row-level security policy' })).toMatch(
      /PDF/,
    );
  });

  it('em trânsito: enviado, ou confirmado com fornecimento enviado com rastreio', () => {
    expect(inTransit({ status: 'shipped', supplier_orders: [] })).toBe(true);
    expect(
      inTransit({
        status: 'confirmed',
        supplier_orders: [{ status: 'shipped', tracking_code: 'AA1' }],
      }),
    ).toBe(true);
    expect(
      inTransit({
        status: 'confirmed',
        supplier_orders: [{ status: 'pending', tracking_code: null }],
      }),
    ).toBe(false);
    expect(inTransit({ status: 'delivered', supplier_orders: [] })).toBe(false);
  });
});

describe('seção de etiquetas', () => {
  it('lista, baixa e anula; anulada fica riscada e sem ações', () => {
    mocks.labels = [
      label({}),
      label({
        id: 'b1b2c3d4-0000-4000-8000-000000000001',
        file_name: 'velha.pdf',
        voided_at: '2026-09-28T13:00:00Z',
      }),
    ];
    render(
      <LabelsSection
        shipment={{ supplierOrderId: so, orderId: null }}
        canUpload
        emptyText="vazio"
      />,
    );
    expect(screen.getByText('etiqueta-ml.pdf')).toBeInTheDocument();
    expect(screen.getAllByText('AA123456789BR')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Baixar/ })).toHaveLength(1);
    expect(screen.getByText(/anulada/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anexar etiqueta' })).toBeDisabled();
  });

  it('nota fiscal do Mercado Livre aparece com o tipo e a origem', () => {
    mocks.labels = [
      label({
        kind: 'invoice_pdf',
        source: 'mercadolivre',
        file_name: 'nota-fiscal-28790.pdf',
        carrier: null,
        tracking_code: null,
      }),
    ];
    render(
      <LabelsSection
        shipment={{ supplierOrderId: so, orderId: null }}
        canUpload={false}
        emptyText="vazio"
      />,
    );
    expect(screen.getByText('nota-fiscal-28790.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Nota fiscal \(DANFE\) · Mercado Livre/)).toBeInTheDocument();
  });

  it('sem permissão de envio: só baixa; vazio mostra orientação', () => {
    mocks.labels = [];
    render(
      <LabelsSection
        shipment={{ supplierOrderId: so, orderId: null }}
        canUpload={false}
        emptyText="Nenhuma etiqueta anexada."
      />,
    );
    expect(screen.getByText('Nenhuma etiqueta anexada.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Anexar etiqueta' })).toBeNull();
  });
});
