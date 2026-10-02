import { z } from 'zod';
import {
  AlertTriangle,
  Banknote,
  Bell,
  Gift,
  Medal,
  PackageCheck,
  PackageX,
  ReceiptText,
  ShieldCheck,
  Tag,
  Truck,
  Trophy,
  type LucideIcon,
} from 'lucide-react';

export const notificationSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid().nullable(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  read_at: z.string().nullable(),
  created_at: z.string(),
  organizations: z.object({ name: z.string() }).nullable().optional(),
});

export type Notification = z.infer<typeof notificationSchema>;

export type Tone = 'danger' | 'warning' | 'success' | 'info';

interface KindStyle {
  icon: LucideIcon;
  tone: Tone;
}

/** Ícone e cor por tipo (tipo desconhecido: sino neutro). */
const styles: Record<string, KindStyle> = {
  'stock.out': { icon: PackageX, tone: 'danger' },
  'stock.low': { icon: AlertTriangle, tone: 'warning' },
  'stock.back': { icon: PackageCheck, tone: 'success' },
  'listing.price': { icon: Tag, tone: 'warning' },
  'listing.unavailable': { icon: PackageX, tone: 'danger' },
  'listing.available': { icon: PackageCheck, tone: 'success' },
  'listing.moderation': { icon: ShieldCheck, tone: 'info' },
  'supplier.review': { icon: ShieldCheck, tone: 'info' },
  'supplier_order.new': { icon: ReceiptText, tone: 'info' },
  'supplier_order.cancelled': { icon: PackageX, tone: 'danger' },
  'order.supplier_shipped': { icon: Truck, tone: 'success' },
  'marketplace.order': { icon: ReceiptText, tone: 'info' },
  'checkout.paid': { icon: Banknote, tone: 'success' },
  'checkout.reversed': { icon: Banknote, tone: 'danger' },
  'wallet.withdrawal': { icon: Banknote, tone: 'info' },
  'referral.new': { icon: Gift, tone: 'info' },
  'referral.rewarded': { icon: Gift, tone: 'success' },
  'gamification.level': { icon: Trophy, tone: 'success' },
  'gamification.achievement': { icon: Medal, tone: 'success' },
  'staff.supplier_review': { icon: ShieldCheck, tone: 'warning' },
  'staff.withdrawal_requested': { icon: Banknote, tone: 'warning' },
  'staff.refund_needed': { icon: AlertTriangle, tone: 'danger' },
};

export const kindStyle = (kind: string): KindStyle => styles[kind] ?? { icon: Bell, tone: 'info' };

export const toneClass: Record<Tone, string> = {
  danger: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning',
  success: 'bg-success/10 text-success',
  info: 'bg-brand/10 text-brand',
};

/** "agora", "há 5 min", "há 3 h", "ontem", depois a data. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  if (hours < 48) return 'ontem';
  return new Date(iso).toLocaleDateString('pt-BR');
}

/** Contagem para o selo do sino. */
export const badgeText = (count: number) => (count > 99 ? '99+' : String(count));

/** Link interno seguro (o banco já restringe; aqui evita navegar para fora por engano). */
export const safeLink = (link: string | null) =>
  link && /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(link) ? link : null;
