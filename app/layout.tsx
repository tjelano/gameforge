import type { Metadata } from 'next';
import { IBM_Plex_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';
import { NavRail } from '@/app/components/NavRail';
import { CopilotPanel } from '@/app/components/CopilotPanel';

const sentient = localFont({
  src: '../public/fonts/Sentient-Variable.woff2',
  variable: '--font-sentient',
  display: 'swap',
});

const satoshi = localFont({
  src: '../public/fonts/Satoshi-Variable.woff2',
  variable: '--font-satoshi',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-plex-mono',
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  title: 'GameForge',
  description: 'Local-first game asset pipeline',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sentient.variable} ${satoshi.variable} ${plexMono.variable}`}>
      <body>
        <div className="shell">
          <NavRail />
          <main className="main">{children}</main>
          <CopilotPanel />
        </div>
      </body>
    </html>
  );
}
