import type {Metadata} from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'PontoExtract - Extrator de Cartão de Ponto',
  description: 'Simplifique a extração de dados de cartões de ponto.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="pt-BR">
      <body className={`${inter.className} bg-slate-50 text-slate-900 min-h-screen`} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
