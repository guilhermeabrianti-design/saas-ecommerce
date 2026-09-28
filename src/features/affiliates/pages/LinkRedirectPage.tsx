import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Alert } from '@/components/ui/Alert';
import { PageLoader } from '@/components/ui/PageLoader';
import { isSupabaseConfigured } from '@/lib/supabase';
import { rememberAttribution, targetPath } from '../affiliates';
import { fetchLinkTarget, recordVisit } from '../api';

/** /r/<código>: conta o acesso, guarda a origem e segue para o produto ou a vitrine. */
export function LinkRedirectPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'not_found' | 'error'>('loading');

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    fetchLinkTarget(code)
      .then(async (target) => {
        if (cancelled) return;
        if (!target) {
          setState('not_found');
          return;
        }
        const attribution = { store_code: target.store_code, link_code: target.link_code };
        rememberAttribution(attribution);
        await recordVisit(attribution);
        if (!cancelled) void navigate(targetPath(target), { replace: true });
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [code, navigate]);

  if (!isSupabaseConfigured) return <Alert tone="info">Loja não configurada neste ambiente.</Alert>;
  if (state === 'not_found') {
    return <Alert tone="info">Este link não está mais ativo. Confira com quem o enviou.</Alert>;
  }
  if (state === 'error') {
    return <Alert tone="error">Não foi possível abrir o link. Tente de novo.</Alert>;
  }
  return <PageLoader />;
}
