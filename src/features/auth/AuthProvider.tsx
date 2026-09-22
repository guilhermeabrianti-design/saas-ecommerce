import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context';

interface AuthState {
  status: AuthStatus;
  session: Session | null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>(() => ({
    status: supabase ? 'loading' : 'unconfigured',
    session: null,
  }));
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    // Fires INITIAL_SESSION once supabase-js has restored the stored session
    // (and exchanged any PKCE `?code=` from e-mail links), then every change.
    // The callback must stay synchronous: awaiting Supabase calls here deadlocks auth-js.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user.id ?? null;
      if (userIdRef.current !== null && userIdRef.current !== nextUserId) {
        // Signed out or switched account: drop every cached query of the previous user.
        queryClient.clear();
      }
      userIdRef.current = nextUserId;
      setState({ status: session ? 'authenticated' : 'unauthenticated', session });
    });
    return () => subscription.unsubscribe();
  }, [queryClient]);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    // `local` ends this device's session even if the network call fails.
    await supabase.auth.signOut({ scope: 'local' });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: state.status,
      session: state.session,
      user: state.session?.user ?? null,
      signOut,
    }),
    [state, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
