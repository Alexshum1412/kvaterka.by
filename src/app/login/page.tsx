import { Suspense } from 'react';
import type { Metadata } from 'next';
import { LoginForm } from '@/ui/login-form.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Вход',
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <div className="container" style={{ paddingBlock: '3rem', maxWidth: '26rem' }}>
      <Suspense fallback={<div className="skeleton" style={{ height: '20rem' }} />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
